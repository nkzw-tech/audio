/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import { DecodedAudioCache } from './DecodedAudio.ts';
import type { Audio, AudioOptions, AudioOutput, SoundOptions, Vector } from './index.ts';
import { PlaybackSound } from './PlaybackSound.ts';
import { setVector } from './SpatialAudio.ts';

const IdleTime = 30_000;
const ActivationEvents = ['click', 'keydown', 'touchend'] as const;

const Codecs: Readonly<Record<string, ReadonlyArray<string>>> = {
  aac: ['audio/aac'],
  caf: ['audio/x-caf'],
  dolby: ['audio/mp4; codecs="ec-3"'],
  flac: ['audio/flac', 'audio/x-flac'],
  m4a: ['audio/x-m4a', 'audio/m4a', 'audio/aac'],
  m4b: ['audio/x-m4b', 'audio/m4b', 'audio/aac'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  mp4: ['audio/x-mp4', 'audio/mp4', 'audio/aac'],
  mpeg: ['audio/mpeg'],
  oga: ['audio/ogg; codecs="vorbis"'],
  ogg: ['audio/ogg; codecs="vorbis"'],
  opus: ['audio/ogg; codecs="opus"'],
  wav: ['audio/wav; codecs="1"', 'audio/wav'],
  weba: ['audio/webm; codecs="vorbis"'],
  webm: ['audio/webm; codecs="vorbis"'],
};

type Orientation = [number, number, number, number, number, number];

export class AudioMixer implements Audio {
  readonly #lifetime = new AbortController();
  readonly #sounds = new Set<PlaybackSound>();
  readonly #waiting = new Set<() => void>();
  readonly buffers = new DecodedAudioCache();
  readonly #mediaPool: Array<HTMLAudioElement> = [];
  readonly #reusableMedia = new WeakSet<HTMLAudioElement>();
  readonly #codecSupport = new Map<string, boolean>();
  readonly #autoSuspend: boolean;
  readonly #poolSize: number;
  #codecProbe: HTMLAudioElement | undefined;
  #counter = 1000;
  #output: AudioOutput | null = null;
  #initialized = false;
  #volume = 1;
  #muted = false;
  #position: Vector = [0, 0, 0];
  #orientation: Orientation = [0, 0, -1, 0, 1, 0];
  #activated = false;
  #mediaUsed = false;
  #mediaPrepared = false;
  #leases = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #suspending = false;
  #resumeRequested = false;
  #resumeAfterSuspend = false;
  #resumeAttempt: { active: boolean } | undefined;
  #disposing: Promise<void> | undefined;

  constructor({ autoSuspend = true, html5PoolSize = 10 }: AudioOptions = {}) {
    this.#autoSuspend = autoSuspend;
    this.#poolSize = html5PoolSize;
  }

  get muted() {
    return this.#muted;
  }

  get canUseMedia() {
    return typeof globalThis.Audio === 'function';
  }

  sound(options: SoundOptions) {
    if (this.#lifetime.signal.aborted) {
      throw new Error('The audio instance has been disposed.');
    }
    if (!options.src?.length) {
      throw new TypeError('At least one sound source is required.');
    }

    const sound = new PlaybackSound(this, options);
    this.#sounds.add(sound);
    if (options.preload !== false) {
      sound.load();
    }
    if (options.autoplay) {
      sound.play();
    }
    return sound;
  }

  getOutput(): AudioOutput | null {
    if (!this.#initialized && !this.#lifetime.signal.aborted) {
      this.#initialized = true;
      this.#listenForActivation();
      try {
        const context = typeof globalThis.AudioContext === 'function' ? new AudioContext() : null;
        if (context) {
          const destination = context.createGain();
          destination.gain.value = this.#muted ? 0 : this.#volume;
          destination.connect(context.destination);
          this.#output = {
            context,
            destination,
            retain: this.#retain,
            signal: this.#lifetime.signal,
          };
          context.addEventListener('statechange', this.#onStateChange, {
            signal: this.#lifetime.signal,
          });
          this.#applyPosition();
          this.#applyOrientation();
          this.idle();
        }
      } catch {
        this.#output = null;
      }
    }
    return this.#output;
  }

  volume(): number;
  volume(value: number): void;
  volume(value?: number) {
    if (value === undefined) {
      return this.#volume;
    }
    if (value >= 0 && value <= 1) {
      this.#volume = value;
      this.#updateVolume();
    }
  }

  mute(muted: boolean) {
    this.#muted = muted;
    this.#updateVolume();
  }

  #updateVolume() {
    const output = this.getOutput();
    output?.destination.gain.setValueAtTime(
      this.#muted ? 0 : this.#volume,
      output.context.currentTime,
    );
    for (const sound of this.#sounds) {
      sound.updateMediaVolume();
    }
  }

  codecs(extension: string) {
    const name = extension.replace(/^x-/, '').toLowerCase();
    const cached = this.#codecSupport.get(name);
    if (cached !== undefined) {
      return cached;
    }

    try {
      this.#codecProbe ??= new globalThis.Audio();
      const supported = Boolean(Codecs[name]?.some((mime) => this.#codecProbe?.canPlayType(mime)));
      this.#codecSupport.set(name, supported);
      return supported;
    } catch {
      return false;
    }
  }

  pos(): Vector;
  pos(x: number, y?: number, z?: number): void;
  pos(x?: number, y = this.#position[1], z = this.#position[2]) {
    if (x === undefined) {
      return [...this.#position] as Vector;
    }
    this.#position = [x, y, z];
    this.#applyPosition();
  }

  #applyPosition() {
    const context = this.#output?.context;
    if (context) {
      const { listener } = context;
      const { positionX, positionY, positionZ } = listener;
      if (positionX) {
        setVector([positionX, positionY, positionZ], this.#position, context.currentTime, 0.1);
      } else {
        listener.setPosition(...this.#position);
      }
    }
  }

  orientation(): Orientation;
  orientation(x: number, y: number, z: number, upX: number, upY: number, upZ: number): void;
  orientation(
    x?: number,
    y = this.#orientation[1],
    z = this.#orientation[2],
    upX = this.#orientation[3],
    upY = this.#orientation[4],
    upZ = this.#orientation[5],
  ) {
    if (x === undefined) {
      return [...this.#orientation] as Orientation;
    }
    this.#orientation = [x, y, z, upX, upY, upZ];
    this.#applyOrientation();
  }

  #applyOrientation() {
    const context = this.#output?.context;
    if (context) {
      const { listener } = context;
      const { forwardX, forwardY, forwardZ, upX, upY, upZ } = listener;
      if (forwardX) {
        const [x, y, z, a, b, c] = this.#orientation;
        setVector([forwardX, forwardY, forwardZ], [x, y, z], context.currentTime, 0.1);
        setVector([upX, upY, upZ], [a, b, c], context.currentTime, 0.1);
      } else {
        listener.setOrientation(...this.#orientation);
      }
    }
  }

  stereo(pan: number) {
    for (const sound of this.#sounds) {
      sound.stereo(pan);
    }
  }

  stop() {
    for (const sound of this.#sounds) {
      sound.stop();
    }
  }

  dispose() {
    if (!this.#disposing) {
      const context = this.#output?.context;
      this.#disposing = Promise.resolve().then(() => {
        if (context && context.state !== 'closed') {
          return context.close();
        }
      });
      this.#lifetime.abort();
      clearTimeout(this.#idle);
      this.#waiting.clear();
      for (const sound of this.#sounds) {
        sound.unload();
      }
      this.#mediaPool.length = 0;
      this.#codecProbe = undefined;
      this.#output = null;
    }
    return this.#disposing;
  }

  detach(sound: PlaybackSound) {
    this.#sounds.delete(sound);
    this.idle();
  }

  nextId() {
    return ++this.#counter;
  }

  takeMedia() {
    this.#mediaUsed = true;
    const media = this.#mediaPool.pop() ?? new globalThis.Audio();
    if (globalThis.navigator?.userActivation?.isActive) {
      this.#prepareMedia();
    }
    return media;
  }

  prepareMedia(media: HTMLAudioElement) {
    if (!this.#reusableMedia.has(media)) {
      media.load();
      this.#reusableMedia.add(media);
    }
  }

  #prepareMedia() {
    if (this.#mediaUsed && !this.#mediaPrepared) {
      this.#mediaPrepared = true;
      for (const sound of this.#sounds) {
        sound.prepareMedia();
      }
      while (this.#mediaPool.length < this.#poolSize) {
        const media = new globalThis.Audio();
        this.#reusableMedia.add(media);
        this.#mediaPool.push(media);
      }
    }
  }

  markMediaPlayed(media: HTMLAudioElement) {
    this.#reusableMedia.add(media);
  }

  releaseMedia(media: HTMLAudioElement) {
    if (
      !this.#lifetime.signal.aborted &&
      this.#reusableMedia.has(media) &&
      this.#mediaPool.length < this.#poolSize
    ) {
      this.#mediaPool.push(media);
    }
  }

  whenRunning(start: () => void) {
    clearTimeout(this.#idle);
    if (this.#output?.context.state === 'running' && !this.#suspending) {
      start();
    } else {
      this.#waiting.add(start);
      this.#resume();
    }
    return () => {
      this.#waiting.delete(start);
      this.idle();
    };
  }

  idle() {
    const context = this.#output?.context;
    if (
      !this.#autoSuspend ||
      !context ||
      this.#lifetime.signal.aborted ||
      this.#leases ||
      this.#waiting.size ||
      this.#hasPlayingSound()
    ) {
      return;
    }

    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (context.state === 'running') {
        this.#suspending = true;
        this.#resumeRequested = false;
        this.#resumeAfterSuspend = false;
        void context.suspend().then(this.#finishSuspend, this.#finishSuspend);
      }
    }, IdleTime);
  }

  #hasPlayingSound() {
    for (const sound of this.#sounds) {
      if (sound.usesWebAudio && sound.playing()) {
        return true;
      }
    }
    return false;
  }

  #finishSuspend = () => {
    this.#suspending = false;
    if (this.#resumeRequested) {
      this.#resume(this.#resumeAfterSuspend);
    }
  };

  #retain = () => {
    this.#lifetime.signal.throwIfAborted();
    this.#leases++;
    this.#resume();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#leases--;
        this.idle();
      }
    };
  };

  #listenForActivation() {
    for (const event of ActivationEvents) {
      globalThis.document?.addEventListener(event, this.#onActivation, {
        capture: true,
        signal: this.#lifetime.signal,
      });
    }
  }

  #onActivation = (event: Event) => {
    if (event.isTrusted && globalThis.navigator?.userActivation?.isActive !== false) {
      this.#prepareMedia();
      const context = this.#output?.context;
      if (context && (context.state !== 'running' || this.#suspending)) {
        this.#resume(true);
      } else {
        this.#notifyActivation();
      }
    }
  };

  #notifyActivation() {
    if (!this.#activated) {
      this.#activated = true;
      for (const sound of this.#sounds) {
        sound.notifyUnlock();
      }
    }
  }

  #onStateChange = () => {
    const context = this.#output?.context;
    if (context?.state === 'running' && !this.#suspending) {
      if (this.#resumeAttempt?.active) {
        this.#notifyActivation();
      }
      for (const start of this.#waiting) {
        this.#waiting.delete(start);
        start();
      }
      this.idle();
    }
  };

  #resume(active = globalThis.navigator?.userActivation?.isActive === true) {
    clearTimeout(this.#idle);
    const context = this.#output?.context;
    if (!context || this.#lifetime.signal.aborted || context.state === 'closed') {
      return;
    }
    if (this.#suspending) {
      this.#resumeRequested = true;
      this.#resumeAfterSuspend ||= active;
    } else if (context.state === 'running') {
      this.#onStateChange();
      return;
    }
    if (this.#resumeAttempt && (!active || this.#resumeAttempt.active)) {
      return;
    }

    const attempt = { active };
    this.#resumeAttempt = attempt;
    const finish = () => {
      if (this.#resumeAttempt === attempt) {
        this.#onStateChange();
        this.#resumeAttempt = undefined;
      }
    };
    void context.resume().then(finish, finish);
  }
}

/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { AudioMixer } from './AudioMixer.ts';
import { AudioNetworkError, type BufferLease } from './DecodedAudio.ts';
import type {
  AudioOutput,
  Sound,
  SoundEvent,
  SoundListener,
  SoundOptions,
  Vector,
} from './index.ts';
import { PlaybackVoice, type Region, type VoiceOptions } from './PlaybackVoice.ts';
import type { SpatialState } from './SpatialAudio.ts';

const Events = [
  'end',
  'fade',
  'load',
  'loaderror',
  'mute',
  'orientation',
  'pause',
  'play',
  'playerror',
  'pos',
  'rate',
  'seek',
  'stereo',
  'stop',
  'unlock',
  'volume',
] as const satisfies ReadonlyArray<SoundEvent>;

type Subscription = { id?: number; listener: SoundListener; once: boolean };

export class PlaybackSound implements Sound {
  readonly #voices: Array<PlaybackVoice> = [];
  readonly #events = new Map<SoundEvent, Array<Subscription>>();
  readonly #deferredFades: Array<() => void> = [];
  readonly #options: Pick<SoundOptions, 'format' | 'pool' | 'preload' | 'sprite' | 'src' | 'xhr'>;
  #output: AudioOutput | null;
  #bufferLease: BufferLease | undefined;
  #src: string | undefined;
  #duration = 0;
  #state: 'loaded' | 'loading' | 'unloaded' = 'unloaded';
  #disposed = false;
  #loop: boolean;
  #muted: boolean;
  #rate: number;
  #spatial: SpatialState;
  #volume: number;

  constructor(
    private readonly mixer: AudioMixer,
    options: SoundOptions,
  ) {
    const { format, pool, preload, sprite, src, xhr } = options;
    this.#options = { format, pool, preload, sprite, src, xhr };
    const output = mixer.getOutput();
    this.#output = options.html5 ? null : output;
    this.#loop = options.loop ?? false;
    this.#muted = options.mute ?? false;
    this.#rate = options.rate || 1;
    this.#volume = options.volume ?? 1;
    this.#spatial = {
      attributes: {
        coneInnerAngle: options.coneInnerAngle ?? 360,
        coneOuterAngle: options.coneOuterAngle ?? 360,
        coneOuterGain: options.coneOuterGain ?? 0,
        distanceModel: options.distanceModel ?? 'inverse',
        maxDistance: options.maxDistance ?? 10_000,
        panningModel: options.panningModel ?? 'HRTF',
        refDistance: options.refDistance ?? 1,
        rolloffFactor: options.rolloffFactor ?? 1,
      },
      orientation: options.orientation ?? [1, 0, 0],
      pan: options.stereo ?? null,
      position: options.pos ?? null,
    };

    for (const event of Events) {
      const listener = options[`on${event}`];
      if (listener) {
        this.on(event, listener);
      }
    }
  }

  get usesWebAudio() {
    return this.#output !== null;
  }

  #voiceOptions(): VoiceOptions {
    return {
      loop: this.#loop,
      muted: this.#muted,
      rate: this.#rate,
      spatial: this.#spatial,
      volume: this.#volume,
    };
  }

  #find(id: number | undefined) {
    return this.#voices.find((voice) => voice.id === id);
  }

  #select(id: number | undefined) {
    if (id === undefined) {
      return this.#voices;
    }
    const voice = this.#find(id);
    return voice ? [voice] : [];
  }

  #createVoice() {
    const voice = new PlaybackVoice(this.mixer, this.#voiceOptions());
    this.#voices.push(voice);
    this.#connectVoice(voice);
    return voice;
  }

  #connectVoice(voice: PlaybackVoice) {
    if (this.#output) {
      voice.connectWebAudio(this.#output);
    } else if (this.#src && this.mixer.canUseMedia) {
      const preload = this.#options.preload;
      voice.connectMedia(
        this.#src,
        preload === false ? 'none' : preload === 'metadata' ? preload : 'auto',
        {
          end: () => this.#end(voice),
          error: (error) => {
            if (this.#state === 'loading') {
              this.#loadFailed(error, voice.id);
            }
          },
          load: (duration) => {
            if (!Number.isNaN(duration)) {
              this.#loaded(duration);
            }
          },
        },
      );
    }
  }

  #takeVoice() {
    const poolSize = this.#options.pool || 5;
    const inactive = this.#voices.filter(({ state }) => state === 'ended');
    for (const voice of inactive.slice(Math.max(1, poolSize))) {
      voice.disconnect();
      this.#voices.splice(this.#voices.indexOf(voice), 1);
    }
    return inactive[0]?.reset(this.#voiceOptions()) ?? this.#createVoice();
  }

  load() {
    if (this.#disposed || this.#state !== 'unloaded') {
      return this;
    }
    if (!this.#output && !this.mixer.canUseMedia) {
      this.#loadFailed('No audio support.');
      return this;
    }
    const { format, src } = this.#options;
    const sources = typeof src === 'string' ? [src] : src;
    const formats = typeof format === 'string' ? [format] : format;
    const url = sources.find((source, index) => {
      const extension =
        formats?.[index] ??
        /^data:audio\/([^;,]+)/i.exec(source)?.[1] ??
        /\.([^./]+)$/.exec(source.split(/[?#]/, 1)[0])?.[1];
      return extension !== undefined && this.mixer.codecs(extension);
    });
    if (!url) {
      this.#loadFailed('No codec support for selected audio sources.');
      return this;
    }

    this.#src = url;
    this.#state = 'loading';
    if (this.#output && globalThis.location?.protocol === 'https:' && url.startsWith('http:')) {
      this.#output = null;
    }
    if (this.#voices.length === 0) {
      this.#createVoice();
    } else {
      for (const voice of this.#voices) {
        if (voice.media) {
          voice.media.load();
        } else {
          this.#connectVoice(voice);
        }
      }
    }
    if (this.#output) {
      const lease = this.mixer.buffers.acquire(this.#output.context, url, this.#options.xhr);
      this.#bufferLease = lease;
      if (lease.buffer) {
        this.#loaded(lease.buffer.duration);
      } else {
        void lease.decoded.then(
          (buffer) => {
            if (this.#bufferLease === lease) {
              this.#loaded(buffer.duration);
            }
          },
          (error: unknown) => {
            if (this.#bufferLease !== lease) {
              return;
            }
            this.#bufferLease = undefined;
            lease.release();
            if (AudioNetworkError.matches(error) && this.mixer.canUseMedia) {
              this.#output = null;
              for (const voice of this.#voices) {
                voice.disconnect();
                this.#connectVoice(voice);
              }
              this.#startQueuedVoices();
            } else {
              this.#loadFailed(error);
            }
          },
        );
      }
    }
    return this;
  }

  #loadFailed(error: unknown, id: number | null = null) {
    this.#state = 'unloaded';
    for (const voice of this.#voices) {
      if (voice.state === 'queued') {
        voice.stop();
      }
    }
    this.#emit('loaderror', id, error);
  }

  #loaded(duration: number) {
    if (!this.#disposed) {
      this.#duration = duration;
      if (this.#state === 'loading') {
        this.#state = 'loaded';
        this.#emit('load');
        for (const fade of this.#deferredFades.splice(0)) {
          fade();
        }
        this.#startQueuedVoices();
      }
    }
  }

  #startQueuedVoices() {
    for (const voice of this.#voices) {
      if (voice.state === 'queued' && !voice.cancelStart && !voice.startingMedia) {
        this.#start(voice);
      }
    }
  }

  play(spriteOrId?: string | number) {
    if (this.#disposed) {
      return null;
    }
    if (
      typeof spriteOrId === 'string' &&
      spriteOrId !== '__default' &&
      !Object.hasOwn(this.#options.sprite ?? {}, spriteOrId)
    ) {
      return null;
    }
    if (this.#state === 'unloaded') {
      this.load();
    }

    let voice: PlaybackVoice | undefined;
    if (typeof spriteOrId === 'number') {
      voice = this.#find(spriteOrId);
      if (!voice) {
        return null;
      }
    } else if (spriteOrId === undefined) {
      const paused = this.#voices.filter(({ state }) => state === 'paused');
      if (paused.length === 1) {
        voice = paused[0];
      }
    }
    if (!voice) {
      voice = this.#takeVoice();
      voice.sprite = typeof spriteOrId === 'string' ? spriteOrId : '__default';
      voice.offset = this.#region(voice).start;
    }
    if (this.#state === 'unloaded') {
      return null;
    }
    if (voice.state !== 'playing' && voice.state !== 'queued') {
      voice.state = 'queued';
      this.#start(voice);
    }
    return voice.id;
  }

  #region(voice: PlaybackVoice): Region {
    const sprite = this.#options.sprite?.[voice.sprite];
    if (sprite) {
      const [start, duration, loop] = sprite;
      return {
        end: (start + duration) / 1000,
        loop: voice.loop || Boolean(loop),
        start: start / 1000,
      };
    }
    return { end: this.#duration || Infinity, loop: voice.loop, start: 0 };
  }

  #start(voice: PlaybackVoice, internal = false) {
    const src = this.#src;
    if (!src || this.#disposed) {
      return;
    }

    const region = this.#region(voice);
    const offset = Math.max(region.start, voice.offset);
    voice.region = region;
    if (offset >= region.end) {
      this.#end(voice);
      return;
    }
    const id = voice.id;
    const started = () => {
      if (!internal && !this.#disposed && voice.id === id) {
        this.#emit('play', id);
      }
    };
    const ended = () => this.#end(voice);
    if (voice.media) {
      void voice.startMedia(src, region, offset, started, ended, (error) =>
        this.#emit('playerror', voice.id, error),
      );
    } else if (this.#state === 'loaded' && this.#bufferLease?.buffer) {
      const buffer = this.#bufferLease.buffer;
      const cancel = this.mixer.whenRunning(() => {
        voice.cancelStart = undefined;
        if (!this.#disposed && voice.state === 'queued') {
          try {
            voice.startWebAudio(buffer, region, offset, ended);
            queueMicrotask(started);
          } catch (error) {
            voice.finishWebAudio();
            this.mixer.idle();
            this.#emit('playerror', voice.id, error);
          }
        }
      });
      if (voice.state === 'queued') {
        voice.cancelStart = cancel;
      }
    }
  }

  #end(voice: PlaybackVoice) {
    if (this.#disposed || voice.state === 'ended' || voice.state === 'paused') {
      return;
    }

    this.#emit('end', voice.id);
    if (voice.output && voice.region.loop && voice.state === 'playing') {
      this.#emit('play', voice.id);
    } else if (voice.media && voice.region.loop && voice.state === 'playing') {
      voice.stop();
      voice.state = 'queued';
      this.#start(voice);
    } else {
      if (voice.output) {
        voice.finishWebAudio();
      } else {
        voice.stop();
      }
      this.mixer.idle();
    }
  }

  pause(id?: number) {
    if (!this.#disposed) {
      for (const voice of this.#select(id)) {
        if (voice.state !== 'ended') {
          voice.pause();
        }
        this.#emit('pause', voice.id);
      }
      this.mixer.idle();
    }
    return this;
  }

  stop(id?: number) {
    if (!this.#disposed) {
      for (const voice of this.#select(id)) {
        voice.stop();
        this.#emit('stop', voice.id);
      }
      this.mixer.idle();
    }
    return this;
  }

  playing(id?: number) {
    return this.#select(id).some(({ state }) => state === 'playing');
  }

  duration(id?: number) {
    const voice = this.#find(id);
    const sprite = voice && this.#options.sprite?.[voice.sprite];
    return sprite ? sprite[1] / 1000 : this.#duration;
  }

  state() {
    return this.#state;
  }

  position(id?: number) {
    return (id === undefined ? this.#voices[0] : this.#find(id))?.position() ?? 0;
  }

  seek(): number;
  seek(valueOrId: number): number | Sound;
  seek(value: number, id: number): this;
  seek(value?: number, id?: number) {
    if (value === undefined) {
      return this.position();
    }
    if (id === undefined && this.#find(value)) {
      return this.position(value);
    }
    if (!this.#disposed && Number.isFinite(value) && value >= 0) {
      const voice = id === undefined ? (this.#voices[0] ?? this.#createVoice()) : this.#find(id);
      if (voice) {
        const restart = voice.state === 'playing' || voice.state === 'queued';
        voice.pause();
        voice.offset = value;
        if (restart) {
          voice.state = 'queued';
          this.#start(voice, true);
        }
        this.#emit('seek', voice.id);
      }
    }
    return this;
  }

  loop(): boolean;
  loop(id: number): boolean;
  loop(value: boolean, id?: number): this;
  loop(value?: boolean | number, id?: number) {
    if (value === undefined) {
      return this.#loop;
    }
    if (typeof value === 'number') {
      return this.#find(value)?.loop ?? false;
    }
    if (id === undefined) {
      this.#loop = value;
    }
    for (const voice of this.#select(id)) {
      voice.loop = value;
      if (voice.state === 'playing') {
        voice.pause();
        voice.state = 'queued';
        this.#start(voice, true);
      }
    }
    return this;
  }

  rate(): number;
  rate(valueOrId: number): number | Sound;
  rate(value: number, id: number): this;
  rate(value?: number, id?: number) {
    if (value === undefined) {
      return this.#voices[0]?.rate ?? this.#rate;
    }
    if (id === undefined) {
      const voice = this.#find(value);
      if (voice) {
        return voice.rate;
      }
      if (Number.isFinite(value)) {
        this.#rate = value;
      }
    }
    if (!this.#disposed && Number.isFinite(value)) {
      for (const voice of this.#select(id)) {
        try {
          voice.changeRate(value, () => this.#end(voice));
          this.#emit('rate', voice.id);
        } catch (error) {
          this.#emit('playerror', voice.id, error);
        }
      }
    }
    return this;
  }

  volume(): number;
  volume(valueOrId: number): number | Sound;
  volume(value: number, id: number): this;
  volume(value?: number, id?: number) {
    if (value === undefined) {
      return this.#volume;
    }
    const voice = id === undefined ? this.#find(value) : undefined;
    if (voice) {
      return voice.volume;
    }
    if (value >= 0 && value <= 1) {
      if (id === undefined) {
        this.#volume = value;
      }
      for (const selected of this.#select(id)) {
        selected.cancelFade();
        selected.volume = value;
        selected.applyVolume();
        this.#emit('volume', selected.id);
      }
    }
    return this;
  }

  mute(muted: boolean, id?: number) {
    if (id === undefined) {
      this.#muted = muted;
    }
    for (const voice of this.#select(id)) {
      voice.cancelFade();
      voice.muted = muted;
      voice.applyVolume();
      this.#emit('mute', voice.id);
    }
    return this;
  }

  fade(from: number, to: number, duration: number, id?: number) {
    if (this.#disposed) {
      return this;
    }
    if (this.#state !== 'loaded') {
      this.#deferredFades.push(() => this.fade(from, to, duration, id));
      return this;
    }

    const initial = Math.min(1, Math.max(0, from));
    const target = Math.min(1, Math.max(0, to));
    if (!Number.isFinite(initial) || !Number.isFinite(target) || !Number.isFinite(duration)) {
      return this;
    }
    if (id === undefined) {
      this.#volume = initial;
    }
    for (const voice of this.#select(id)) {
      voice.fade(initial, target, Math.max(0, duration), (volume, complete) => {
        if (id === undefined) {
          this.#volume = volume;
        }
        if (complete) {
          this.#emit('fade', voice.id);
        }
      });
    }
    return this;
  }

  stereo(): Sound | number | null;
  stereo(pan: number, id?: number): this;
  stereo(pan?: number, id?: number) {
    if (!this.#output) {
      return this;
    }
    if (pan === undefined) {
      return this.#spatial.pan;
    }
    const value = Math.min(1, Math.max(-1, pan));
    this.#updateSpatial('stereo', id, () => ({ pan: value, position: [value, 0, 0] }));
    return this;
  }

  pos(): Sound | Vector | null;
  pos(x: number, y?: number, z?: number, id?: number): this;
  pos(x?: number, y = 0, z = -0.5, id?: number) {
    if (!this.#output) {
      return this;
    }
    if (x === undefined) {
      return this.#spatial.position;
    }
    this.#updateSpatial('pos', id, () => ({ pan: null, position: [x, y, z] }));
    return this;
  }

  orientation(): Sound | Vector;
  orientation(x: number, y?: number, z?: number, id?: number): this;
  orientation(
    x?: number,
    y = this.#spatial.orientation[1],
    z = this.#spatial.orientation[2],
    id?: number,
  ) {
    if (!this.#output) {
      return this;
    }
    if (x === undefined) {
      return this.#spatial.orientation;
    }
    this.#updateSpatial('orientation', id, (current) => ({
      orientation: [x, y, z],
      pan: null,
      position: current.position ?? [0, 0, -0.5],
    }));
    return this;
  }

  pannerAttr(): PannerOptions;
  pannerAttr(id: number): PannerOptions;
  pannerAttr(options: PannerOptions, id?: number): this;
  pannerAttr(options?: PannerOptions | number, id?: number) {
    if (options === undefined || typeof options === 'number') {
      return { ...(this.#find(options)?.spatial.attributes ?? this.#spatial.attributes) };
    }
    if (this.#output) {
      this.#updateSpatial(null, id, (current) => ({
        attributes: { ...current.attributes, ...options },
        pan: null,
        position: current.position ?? [0, 0, -0.5],
      }));
    }
    return this;
  }

  #updateSpatial(
    event: 'orientation' | 'pos' | 'stereo' | null,
    id: number | undefined,
    change: (state: SpatialState) => Partial<SpatialState>,
  ) {
    if (id === undefined) {
      this.#spatial = { ...this.#spatial, ...change(this.#spatial) };
    }
    for (const voice of this.#select(id)) {
      voice.spatial = { ...voice.spatial, ...change(voice.spatial) };
      voice.applySpatial();
      if (event) {
        this.#emit(event, voice.id);
      }
    }
  }

  on(event: SoundEvent, listener: SoundListener, id?: number) {
    return this.#subscribe(event, { id, listener, once: false });
  }

  once(event: SoundEvent, listener: SoundListener, id?: number) {
    return this.#subscribe(event, { id, listener, once: true });
  }

  #subscribe(event: SoundEvent, subscription: Subscription) {
    if (!this.#disposed) {
      const listeners = this.#events.get(event);
      if (listeners) {
        listeners.push(subscription);
      } else {
        this.#events.set(event, [subscription]);
      }
    }
    return this;
  }

  off(event?: SoundEvent, listener?: SoundListener | number, id?: number) {
    if (!event) {
      this.#events.clear();
    } else if (listener === undefined && id === undefined) {
      this.#events.delete(event);
    } else {
      const target = typeof listener === 'number' ? listener : id;
      const listeners = this.#events.get(event);
      const index = listeners?.findIndex(
        (entry) =>
          entry.id === target && (typeof listener !== 'function' || entry.listener === listener),
      );
      if (index !== undefined && index >= 0) {
        listeners?.splice(index, 1);
      }
    }
    return this;
  }

  #emit(event: SoundEvent, id?: number | null, detail?: unknown) {
    const listeners = this.#events.get(event);
    if (listeners) {
      for (let index = listeners.length - 1; index >= 0; index--) {
        const { id: target, listener, once } = listeners[index];
        if (target === undefined || target === id || event === 'load') {
          if (once) {
            listeners.splice(index, 1);
          }
          setTimeout(() => {
            if (!this.#disposed) {
              listener.call(this, id, detail);
            }
          }, 0);
        }
      }
    }
  }

  notifyUnlock() {
    this.#emit('unlock');
  }

  prepareMedia() {
    for (const voice of this.#voices) {
      if (voice.media && voice.state === 'ended') {
        this.mixer.prepareMedia(voice.media);
      }
    }
  }

  updateMediaVolume() {
    for (const voice of this.#voices) {
      voice.updateMediaVolume();
    }
  }

  unload() {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#state = 'unloaded';
      this.#events.clear();
      this.#deferredFades.length = 0;
      for (const voice of this.#voices) {
        voice.disconnect();
      }
      this.#voices.length = 0;
      this.#bufferLease?.release();
      this.#bufferLease = undefined;
      this.mixer.detach(this);
    }
    return null;
  }
}

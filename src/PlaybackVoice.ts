/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { AudioMixer } from './AudioMixer.ts';
import type { AudioOutput } from './index.ts';
import { SpatialAudio, type SpatialState } from './SpatialAudio.ts';

export type Region = { end: number; loop: boolean; start: number };

type Fade = {
  dispose(): void;
  endTime: number;
  target: number;
  update(volume: number, complete: boolean): void;
};

export type VoiceOptions = {
  loop: boolean;
  muted: boolean;
  rate: number;
  spatial: SpatialState;
  volume: number;
};

type MediaEvents = {
  end(): void;
  error(error: unknown): void;
  load(duration: number): void;
};

export class PlaybackVoice {
  state: 'ended' | 'paused' | 'playing' | 'queued' = 'ended';
  id: number;
  sprite = '__default';
  offset = 0;
  anchor = 0;
  loop: boolean;
  muted: boolean;
  rate: number;
  spatial: SpatialState;
  volume: number;
  region: Region = { end: Infinity, loop: false, start: 0 };
  media: HTMLAudioElement | null = null;
  output: AudioOutput | null = null;
  cancelStart: (() => void) | undefined;
  #source: AudioBufferSourceNode | null = null;
  #gain: GainNode | null = null;
  #panner: SpatialAudio | null = null;
  #mediaEvents: AbortController | undefined;
  #boundary: ReturnType<typeof setTimeout> | undefined;
  #fade: Fade | undefined;
  #playGeneration = 0;
  startingMedia = false;

  constructor(
    private readonly mixer: AudioMixer,
    { loop, muted, rate, spatial, volume }: VoiceOptions,
  ) {
    this.id = mixer.nextId();
    this.loop = loop;
    this.muted = muted;
    this.rate = rate;
    this.spatial = { ...spatial };
    this.volume = volume;
  }

  reset({ loop, muted, rate, spatial, volume }: VoiceOptions) {
    const muteChanged = this.muted !== muted;
    this.id = this.mixer.nextId();
    this.sprite = '__default';
    this.offset = 0;
    this.loop = loop;
    this.muted = muted;
    this.rate = rate;
    this.spatial = { ...spatial };
    const fade = this.#fade;
    if (!fade) {
      this.volume = volume;
      this.applyVolume();
    } else if (muteChanged) {
      const context = this.output?.context;
      const gain = this.#gain?.gain;
      if (context && gain) {
        const now = context.currentTime;
        gain.cancelScheduledValues(now);
        this.applyVolume();
        if (!muted) {
          gain.linearRampToValueAtTime(fade.target, Math.max(now, fade.endTime));
        }
      } else {
        this.applyVolume();
      }
    }
    this.applySpatial();
    return this;
  }

  connectWebAudio(output: AudioOutput) {
    if (!this.#gain) {
      const gain = output.context.createGain();
      gain.connect(output.destination);
      this.output = output;
      this.#gain = gain;
      this.#panner = new SpatialAudio(output.context, gain);
      this.applyVolume();
      this.applySpatial();
    }
  }

  connectMedia(src: string, preload: 'auto' | 'metadata' | 'none', events: MediaEvents) {
    if (!this.media) {
      const media = this.mixer.takeMedia();
      const controller = new AbortController();
      const signal = controller.signal;
      this.#mediaEvents = controller;
      this.media = media;
      media.preload = preload;
      media.addEventListener('loadedmetadata', () => events.load(media.duration), { signal });
      media.addEventListener('durationchange', () => events.load(media.duration), { signal });
      media.addEventListener('error', () => events.error(media.error?.code ?? 0), { signal });
      media.addEventListener('ended', events.end, { signal });
      this.applyVolume();
      this.setMediaSource(src);
    }
  }

  setMediaSource(src: string) {
    if (this.media && this.media.getAttribute('src') !== src) {
      this.media.src = src;
      this.media.load();
    }
  }

  startWebAudio(buffer: AudioBuffer, region: Region, offset: number, ended: () => void) {
    const context = this.output?.context;
    const input = this.#panner?.input;
    if (!context || !input) {
      return;
    }
    this.region = region;
    this.offset = offset;
    this.anchor = context.currentTime;
    this.state = 'playing';
    const source = context.createBufferSource();
    this.#source = source;
    source.buffer = buffer;
    source.loop = region.loop;
    source.loopStart = region.start;
    source.loopEnd = region.end;
    source.playbackRate.value = this.rate;
    source.connect(input);
    source.onended = () => {
      if (this.#source === source) {
        ended();
      }
    };
    if (region.loop) {
      source.start(0, offset);
      this.scheduleBoundary(ended);
    } else {
      source.start(0, offset, region.end - offset);
    }
  }

  async startMedia(
    src: string,
    region: Region,
    offset: number,
    started: () => void,
    ended: () => void,
    failed: (error: unknown) => void,
  ) {
    const media = this.media;
    if (!media) {
      return;
    }

    const generation = ++this.#playGeneration;
    this.startingMedia = true;
    try {
      this.setMediaSource(src);
      this.region = region;
      this.offset = offset;
      this.applyVolume();
      media.playbackRate = this.rate;
      media.currentTime = offset;
      await media.play();
    } catch (error) {
      if (generation === this.#playGeneration) {
        this.startingMedia = false;
        this.state = 'ended';
        failed(error);
      }
      return;
    }
    if (generation === this.#playGeneration) {
      this.startingMedia = false;
      this.state = 'playing';
      this.mixer.markMediaPlayed(media);
      if (this.sprite !== '__default') {
        this.scheduleBoundary(ended);
      }
      started();
    }
  }

  position() {
    if (this.state !== 'playing') {
      return this.offset;
    }
    if (this.media) {
      return this.media.currentTime;
    }
    const elapsed = (this.output?.context.currentTime ?? this.anchor) - this.anchor;
    const position = this.offset + elapsed * Math.abs(this.rate);
    const { end, loop, start } = this.region;
    return loop && position >= end && end > start
      ? start + ((position - start) % (end - start))
      : Math.min(end, position);
  }

  pause() {
    const position = this.position();
    this.cancelStart?.();
    this.cancelStart = undefined;
    this.#playGeneration++;
    this.startingMedia = false;
    this.clearBoundary();
    this.#stopSource();
    this.finishFade();
    this.media?.pause();
    this.offset = position;
    this.state = 'paused';
  }

  stop() {
    this.pause();
    this.offset = this.region.start;
    this.state = 'ended';
    const media = this.media;
    if (media) {
      if (media.duration === Infinity) {
        media.removeAttribute('src');
        media.load();
      } else if (media.readyState > 0) {
        media.currentTime = this.region.start;
      }
    }
  }

  #stopSource() {
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
  }

  finishWebAudio() {
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onended = null;
      source.disconnect();
    }
    this.clearBoundary();
    this.finishFade();
    this.offset = this.region.start;
    this.state = 'ended';
  }

  applyVolume() {
    const volume = this.muted ? 0 : this.volume;
    if (this.#gain && this.output) {
      this.#gain.gain.setValueAtTime(volume, this.output.context.currentTime);
    } else if (this.media) {
      this.updateMediaVolume();
    }
  }

  updateMediaVolume() {
    if (this.media) {
      this.media.muted = this.muted || this.mixer.muted;
      this.media.volume = this.volume * this.mixer.volume();
    }
  }

  applySpatial() {
    this.#panner?.update(this.spatial, this.#source);
  }

  changeRate(rate: number, ended: () => void) {
    if (this.state === 'playing' && this.output) {
      this.offset = this.position();
      this.anchor = this.output.context.currentTime;
    }
    this.rate = rate;
    if (this.#source && this.output) {
      this.#source.playbackRate.setValueAtTime(rate, this.output.context.currentTime);
    } else if (this.media) {
      this.media.playbackRate = rate;
    }
    if (
      this.state === 'playing' &&
      (this.output ? this.region.loop : this.sprite !== '__default')
    ) {
      this.scheduleBoundary(ended);
    }
  }

  scheduleBoundary(ended: () => void) {
    this.clearBoundary();
    const { end, start } = this.region;
    const rate = Math.abs(this.rate);
    if (!Number.isFinite(end) || rate === 0 || end <= start) {
      return;
    }
    const context = this.output?.context;
    if (context) {
      const period = (end - start) / rate;
      let next = context.currentTime + Math.max(0, end - this.position()) / rate;
      const tick = () => {
        if (context.currentTime >= next) {
          next += Math.max(1, Math.floor((context.currentTime - next) / period) + 1) * period;
          ended();
        }
        if (this.state === 'playing') {
          this.#boundary = setTimeout(tick, Math.max(4, (next - context.currentTime) * 1000));
        }
      };
      this.#boundary = setTimeout(tick, Math.max(4, (next - context.currentTime) * 1000));
    } else if (this.media) {
      const media = this.media;
      const tick = () => {
        const remaining = end - media.currentTime;
        if (remaining <= 0 || media.ended) {
          ended();
        } else if (this.state === 'playing') {
          this.#boundary = setTimeout(tick, Math.max(20, (remaining * 1000) / rate));
        }
      };
      this.#boundary = setTimeout(tick, Math.max(4, ((end - media.currentTime) * 1000) / rate));
    }
  }

  clearBoundary() {
    clearTimeout(this.#boundary);
    this.#boundary = undefined;
  }

  fade(
    from: number,
    to: number,
    duration: number,
    update: (volume: number, complete: boolean) => void,
  ) {
    this.cancelFade();
    this.volume = from;
    this.applyVolume();
    if (duration === 0 || from === to) {
      this.volume = to;
      this.applyVolume();
      update(to, true);
      return;
    }
    const context = this.output?.context;
    const clock = () => (context ? context.currentTime * 1000 : performance.now());
    const started = clock();
    const endTime = (started + duration) / 1000;
    if (this.#gain && !this.muted) {
      this.#gain.gain.linearRampToValueAtTime(to, endTime);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const dispose = () => {
      clearInterval(timer);
      controller.abort();
    };
    const tick = () => {
      const progress = Math.min(1, (clock() - started) / duration);
      this.volume = from + (to - from) * progress;
      this.updateMediaVolume();
      if (progress === 1) {
        dispose();
        this.#fade = undefined;
      }
      update(this.volume, progress === 1);
    };
    const schedule = () => {
      clearInterval(timer);
      if (!context || context.state === 'running') {
        timer = setInterval(tick, 10);
      }
    };
    this.#fade = { dispose, endTime, target: to, update };
    context?.addEventListener('statechange', schedule, { signal: controller.signal });
    schedule();
  }

  cancelFade() {
    if (this.#fade) {
      this.#fade.dispose();
      this.#gain?.gain.cancelScheduledValues(this.output?.context.currentTime ?? 0);
      this.#fade = undefined;
    }
  }

  finishFade() {
    const fade = this.#fade;
    if (fade) {
      this.cancelFade();
      this.volume = fade.target;
      this.applyVolume();
      fade.update(fade.target, true);
    }
  }

  disconnect() {
    this.cancelStart?.();
    this.cancelStart = undefined;
    this.#playGeneration++;
    this.startingMedia = false;
    this.cancelFade();
    this.clearBoundary();
    this.#stopSource();
    this.#panner?.dispose();
    this.#gain?.disconnect();
    this.output = null;
    this.#panner = null;
    this.#gain = null;
    this.#mediaEvents?.abort();
    this.#mediaEvents = undefined;
    const media = this.media;
    this.media = null;
    if (media) {
      media.pause();
      media.removeAttribute('src');
      media.load();
      this.mixer.releaseMedia(media);
    }
  }
}

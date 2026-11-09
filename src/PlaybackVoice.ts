/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { AudioMixer } from './AudioMixer.ts';
import type { DecodedAsset } from './DecodedAudio.ts';
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
  load(duration: number, ready: boolean): void;
};

type WebAudioEvents = {
  ended(): void;
  failed(error: unknown): void;
  started(): void;
  underrun(): void;
};

type PreviewPlayback = {
  asset: DecodedAsset;
  boundary: number;
  events: WebAudioEvents;
  lease: ReturnType<NonNullable<DecodedAsset['preview']>['acquire']>;
  opening: boolean;
  reversed?: boolean;
  tail?: { source: AudioBufferSourceNode; when: number };
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
  #preview: PreviewPlayback | undefined;
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

  connectMedia(src: string, preload: 'auto' | 'metadata', events: MediaEvents) {
    if (!this.media) {
      const media = this.mixer.takeMedia();
      const controller = new AbortController();
      const signal = controller.signal;
      this.#mediaEvents = controller;
      this.media = media;
      media.preload = preload;
      const minimumReadyState =
        preload === 'metadata' ? media.HAVE_METADATA : media.HAVE_FUTURE_DATA;
      const update = () => events.load(media.duration, media.readyState >= minimumReadyState);
      for (const event of ['canplay', 'durationchange', 'loadedmetadata']) {
        media.addEventListener(event, update, { signal });
      }
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

  startWebAudio(asset: DecodedAsset, region: Region, offset: number, events: WebAudioEvents) {
    if (!asset.preview || region.end <= asset.preview.duration) {
      this.#startBuffer(asset.buffer, region, offset, events);
      return;
    }

    const boundary = asset.preview.duration;
    const lease = asset.preview.acquire();
    const opening = !lease.buffer && offset < boundary && this.rate > 0;
    const preview: PreviewPlayback = { asset, boundary, events, lease, opening };
    this.#preview = preview;
    if (opening) {
      this.#startBuffer(
        asset.buffer,
        { ...region, end: boundary, loop: false },
        offset,
        {
          ...events,
          ended: () => {
            this.#source?.disconnect();
            this.#source = null;
            if (this.rate < 0 && !this.region.loop && this.offset < boundary) {
              events.ended();
            }
          },
        },
        true,
      );
      this.region = region;
    } else if (!lease.buffer) {
      this.cancelStart = () => this.#releasePreview();
    }

    const ready = (buffer: AudioBuffer) => {
      if (this.#preview !== preview) {
        return;
      }
      try {
        if (opening) {
          this.#scheduleTail(preview, buffer);
        } else {
          this.cancelStart = undefined;
          this.#startBuffer(buffer, this.region, offset, events);
        }
      } catch (error) {
        events.failed(error);
      }
    };
    if (lease.buffer) {
      ready(lease.buffer);
    } else {
      void lease.decoded.then(ready, (error: unknown) => {
        if (this.#preview === preview) {
          events.failed(error);
        }
      });
    }
  }

  #startBuffer(
    buffer: AudioBuffer,
    region: Region,
    offset: number,
    events: WebAudioEvents,
    scheduled = false,
  ) {
    const context = this.output!.context;
    this.region = region;
    this.offset = offset;
    this.anchor = context.currentTime;
    this.state = 'playing';
    this.#source = this.#startSource(
      buffer,
      region,
      offset,
      scheduled ? this.anchor : 0,
      events.ended,
    );
    if (region.loop) {
      this.scheduleBoundary(events.ended);
    }
    events.started();
  }

  #startSource(
    buffer: AudioBuffer,
    region: Region,
    offset: number,
    when: number,
    ended: () => void,
  ) {
    const source = this.output!.context.createBufferSource();
    source.buffer = buffer;
    source.loop = region.loop;
    source.loopStart = region.start;
    source.loopEnd = region.end;
    source.playbackRate.value = this.rate;
    source.connect(this.#panner!.input);
    source.onended = ended;
    if (region.loop) {
      source.start(when, offset);
    } else {
      source.start(when, offset, region.end - offset);
    }
    return source;
  }

  #scheduleTail(preview: PreviewPlayback, buffer: AudioBuffer) {
    const { asset, boundary, events } = preview;
    const rate = Math.fround(this.rate);
    if (preview.reversed) {
      const offset = this.position();
      this.#disconnectSource(this.#source);
      this.#source = null;
      preview.opening = false;
      this.#startBuffer(buffer, this.region, offset, { ...events, started() {} }, true);
      return;
    }
    if (rate <= 0) {
      return;
    }
    const now = this.output!.context.currentTime;
    const deadline = this.anchor + (boundary - this.offset) / rate;
    const when = Math.max(now, deadline);
    if (now > deadline) {
      this.anchor = now;
      this.offset = boundary;
      asset.buffer = buffer;
      asset.preview = undefined;
      events.underrun();
    }
    preview.tail = {
      source: this.#startSource(buffer, this.region, boundary, when, events.ended),
      when,
    };
    if (this.region.loop) {
      this.scheduleBoundary(events.ended);
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
    const rate = this.#preview?.opening ? Math.fround(this.rate) : Math.abs(this.rate);
    const position = this.offset + elapsed * rate;
    if (this.#preview?.opening && !this.#preview.tail) {
      return Math.max(this.region.start, Math.min(this.#preview.boundary, position));
    }
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

  #releasePreview() {
    const preview = this.#preview;
    this.#preview = undefined;
    if (preview) {
      this.#disconnectSource(preview.tail?.source);
      preview.lease.release();
    }
  }

  #disconnectSource(source: AudioBufferSourceNode | null | undefined) {
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
  }

  #stopSource() {
    this.#disconnectSource(this.#source);
    this.#source = null;
    this.#releasePreview();
  }

  finishWebAudio() {
    this.cancelStart = undefined;
    this.#stopSource();
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
    this.#panner?.update(this.spatial, this.#source, this.#preview?.tail?.source);
  }

  changeRate(rate: number, ended: () => void) {
    const now = this.output?.context.currentTime;
    const changed = rate !== this.rate;
    if (this.state === 'playing' && now !== undefined && (changed || !this.#preview?.opening)) {
      this.offset = this.position();
      this.anchor = now;
    }
    this.rate = rate;
    if (now !== undefined) {
      this.#source?.playbackRate.setValueAtTime(rate, now);
      const preview = this.#preview;
      if (changed && preview?.opening && (!preview.tail || preview.tail.when > now)) {
        preview.reversed ||= rate < 0;
        this.clearBoundary();
        this.#disconnectSource(preview.tail?.source);
        preview.tail = undefined;
        if (preview.lease.buffer) {
          this.#scheduleTail(preview, preview.lease.buffer);
        }
        return;
      }
      preview?.tail?.source.playbackRate.setValueAtTime(rate, now);
    } else if (this.media) {
      this.media.playbackRate = rate;
    }
    if (
      this.state === 'playing' &&
      (this.output
        ? this.region.loop && (!this.#preview?.opening || this.#preview.tail)
        : this.sprite !== '__default')
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

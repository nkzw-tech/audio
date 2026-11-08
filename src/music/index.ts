/*!
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { Audio, AudioOutput } from '../index.ts';

export { createAdtsMusicSource, type AdtsMusicOptions } from './adts.ts';

const StartLeadTime = 0.025;
const RefillInterval = 250;
const ReadTimeout = 10_000;

export type MusicReader = {
  close(): void;
  duration: number;
  read(): Promise<ReadonlyArray<Float32Array<ArrayBuffer>>>;
};

export type MusicSource = {
  blockFrames: number;
  open(signal: AbortSignal): Promise<MusicReader>;
  sampleRate: number;
};

export type MusicOptions = {
  bufferSeconds?: number;
  onFailure?(error: unknown): void;
  onPlay?(): void;
};

type Block = {
  buffer: AudioBuffer;
  frame: number;
  source?: AudioBufferSourceNode;
};

export function createBufferedMusic(audio: Audio, source: MusicSource, options: MusicOptions = {}) {
  const output = audio.getOutput();
  if (!output || output.context.sampleRate !== source.sampleRate) {
    return null;
  }

  const bufferFrames = Math.floor((options.bufferSeconds ?? 30) * source.sampleRate);
  if (
    !Number.isSafeInteger(source.blockFrames) ||
    source.blockFrames <= 0 ||
    !Number.isSafeInteger(bufferFrames) ||
    bufferFrames < source.blockFrames * 2
  ) {
    throw new RangeError('The music buffer must fit at least two complete PCM blocks.');
  }

  return new BufferedMusic(output, source, bufferFrames, options);
}

export type { BufferedMusic };

class BufferedMusic {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly reads = new AbortController();
  private disposed = false;
  private readonly blocks: Array<Block> = [];
  private reader: MusicReader | null = null;
  private anchor: number | null = null;
  private frame = 0;
  private decodedThrough = 0;
  private duration = 0;
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private readDeadline = 0;
  private started = false;
  private failed = false;
  private nextFade: { duration: number; from: number; to: number } | null = null;
  private targetVolume = 1;

  constructor(
    private readonly output: AudioOutput,
    private readonly source: MusicSource,
    private readonly bufferFrames: number,
    private readonly options: MusicOptions,
  ) {
    this.context = output.context;
    this.gain = this.context.createGain();
    this.gain.connect(output.destination);
    output.signal.addEventListener('abort', this.unload, { once: true });
  }

  position() {
    return this.duration ? (this.currentFrame() / this.source.sampleRate) % this.duration : 0;
  }

  playing() {
    return this.started;
  }

  play() {
    if (this.release || this.disposed || this.failed) {
      return;
    }
    if (this.context.state === 'closed') {
      this.fail(new Error('The audio context is closed.'));
      return;
    }

    this.release = this.output.retain();
    this.context.addEventListener('statechange', this.update);
    if (this.pending) {
      this.readDeadline = performance.now() + ReadTimeout;
    }
    this.update();
  }

  pause() {
    if (!this.release) {
      return;
    }

    this.frame = this.currentFrame();
    this.anchor = null;
    this.started = false;
    this.prune();
    for (const block of this.blocks) {
      this.stopBlock(block);
    }
    if (!this.nextFade) {
      this.volume(this.targetVolume);
    }
    clearTimeout(this.timer);
    this.context.removeEventListener('statechange', this.update);
    this.release();
    this.release = null;
  }

  unload = () => {
    if (this.disposed) {
      return;
    }
    this.pause();
    this.disposed = true;
    this.reads.abort();
    this.blocks.length = 0;
    this.closeReader();
    this.gain.disconnect();
    this.output.signal.removeEventListener('abort', this.unload);
  };

  volume(): number;
  volume(volume: number): void;
  volume(volume?: number) {
    if (volume == null) {
      return this.gain.gain.value;
    }
    this.targetVolume = volume;
    this.nextFade = null;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(volume, now);
  }

  fade(from: number, to: number, duration: number) {
    this.volume(from);
    this.targetVolume = to;
    this.nextFade = { duration, from, to };
    if (this.anchor != null) {
      this.startFade(
        Math.max(this.context.currentTime, this.anchor + this.frame / this.source.sampleRate),
      );
    }
  }

  private startFade(when: number) {
    if (this.nextFade) {
      const { duration, from, to } = this.nextFade;
      this.gain.gain.setValueAtTime(from, when);
      this.gain.gain.linearRampToValueAtTime(to, when + duration / 1000);
      this.nextFade = null;
    }
  }

  private currentFrame() {
    if (this.anchor == null) {
      return this.frame;
    }
    const scheduledThrough =
      this.blocks.find(({ source }) => !source)?.frame ?? this.decodedThrough;
    const elapsed = Math.floor((this.context.currentTime - this.anchor) * this.source.sampleRate);
    return Math.max(this.frame, Math.min(scheduledThrough, elapsed));
  }

  private stopBlock(block: Block) {
    block.source?.stop();
    block.source?.disconnect();
    block.source = undefined;
  }

  private prune() {
    while (this.blocks[0] && this.blocks[0].frame + this.source.blockFrames <= this.frame) {
      const block = this.blocks[0];
      this.blocks.shift();
      this.stopBlock(block);
    }
  }

  private closeReader() {
    this.reader?.close();
    this.reader = null;
  }

  private async read() {
    this.pending = true;
    this.readDeadline = performance.now() + ReadTimeout;
    try {
      if (!this.reader) {
        const reader = await this.source.open(this.reads.signal);
        if (this.disposed || this.failed) {
          reader.close();
          return;
        }
        this.reader = reader;
        if (!Number.isFinite(reader.duration) || reader.duration <= 0) {
          throw new Error('Invalid music duration.');
        }
        this.duration = reader.duration;
      }

      const channels = await this.reader.read();
      if (this.disposed || this.failed) {
        return;
      }
      const { blockFrames, sampleRate } = this.source;
      if (!channels.length || channels.some((channel) => channel.length !== blockFrames)) {
        throw new Error('Unexpected decoded music block.');
      }

      const buffer = this.context.createBuffer(channels.length, blockFrames, sampleRate);
      for (const [index, channel] of channels.entries()) {
        buffer.copyToChannel(channel, index);
      }
      this.blocks.push({ buffer, frame: this.decodedThrough });
      this.decodedThrough += blockFrames;
      this.pending = false;
      this.update();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown) {
    if (!this.failed && !this.disposed) {
      this.failed = true;
      const unscheduled = this.blocks.findIndex(({ source }) => !source);
      if (unscheduled >= 0) {
        this.decodedThrough =
          this.anchor == null ? this.frame : Math.max(this.frame, this.blocks[unscheduled].frame);
        this.blocks.length = unscheduled;
      }
      this.reads.abort();
      this.closeReader();
      this.options.onFailure?.(error);
    }
  }

  private update = () => {
    clearTimeout(this.timer);
    if (!this.release) {
      return;
    }
    if (this.context.state === 'closed') {
      this.fail(new Error('The audio context is closed.'));
      this.pause();
      return;
    }

    const now = this.context.currentTime;
    const { blockFrames, sampleRate } = this.source;
    this.frame = this.currentFrame();
    this.prune();

    if (this.context.state === 'running' && this.blocks.length) {
      if (this.anchor == null) {
        this.anchor = now + StartLeadTime - this.frame / sampleRate;
        this.startFade(now + StartLeadTime);
      }
      for (const block of this.blocks) {
        if (!block.source) {
          const offset = Math.max(0, this.frame - block.frame);
          const when = this.anchor + (block.frame + offset) / sampleRate;
          if (when < now) {
            this.fail(new Error('Buffered music missed a playback deadline.'));
            break;
          }
          const source = this.context.createBufferSource();
          source.buffer = block.buffer;
          source.connect(this.gain);
          source.start(when, offset / sampleRate);
          block.source = source;
        }
      }
      if (
        !this.failed &&
        !this.started &&
        now >= this.anchor + this.frame / sampleRate - 1 / sampleRate
      ) {
        this.started = true;
        this.options.onPlay?.();
      }
    }

    if (!this.release) {
      return;
    }
    if (this.failed && this.frame === this.decodedThrough) {
      this.pause();
      return;
    }
    if (!this.failed) {
      if (
        (this.pending && performance.now() > this.readDeadline) ||
        (this.anchor != null && this.decodedThrough === this.frame)
      ) {
        this.fail(new Error('Buffered music ran out of decoded audio.'));
      } else if (
        !this.pending &&
        this.decodedThrough - this.frame <= this.bufferFrames - blockFrames
      ) {
        void this.read();
      }
    }

    this.scheduleUpdate();
  };

  private scheduleUpdate() {
    if (this.release) {
      this.timer = setTimeout(
        this.update,
        this.anchor != null && !this.started ? 10 : RefillInterval,
      );
    }
  }
}

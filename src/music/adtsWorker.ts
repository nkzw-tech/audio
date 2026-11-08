/*!
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import {
  BlockFrames,
  type DecoderRequest,
  type DecoderResponse,
  SampleRate,
} from './adtsProtocol.ts';

const AACPacketFrames = 1024;
const MaxPacketsInFlight = 16;
const config = { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: SampleRate };

class MusicDecoder {
  private decoder: AudioDecoder | null = null;
  private packet = 0;
  private inFlight = 0;
  private priming: number;
  private remaining: number;
  private requested = false;
  private flushing = false;
  private failed = false;
  private channels = this.createBlock();
  private written = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly offsets: ReadonlyArray<number>,
    private readonly primingFrames: number,
    private readonly loopFrames: number,
  ) {
    this.priming = primingFrames;
    this.remaining = loopFrames;
  }

  read() {
    this.requested = true;
    this.pump();
  }

  private createBlock() {
    return [new Float32Array(BlockFrames), new Float32Array(BlockFrames)] as const;
  }

  private fail(error: unknown) {
    if (!this.failed) {
      this.failed = true;
      const decoder = this.decoder;
      if (decoder && decoder.state !== 'closed') {
        decoder.close();
      }
      self.postMessage({ error: String(error) } satisfies DecoderResponse);
    }
  }

  private output(frame: AudioData) {
    try {
      if (
        frame.numberOfFrames !== AACPacketFrames ||
        frame.sampleRate !== SampleRate ||
        frame.numberOfChannels !== 2
      ) {
        throw new Error('Unexpected decoded music format.');
      }

      this.inFlight--;
      let offset = Math.min(this.priming, frame.numberOfFrames);
      this.priming -= offset;
      while (offset < frame.numberOfFrames && this.remaining > 0) {
        const count = Math.min(
          frame.numberOfFrames - offset,
          BlockFrames - this.written,
          this.remaining,
        );
        this.remaining -= count;
        for (const planeIndex of [0, 1] as const) {
          frame.copyTo(this.channels[planeIndex].subarray(this.written, this.written + count), {
            format: 'f32-planar',
            frameCount: count,
            frameOffset: offset,
            planeIndex,
          });
        }
        this.written += count;
        offset += count;
        if (this.written === BlockFrames) {
          const channels = this.channels;
          this.channels = this.createBlock();
          this.written = 0;
          this.requested = false;
          self.postMessage({ channels } satisfies DecoderResponse, {
            transfer: channels.map((channel) => channel.buffer),
          });
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      frame.close();
    }
    this.pump();
  }

  private pump() {
    if (!this.requested || this.flushing || this.failed) {
      return;
    }

    try {
      if (!this.decoder) {
        this.decoder = new AudioDecoder({
          error: (error) => this.fail(error),
          output: (frame) => this.output(frame),
        });
        this.decoder.configure(config);
      }

      const decoder = this.decoder;
      const packets = this.offsets.length - 1;
      while (this.inFlight < MaxPacketsInFlight && this.packet < packets) {
        const index = this.packet++;
        decoder.decode(
          new EncodedAudioChunk({
            data: this.data.subarray(this.offsets[index], this.offsets[index + 1]),
            timestamp: Math.round((index * AACPacketFrames * 1_000_000) / SampleRate),
            type: 'key',
          }),
        );
        this.inFlight++;
      }

      if (this.packet === packets) {
        this.flushing = true;
        void decoder
          .flush()
          .then(() => {
            if (this.inFlight !== 0 || this.remaining !== 0) {
              throw new Error('Incomplete decoded music track.');
            }
            decoder.close();
            this.decoder = null;
            this.flushing = false;
            this.packet = 0;
            this.priming = this.primingFrames;
            this.remaining = this.loopFrames;
            this.pump();
          })
          .catch((error: unknown) => this.fail(error));
      }
    } catch (error) {
      this.fail(error);
    }
  }
}

async function load({
  paddingFrames,
  primingFrames,
  url,
}: Extract<DecoderRequest, { url: string }>) {
  if (
    typeof AudioDecoder === 'undefined' ||
    !(await AudioDecoder.isConfigSupported(config)).supported
  ) {
    throw new Error('Buffered AAC decoding is unavailable.');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load music (${response.status}).`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const offsets = [0];
  for (let offset = 0; offset < data.length;) {
    const second = data[offset + 1];
    const third = data[offset + 2];
    const fourth = data[offset + 3];
    const length = ((fourth & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    if (
      offset + 7 > data.length ||
      data[offset] !== 255 ||
      (second & 0xf6) !== 0xf0 ||
      third >> 2 !== 19 ||
      (((third & 1) << 2) | (fourth >> 6)) !== 2 ||
      (data[offset + 6] & 3) !== 0 ||
      length <= (second & 1 ? 7 : 9) ||
      offset + length > data.length
    ) {
      throw new Error('Unsupported AAC music track.');
    }

    offset += length;
    offsets.push(offset);
  }

  const loopFrames = (offsets.length - 1) * AACPacketFrames - primingFrames - paddingFrames;
  if (!Number.isSafeInteger(loopFrames) || loopFrames <= 0) {
    throw new Error('Empty AAC music track.');
  }

  self.postMessage({ duration: loopFrames / SampleRate } satisfies DecoderResponse);
  return new MusicDecoder(data, offsets, primingFrames, loopFrames);
}

let decoder: Promise<MusicDecoder | null> | null = null;
self.onmessage = ({ data }: MessageEvent<DecoderRequest>) => {
  if ('url' in data) {
    decoder = load(data).catch((error: unknown) => {
      self.postMessage({ error: String(error) } satisfies DecoderResponse);
      return null;
    });
  } else {
    void decoder?.then((decoder) => decoder?.read());
  }
};

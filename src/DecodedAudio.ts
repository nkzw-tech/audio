/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { SoundOptions } from './index.ts';

export type DecodedAsset = {
  buffer: AudioBuffer;
  duration: number;
  preview?: PreviewAudio;
};

export type BufferLease = {
  readonly asset: DecodedAsset | undefined;
  decoded: Promise<DecodedAsset>;
  release(): void;
};

type Asset = {
  abort: AbortController;
  asset?: DecodedAsset;
  decoded: Promise<DecodedAsset>;
  users: number;
};

const NetworkFailure = Symbol('Audio network failure');

export class AudioNetworkError extends Error {
  readonly [NetworkFailure] = true;

  static matches(error: unknown): error is AudioNetworkError {
    return typeof error === 'object' && error !== null && NetworkFailure in error;
  }
}

export class DecodedAudioCache {
  readonly #assets = new Map<string, Asset>();
  readonly #preloadLanes = Array.from({ length: 4 }, () => Promise.resolve());
  #nextLane = 0;

  acquire(
    context: AudioContext,
    url: string,
    request: SoundOptions['xhr'],
    previewSeconds: number | undefined,
  ): BufferLease {
    const share =
      (!request?.method || request.method === 'GET') &&
      !request?.headers &&
      !request?.withCredentials;
    const key = JSON.stringify([url, previewSeconds]);
    let asset = share ? this.#assets.get(key) : undefined;
    if (!asset) {
      const abort = new AbortController();
      const decoded = this.#load(context, url, request, previewSeconds, abort.signal);
      const entry: Asset = { abort, decoded, users: 0 };
      entry.decoded = decoded.then((asset) => {
        abort.signal.throwIfAborted();
        entry.asset = asset;
        return asset;
      });
      asset = entry;
      if (share) {
        this.#assets.set(key, entry);
      }
    }

    const entry = asset;
    entry.users++;
    let released = false;
    return {
      get asset() {
        return entry.asset;
      },
      decoded: entry.decoded,
      release: () => {
        if (!released) {
          released = true;
          if (--entry.users === 0) {
            entry.abort.abort();
            if (this.#assets.get(key) === entry) {
              this.#assets.delete(key);
            }
          }
        }
      },
    };
  }

  async #load(
    context: AudioContext,
    url: string,
    request: SoundOptions['xhr'],
    previewSeconds: number | undefined,
    signal: AbortSignal,
  ): Promise<DecodedAsset> {
    const data = await fetchEncoded(url, request, signal);
    if (previewSeconds === undefined) {
      const buffer = await context.decodeAudioData(data);
      return { buffer, duration: buffer.duration };
    }

    const lane = this.#nextLane;
    this.#nextLane = (lane + 1) % this.#preloadLanes.length;
    const prepared = this.#preloadLanes[lane].then(async () => {
      signal.throwIfAborted();
      const buffer = await context.decodeAudioData(data.slice(0));
      signal.throwIfAborted();
      const { duration, length, numberOfChannels, sampleRate } = buffer;
      const frames = Math.ceil(previewSeconds * sampleRate);
      if (frames >= length) {
        return { buffer, duration };
      }
      const opening = context.createBuffer(numberOfChannels, frames, sampleRate);
      for (let channel = 0; channel < numberOfChannels; channel++) {
        buffer.copyFromChannel(opening.getChannelData(channel), channel);
      }
      return { buffer: opening, duration, preview: new PreviewAudio(context, data) };
    });
    this.#preloadLanes[lane] = prepared.then(
      () => {},
      () => {},
    );
    return prepared;
  }
}

type ActiveDecode = {
  buffer?: AudioBuffer;
  decoded: Promise<AudioBuffer>;
  settled: boolean;
  users: number;
};

class PreviewAudio {
  #active: ActiveDecode | undefined;

  constructor(
    private readonly context: AudioContext,
    private readonly data: ArrayBuffer,
  ) {}

  acquire() {
    if (!this.#active) {
      const entry: ActiveDecode = {
        decoded: this.context.decodeAudioData(this.data.slice(0)),
        settled: false,
        users: 0,
      };
      this.#active = entry;
      void entry.decoded.then(
        (buffer) => {
          entry.buffer = buffer;
          this.#settled(entry);
        },
        () => this.#settled(entry),
      );
    }

    const entry = this.#active;
    entry.users++;
    return {
      get buffer() {
        return entry.buffer;
      },
      decoded: entry.decoded,
      release: () => {
        if (--entry.users === 0 && entry.settled) {
          queueMicrotask(() => this.#prune(entry));
        }
      },
    };
  }

  #settled(entry: ActiveDecode) {
    entry.settled = true;
    this.#prune(entry);
  }

  #prune(entry: ActiveDecode) {
    if (entry.users === 0 && this.#active === entry) {
      this.#active = undefined;
    }
  }
}

async function fetchEncoded(url: string, request: SoundOptions['xhr'], signal: AbortSignal) {
  let data: ArrayBuffer;
  const encoded = /^data:[^;,]+;base64,(.+)$/i.exec(url);
  if (encoded) {
    data = Uint8Array.from(atob(encoded[1]), (character) => character.charCodeAt(0)).buffer;
  } else {
    let response: Response;
    try {
      response = await fetch(url, {
        credentials: request?.withCredentials ? 'include' : 'same-origin',
        headers: request?.headers,
        method: request?.method ?? 'GET',
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new AudioNetworkError('Could not fetch audio.', { cause: error });
    }

    if (!response.ok) {
      throw new Error(`Failed loading audio file with status: ${response.status}.`);
    }
    data = await response.arrayBuffer();
  }
  signal.throwIfAborted();
  return data;
}

/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { SoundOptions } from './index.ts';

export type BufferLease = {
  readonly buffer: AudioBuffer | undefined;
  decoded: Promise<AudioBuffer>;
  release(): void;
};

type Asset = {
  abort: AbortController;
  buffer?: AudioBuffer;
  decoded: Promise<AudioBuffer>;
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

  acquire(context: AudioContext, url: string, request: SoundOptions['xhr']): BufferLease {
    const share =
      (!request?.method || request.method === 'GET') &&
      !request?.headers &&
      !request?.withCredentials;
    let asset = share ? this.#assets.get(url) : undefined;
    if (!asset) {
      const abort = new AbortController();
      const decoded = fetchBuffer(context, url, request, abort.signal);
      const entry: Asset = { abort, decoded, users: 0 };
      entry.decoded = decoded.then((buffer) => {
        abort.signal.throwIfAborted();
        entry.buffer = buffer;
        return buffer;
      });
      asset = entry;
      if (share) {
        this.#assets.set(url, entry);
      }
    }

    const entry = asset;
    entry.users++;
    let released = false;
    return {
      get buffer() {
        return entry.buffer;
      },
      decoded: entry.decoded,
      release: () => {
        if (!released) {
          released = true;
          if (--entry.users === 0) {
            entry.abort.abort();
            if (this.#assets.get(url) === entry) {
              this.#assets.delete(url);
            }
          }
        }
      },
    };
  }
}

async function fetchBuffer(
  context: AudioContext,
  url: string,
  request: SoundOptions['xhr'],
  signal: AbortSignal,
) {
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
  return context.decodeAudioData(data);
}

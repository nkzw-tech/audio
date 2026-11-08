import {
  BlockFrames,
  type DecoderRequest,
  type DecoderResponse,
  SampleRate,
} from './adtsProtocol.ts';
import type { MusicSource } from './index.ts';

export type AdtsMusicOptions = {
  createWorker(): Worker;
  paddingFrames?: number;
  primingFrames: number;
  src: string | URL;
};

export function createAdtsMusicSource({
  createWorker,
  paddingFrames = 0,
  primingFrames,
  src,
}: AdtsMusicOptions): MusicSource {
  if (
    !Number.isSafeInteger(primingFrames) ||
    !Number.isSafeInteger(paddingFrames) ||
    primingFrames < 0 ||
    paddingFrames < 0
  ) {
    throw new RangeError('AAC trim must be specified in nonnegative whole frames.');
  }

  return {
    blockFrames: BlockFrames,
    async open(signal) {
      signal.throwIfAborted();
      const url = new URL(src, document.baseURI).href;
      const connection = connect(createWorker(), signal);
      try {
        const metadata = await connection.request({ paddingFrames, primingFrames, url });
        if (!('duration' in metadata)) {
          throw new Error('AAC decoder did not return track metadata.');
        }
        return {
          close: connection.close,
          duration: metadata.duration,
          async read() {
            const block = await connection.request({ read: true });
            if (!('channels' in block)) {
              throw new Error('AAC decoder did not return a PCM block.');
            }
            return block.channels;
          },
        };
      } catch (error) {
        connection.close();
        throw error;
      }
    },
    sampleRate: SampleRate,
  };
}

function connect(worker: Worker, signal: AbortSignal) {
  type Pending = {
    reject(error: unknown): void;
    resolve(response: DecoderResponse): void;
  };

  let pending: Pending | undefined;
  let failure: Error | undefined;

  function close(error = new Error('AAC decoder was closed.')) {
    if (!failure) {
      failure = error;
      worker.terminate();
      worker.onmessage = worker.onmessageerror = worker.onerror = null;
      signal.removeEventListener('abort', abort);
      pending?.reject(error);
      pending = undefined;
    }
  }

  function abort() {
    close(new Error('AAC decoding was aborted.'));
  }

  signal.addEventListener('abort', abort, { once: true });
  worker.onerror = (event) => close(new Error(event.message || 'AAC worker failed.'));
  worker.onmessageerror = () => close(new Error('AAC worker returned an invalid message.'));
  worker.onmessage = ({ data }: MessageEvent<DecoderResponse>) => {
    if ('error' in data) {
      close(new Error(data.error));
    } else {
      pending?.resolve(data);
      pending = undefined;
    }
  };

  if (signal.aborted) {
    abort();
  }

  return {
    close,
    async request(message: DecoderRequest) {
      if (failure || pending) {
        throw failure ?? new Error('The AAC decoder already has a pending request.');
      }
      return new Promise<DecoderResponse>((resolve, reject) => {
        pending = { reject, resolve };
        try {
          worker.postMessage(message);
        } catch {
          close(new Error('Could not send the AAC decoder a request.'));
        }
      });
    },
  };
}

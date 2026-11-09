import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium, firefox, webkit } from 'playwright';

const script = await readFile(new URL('../lib/index.js', import.meta.url));
const server = createServer((request, response) => {
  if (request.url === '/audio.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(script);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html>');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port;
test.after(() => server.close());

const engines = Object.entries(
  process.platform !== 'darwin' || process.env.NKZW_AUDIO_TEST_FIREFOX === '1'
    ? { chromium, firefox, webkit }
    : { chromium, webkit },
);

for (const [name, engine] of engines) {
  const supportsPreview = name !== 'firefox';
  test(
    supportsPreview
      ? `${name}: joins the preloaded opening and the shared decode without a gap`
      : `${name}: plays a single buffer per voice when a preview is requested`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        const result = await page.evaluate(async (supportsPreview) => {
          const { createAudio } = await import('/audio.js');
          const rate = 48_000;
          const samples = new ArrayBuffer(44 + rate * 2);
          const view = new DataView(samples);
          view.setUint32(0, 0x52_49_46_46);
          view.setUint32(4, samples.byteLength - 8, true);
          view.setUint32(8, 0x57_41_56_45);
          view.setUint32(12, 0x66_6d_74_20);
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, rate, true);
          view.setUint32(28, rate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          view.setUint32(36, 0x64_61_74_61);
          view.setUint32(40, rate * 2, true);
          for (let i = 0; i < rate; i++) {
            view.setInt16(44 + i * 2, 10_000 * Math.sin((i * 2 * Math.PI * 3657) / rate), true);
          }
          const src = URL.createObjectURL(new Blob([samples], { type: 'audio/wav' }));

          async function render(previewSeconds, playbackRate, late = false) {
            const context = new OfflineAudioContext(1, rate, rate);
            Object.defineProperty(context, 'state', { value: 'running' });
            globalThis.AudioContext = function () {
              return context;
            };
            const hold = Promise.withResolvers();
            const decoded = Promise.withResolvers();
            const scheduled = Promise.withResolvers();
            const continued = Promise.withResolvers();
            const underrun = Promise.withResolvers();
            let decodes = 0;
            let sources = 0;
            let playErrors = 0;
            const decode = context.decodeAudioData.bind(context);
            const createSource = context.createBufferSource.bind(context);
            context.decodeAudioData = async (encoded) => {
              const first = ++decodes === 1;
              const buffer = await decode(encoded);
              if (!first) {
                decoded.resolve();
                await hold.promise;
              }
              return buffer;
            };
            context.createBufferSource = () => {
              const source = createSource();
              sources++;
              if (sources === 3) {
                continued.resolve();
              } else if (sources === 4) {
                scheduled.resolve();
              }
              return source;
            };

            const mixer = createAudio({ autoSuspend: false });
            const loaded = Promise.withResolvers();
            const sound = mixer.sound({
              format: 'wav',
              onbufferunderrun: (id) => {
                playErrors++;
                underrun.resolve(id);
              },
              onload: loaded.resolve,
              onloaderror: (_, error) => loaded.reject(error),
              onplayerror: () => playErrors++,
              previewSeconds,
              rate: playbackRate,
              src,
            });
            await loaded.promise;
            const first = sound.play();
            const second = sound.play();
            const startedBeforeDecode =
              sources === 2 && sound.playing(first) && sound.playing(second);
            if (late) {
              await decoded.promise;
              sound.stop(second);
              Object.defineProperty(context, 'currentTime', { value: 0.5 });
              hold.resolve();
              const [id] = await Promise.all([underrun.promise, continued.promise]);
              const position = sound.position(first);
              const cancelled = !sound.playing(second);
              const replay = sound.play();
              return {
                cancelled,
                decodes,
                position,
                recovered: id === first && sound.playing(first),
                replayedImmediately: sources === 4 && sound.playing(replay),
              };
            }
            if (supportsPreview && previewSeconds !== undefined) {
              await decoded.promise;
              hold.resolve();
              await scheduled.promise;
            }
            const output = await context.startRendering();
            return {
              decodes,
              playErrors,
              startedBeforeDecode,
              waveform: output.getChannelData(0),
            };
          }

          const comparisons = [];
          for (const playbackRate of [1, 1.3, 1.7, 2, 4]) {
            const baseline = await render(undefined, playbackRate);
            const preview = await render(0.4, playbackRate);
            let maxError = 0;
            for (const [i, sample] of preview.waveform.entries()) {
              maxError = Math.max(maxError, Math.abs(sample - baseline.waveform[i]));
            }
            comparisons.push({
              decodes: preview.decodes,
              maxError,
              playErrors: preview.playErrors,
              startedBeforeDecode: preview.startedBeforeDecode,
            });
          }
          const late = supportsPreview ? await render(0.25, 1, true) : null;
          URL.revokeObjectURL(src);
          return { comparisons, late };
        }, supportsPreview);
        for (const { decodes, maxError, playErrors, startedBeforeDecode } of result.comparisons) {
          assert.equal(decodes, supportsPreview ? 2 : 1);
          assert.equal(playErrors, 0);
          assert.equal(startedBeforeDecode, true);
          assert.ok(maxError <= 0.000001, String(maxError));
        }
        assert.deepEqual(
          result.late,
          supportsPreview
            ? {
                cancelled: true,
                decodes: 2,
                position: 0.25,
                recovered: true,
                replayedImmediately: true,
              }
            : null,
        );
      } finally {
        await browser.close();
      }
    },
  );
}

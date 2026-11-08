import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';

const scripts = new Map([
  ['/audio.js', await readFile(new URL('../dist/index.js', import.meta.url))],
  ['/music.js', await readFile(new URL('../dist/music.js', import.meta.url))],
]);
const audio = await readFile(new URL('./audio/sound1.wav', import.meta.url));
const server = createServer((request, response) => {
  if (scripts.has(request.url)) {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(scripts.get(request.url));
  } else if (request.url.startsWith('/sound.wav')) {
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    response.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'audio/wav',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : audio.subarray(start, end + 1));
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><button>Play</button>');
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(
    `${name}: plays Web Audio and HTML media from one gesture`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const mixer = createAudio();
          mixer.volume(0);
          window.playback = {};
          document.querySelector('button').addEventListener(
            'click',
            () => {
              for (const html5 of [false, true]) {
                const name = html5 ? 'html' : 'web';
                const sound = mixer.sound({ html5, preload: false, src: ['/sound.wav?' + name] });
                sound.on('loaderror', (_, error) => {
                  window.playback[name] = String(error);
                });
                sound.on('playerror', (_, error) => {
                  window.playback[name] = String(error);
                });
                sound.on('play', (id) => {
                  window.playback[name] = sound.playing(id) && sound.duration(id) > 0;
                  sound.stop(id);
                  sound.unload();
                });
                if (typeof sound.stereo !== 'function') {
                  throw new Error('Spatial playback is unavailable.');
                }
                sound.load();
                sound.play();
              }
            },
            { once: true },
          );
        });
        await page.getByRole('button').click();
        await page.waitForFunction(() => Object.keys(window.playback).length === 2);
        assert.deepEqual(await page.evaluate(() => window.playback), { html: true, web: true });
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: isolates contexts, output leases, and disposal`, { timeout: 15_000 }, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const result = await page.evaluate(async () => {
        const { createAudio } = await import('/audio.js');
        const a = createAudio();
        const b = createAudio();
        a.volume(0.3);
        const output = a.getOutput();
        const first = a.sound({ preload: false, src: '/sound.wav' });
        const second = b.sound({ preload: false, src: '/sound.wav' });
        const other = b.getOutput();
        const distinct =
          output.context !== other.context && output.destination !== other.destination;
        const stable = output.context === a.getOutput().context;
        const unmodified =
          b.volume() === 1 && !window.NkzwAudio && new window.Audio().localName === 'audio';
        const release = output.retain();
        await a.dispose();
        release();
        release();
        const disposed =
          output.context.state === 'closed' &&
          output.signal.aborted &&
          first.state() === 'unloaded' &&
          a.getOutput() === null;
        const unaffected =
          !other.signal.aborted &&
          other.context.state !== 'closed' &&
          second.state() === 'unloaded';
        await b.dispose();
        return { disposed, distinct, stable, unaffected, unmodified };
      });
      assert.deepEqual(result, {
        disposed: true,
        distinct: true,
        stable: true,
        unaffected: true,
        unmodified: true,
      });
    } finally {
      await browser.close();
    }
  });
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(
    `${name}: buffers music on the audio clock and releases it on disposal`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const { createBufferedMusic } = await import('/music.js');
          const audio = createAudio({ html5PoolSize: 0 });
          audio.volume(0);
          const { context } = audio.getOutput();
          const sampleRate = context.sampleRate;
          const blockFrames = sampleRate / 4;
          const report = { closes: 0, error: null, reads: 0, starts: [] };
          const original = context.createBufferSource.bind(context);
          context.createBufferSource = () => {
            const source = original();
            const start = source.start.bind(source);
            source.start = (when, offset) => {
              if (source.buffer?.length === blockFrames) {
                report.starts.push({ offset, when });
              }
              start(when, offset);
            };
            return source;
          };
          const track = createBufferedMusic(
            audio,
            {
              blockFrames,
              async open() {
                return {
                  close() {
                    report.closes++;
                  },
                  duration: 4,
                  async read() {
                    report.reads++;
                    return [new Float32Array(blockFrames)];
                  },
                };
              },
              sampleRate,
            },
            {
              bufferSeconds: 1,
              onFailure(error) {
                report.error = String(error);
              },
            },
          );
          window.music = { audio, report, track };
          document.querySelector('button').addEventListener('click', () => track.play());
        });
        await page.getByRole('button').click();
        await page.waitForFunction(() => window.music.report.starts.length >= 4);
        const baseline = await page.evaluate(() => {
          const { report, track } = window.music;
          const sampleExact = report.starts
            .slice(1, 4)
            .every(
              ({ when }, index) => Math.abs(when - report.starts[index].when - 0.25) < 0.000001,
            );
          return {
            error: report.error,
            reads: report.reads,
            sampleExact,
            seconds: track.position(),
          };
        });
        assert.equal(baseline.error, null);
        assert.equal(baseline.sampleExact, true);
        assert.ok(baseline.reads <= Math.floor(baseline.seconds / 0.25) + 4);
        await page.waitForFunction(() => window.music.track.position() > 0.3);
        const paused = await page.evaluate(() => {
          window.music.track.pause();
          return window.music.track.position();
        });
        assert.equal(await page.evaluate(() => window.music.track.position()), paused);
        await page.getByRole('button').click();
        await page.waitForFunction(
          (paused) => window.music.track.position() > paused + 0.1,
          paused,
        );
        const result = await page.evaluate(async () => {
          const { audio, report, track } = window.music;
          await audio.dispose();
          track.unload();
          return { closes: report.closes, error: report.error, playing: track.playing() };
        });
        assert.deepEqual(result, { closes: 1, error: null, playing: false });
      } finally {
        await browser.close();
      }
    },
  );
}

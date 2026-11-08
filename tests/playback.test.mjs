import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium, firefox, webkit } from 'playwright';

const engines = Object.entries(
  process.platform !== 'darwin' || process.env.NKZW_AUDIO_TEST_FIREFOX === '1'
    ? { chromium, firefox, webkit }
    : { chromium, webkit },
);

const scripts = new Map([
  ['/audio.js', await readFile(new URL('../lib/index.js', import.meta.url))],
  ['/music.js', await readFile(new URL('../lib/music.js', import.meta.url))],
  ['/music-worker.js', await readFile(new URL('../lib/music-worker.js', import.meta.url))],
]);
const aac = await readFile(new URL('./audio/loop.aac', import.meta.url));
const audio = await readFile(new URL('./audio/sound1.wav', import.meta.url));
const server = createServer((request, response) => {
  if (scripts.has(request.url)) {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(scripts.get(request.url));
  } else if (request.url === '/loop.aac') {
    response.setHeader('Content-Type', 'audio/aac');
    response.end(aac);
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

for (const [name, engine] of engines) {
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

for (const [name, engine] of engines) {
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

for (const [name, engine] of engines) {
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

test(
  'webkit: AAC worker preserves both channels at the loop boundary',
  { timeout: 15_000 },
  async (test) => {
    const browser = await webkit.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const supported = await page.evaluate(
        async () =>
          typeof AudioDecoder !== 'undefined' &&
          (
            await AudioDecoder.isConfigSupported({
              codec: 'mp4a.40.2',
              numberOfChannels: 2,
              sampleRate: 48_000,
            })
          ).supported,
      );
      if (!supported) {
        test.skip('AAC WebCodecs is unavailable.');
        return;
      }
      const { frames, loopFrames, nativeDifference, repeatedDifference } = await page.evaluate(
        async (compareNative) => {
          const { createAdtsMusicSource } = await import('/music.js');
          const abort = new AbortController();
          const primingFrames = 2112;
          const paddingFrames = 123;
          const reader = await createAdtsMusicSource({
            createWorker: () => new Worker('/music-worker.js', { type: 'module' }),
            paddingFrames,
            primingFrames,
            src: '/loop.aac',
          }).open(abort.signal);
          try {
            const loopFrames = Math.round(reader.duration * 48_000);
            const firstLoop = [new Float32Array(loopFrames), new Float32Array(loopFrames)];
            const encoded = await (await fetch('/loop.aac')).arrayBuffer();
            const reference = compareNative
              ? await new OfflineAudioContext(2, 1, 48_000).decodeAudioData(encoded)
              : null;
            let frames = 0;
            let nativeDifference = 0;
            let repeatedDifference = 0;
            while (frames < loopFrames * 2) {
              const block = await reader.read();
              for (const [channel, samples] of block.entries()) {
                const native = reference?.getChannelData(channel);
                for (const [offset, sample] of samples.entries()) {
                  const absoluteFrame = frames + offset;
                  const frame = absoluteFrame % loopFrames;
                  if (absoluteFrame < loopFrames) {
                    firstLoop[channel][frame] = sample;
                  } else {
                    repeatedDifference = Math.max(
                      repeatedDifference,
                      Math.abs(sample - firstLoop[channel][frame]),
                    );
                  }
                  if (native) {
                    nativeDifference = Math.max(nativeDifference, Math.abs(sample - native[frame]));
                  }
                }
              }
              frames += block[0].length;
            }
            return { frames, loopFrames, nativeDifference, repeatedDifference };
          } finally {
            abort.abort();
            reader.close();
          }
        },
        process.platform === 'darwin',
      );
      assert.ok(loopFrames > 96_000);
      assert.ok(frames >= loopFrames * 2);
      assert.ok(repeatedDifference < 0.000001, `Loop difference: ${repeatedDifference}`);
      assert.ok(nativeDifference < 0.000001, `Native waveform difference: ${nativeDifference}`);
    } finally {
      await browser.close();
    }
  },
);

for (const [name, engine] of engines) {
  test(
    `${name}: a gesture unlocks once and external playback prevents idle suspension`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const timeout = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) =>
            timeout(callback, delay === 30_000 ? 150 : delay, ...args);

          const { createAudio } = await import('/audio.js');
          const audio = createAudio({ html5PoolSize: 0 });
          const output = audio.getOutput();
          const { context } = output;
          const resume = context.resume.bind(context);
          const state = { audio, context, count: 0, release: null, unlocks: 0 };
          audio.sound({
            onunlock: () => state.unlocks++,
            preload: false,
            src: '/sound.wav',
          });
          window.lease = state;
          context.resume = () => {
            state.count++;
            return resume();
          };
          document.querySelector('button').addEventListener(
            'click',
            () => {
              state.release = output.retain();
              for (const type of ['touchstart', 'touchend', 'keydown']) {
                document.dispatchEvent(new Event(type));
              }
            },
            { once: true },
          );
        });
        await page.waitForFunction(() => window.lease.context.state === 'suspended');
        await page.getByRole('button').click();
        await page.waitForFunction(() => window.lease.context.state === 'running');
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 220)));
        const state = await page.evaluate(() => ({
          count: window.lease.count,
          state: window.lease.context.state,
          unlocks: window.lease.unlocks,
        }));
        assert.ok(state.count <= 1);
        assert.equal(state.state, 'running');
        assert.equal(state.unlocks, 1);
        await page.evaluate(() => {
          window.lease.release();
          window.lease.release();
        });
        await page.waitForFunction(() => window.lease.context.state === 'suspended');
        await page.evaluate(() => window.lease.audio.dispose());
      } finally {
        await browser.close();
      }
    },
  );

  test(
    `${name}: unload cancels a pending fetch and ignores a late decode`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        const held = Promise.withResolvers();
        const reply = Promise.withResolvers();
        await page.route('**/sound.wav?held', async (route) => {
          held.resolve();
          await reply.promise;
          await route.abort().catch(() => {});
        });
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio({ html5PoolSize: 0 });
          const output = audio.getOutput();
          const report = { aborts: 0, decodes: 0, events: [] };
          const fetchAudio = window.fetch;
          window.fetch = (source, options) => {
            if (String(source).endsWith('?held')) {
              options.signal.addEventListener('abort', () => report.aborts++, { once: true });
            }
            return fetchAudio(source, options);
          };
          const delayed = Promise.withResolvers();
          output.context.decodeAudioData = () => {
            report.decodes++;
            return delayed.promise;
          };
          window.loads = {
            audio,
            delayed,
            output,
            report,
            sound: audio.sound({
              onload: () => report.events.push('load'),
              onloaderror: () => report.events.push('error'),
              src: '/sound.wav?held',
            }),
          };
        });
        await held.promise;
        await page.evaluate(() => {
          const { audio, report, sound } = window.loads;
          sound.unload();
          window.loads.sound = audio.sound({
            onload: () => report.events.push('load'),
            onloaderror: () => report.events.push('error'),
            src: '/sound.wav?decode',
          });
        });
        reply.resolve();
        await page.waitForFunction(() => window.loads.report.decodes === 1);
        const report = await page.evaluate(async () => {
          const { audio, delayed, output, report, sound } = window.loads;
          sound.unload();
          delayed.resolve(output.context.createBuffer(1, 48, output.context.sampleRate));
          await audio.dispose();
          return { ...report, play: sound.play(), state: sound.state() };
        });
        assert.deepEqual(report, {
          aborts: 1,
          decodes: 1,
          events: [],
          play: null,
          state: 'unloaded',
        });
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of engines) {
  test(
    `${name}: keeps overlapping sound effects queued during context resume`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const timeout = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) =>
            timeout(callback, delay === 30_000 ? 150 : delay, ...args);
          const { createAudio } = await import('/audio.js');
          const audio = createAudio({ html5PoolSize: 0 });
          const { context } = audio.getOutput();
          const resume = context.resume.bind(context);
          const pending = Promise.withResolvers();
          context.resume = () => pending.promise;
          const voices = [];
          const sound = audio.sound({
            onplay: (id) => voices.push(id),
            src: '/sound.wav',
          });
          window.overlap = { audio, context, sound, voices };
          document.querySelector('button').addEventListener('click', () => {
            const first = sound.play();
            const second = sound.play();
            sound.play(second);
            window.overlap.expected = [first, second];
            resume().then(pending.resolve, pending.reject);
          });
        });
        await page.waitForFunction(
          () =>
            window.overlap.sound.state() === 'loaded' &&
            window.overlap.context.state === 'suspended',
        );
        await page.getByRole('button').click();
        await page.waitForFunction(() => window.overlap.voices.length >= 2);
        const { expected, voices } = await page.evaluate(async () => {
          await window.overlap.audio.dispose();
          return { expected: window.overlap.expected, voices: window.overlap.voices };
        });
        assert.deepEqual(voices.toSorted(), expected.toSorted());
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(
    `${name}: waits for an activating touch before resuming Web Audio`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({ hasTouch: true, isMobile: true });
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio({ html5PoolSize: 0 });
          const output = audio.getOutput();
          const { context } = output;
          await context.suspend();
          const resume = context.resume.bind(context);
          const result = { audio, resumes: 0 };
          window.touch = result;
          context.resume = () => {
            result.resumes++;
            return resume();
          };
          document.addEventListener(
            'touchstart',
            () => {
              result.start = {
                active: navigator.userActivation?.isActive,
                resumes: result.resumes,
              };
            },
            true,
          );
          document.addEventListener(
            'touchend',
            () => {
              result.end = { resumes: result.resumes };
            },
            true,
          );
        });
        await page.getByRole('button').tap();
        const { end, start } = await page.evaluate(async () => {
          const { audio, end, start } = window.touch;
          await audio.dispose();
          return { end, start };
        });
        assert.ok(start);
        if (start.active === false) {
          assert.equal(start.resumes, 0);
        }
        assert.deepEqual(end, { resumes: 1 });
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of engines) {
  test(
    `${name}: shares in-flight audio until the last sound unloads`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        const result = await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio();
          const originalFetch = window.fetch;
          let requests = 0;
          window.fetch = (source, options) => {
            if (String(source).endsWith('/sound.wav?shared')) {
              requests++;
            }
            return originalFetch(source, options);
          };
          const first = audio.sound({ src: '/sound.wav?shared' });
          const loaded = Promise.withResolvers();
          const second = audio.sound({
            onload: loaded.resolve,
            onloaderror: (_, error) => loaded.reject(error),
            src: '/sound.wav?shared',
          });
          first.unload();
          await loaded.promise;
          const whileShared = requests;
          second.unload();

          const reloaded = Promise.withResolvers();
          audio.sound({
            onload: reloaded.resolve,
            onloaderror: (_, error) => reloaded.reject(error),
            src: '/sound.wav?shared',
          });
          await reloaded.promise;
          await audio.dispose();
          return { afterUnload: requests, whileShared };
        });
        assert.deepEqual(result, { afterUnload: 2, whileShared: 1 });
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of engines) {
  test(
    `${name}: supports per-voice events and live spatial updates`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio();
          const { context } = audio.getOutput();
          const createSource = context.createBufferSource.bind(context);
          const events = { starts: 0 };
          context.createBufferSource = () => {
            events.starts++;
            return createSource();
          };
          const sound = audio.sound({
            sprite: { moving: [1000, 3000] },
            src: '/sound.wav',
          });
          window.voices = { audio, events, sound };
          document.querySelector('button').addEventListener('click', () => {
            const voice = sound.play('moving');
            sound.once(
              'play',
              () => {
                sound.stereo(-0.5, voice);
                sound.pos(1, 0, -0.5, voice);
                sound.rate(2, voice);
                sound.once(
                  'fade',
                  () => {
                    sound.pause(voice);
                    const position = sound.position(voice);
                    events.played = position >= 1 && position < 4;
                    events.paused = !sound.playing(voice);
                    events.volume = sound.volume(voice);
                  },
                  voice,
                );
                sound.fade(1, 0.25, 60, voice);
              },
              voice,
            );
          });
        });
        await page.waitForFunction(() => window.voices.sound.state() === 'loaded');
        await page.getByRole('button').click();
        await page.waitForFunction(() => 'played' in window.voices.events);
        const result = await page.evaluate(async () => {
          const { audio, events } = window.voices;
          await audio.dispose();
          return events;
        });
        assert.deepEqual(result, { paused: true, played: true, starts: 1, volume: 0.25 });
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(
    `${name}: prepares native media voices on the first gesture`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio({ html5PoolSize: 2 });
          const ids = [];
          const errors = [];
          const sound = audio.sound({
            html5: true,
            onplay: (id) => ids.push(id),
            onplayerror: (_, error) => errors.push(String(error)),
            src: '/sound.wav',
          });
          window.mediaVoices = { audio, errors, ids, sound };
        });
        await page.waitForFunction(() => window.mediaVoices.sound.state() === 'loaded');
        await page.getByRole('button').click();
        const expected = await page.evaluate(() => {
          const { sound } = window.mediaVoices;
          return [sound.play(), sound.play()];
        });
        await page.waitForFunction(
          () => window.mediaVoices.ids.length === 2 || window.mediaVoices.errors.length > 0,
        );
        const { errors, ids } = await page.evaluate(async () => {
          const { audio, errors, ids } = window.mediaVoices;
          await audio.dispose();
          return { errors, ids };
        });
        assert.deepEqual(errors, []);
        assert.deepEqual(ids.toSorted(), expected.toSorted());
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of engines) {
  test(
    `${name}: preserves a preloaded fade-in and completes a replaced fade`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio();
          const { context } = audio.getOutput();
          const createGain = context.createGain.bind(context);
          const report = { fades: 0 };
          context.createGain = () => {
            const node = createGain();
            report.gain = node.gain;
            return node;
          };
          const sound = audio.sound({
            loop: true,
            onfade: () => report.fades++,
            src: '/sound.wav',
          });
          window.fadeAudit = { audio, report, sound };
          document.querySelector('button').addEventListener('click', () => {
            sound.fade(0, 0.6, 100);
            report.voice = sound.play();
          });
        });
        await page.waitForFunction(() => window.fadeAudit.sound.state() === 'loaded');
        await page.getByRole('button').click();
        await page.waitForFunction(() => window.fadeAudit.report.fades === 1, undefined, {
          timeout: 3000,
        });
        const fadeIn = await page.evaluate(() => {
          const { report, sound } = window.fadeAudit;
          return {
            gain: report.gain.value,
            group: sound.volume(),
            voice: sound.volume(report.voice),
          };
        });
        for (const volume of Object.values(fadeIn)) {
          assert.ok(Math.abs(volume - 0.6) < 0.001, JSON.stringify(fadeIn));
        }

        await page.evaluate(() => {
          const { report, sound } = window.fadeAudit;
          sound.fade(0.6, 0, 1000);
          sound.once('fade', () => sound.stop(), report.voice);
          sound.volume(0.35);
        });
        await page.waitForFunction(
          () => window.fadeAudit.report.fades === 2 && !window.fadeAudit.sound.playing(),
        );
        await page.evaluate(() => window.fadeAudit.audio.dispose());
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of engines) {
  test(
    `${name}: applies loop changes before a queued voice starts`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const audio = createAudio({ autoSuspend: false });
          const { context } = audio.getOutput();
          const sound = audio.sound({ sprite: { note: [100, 300] }, src: '/sound.wav' });
          const resume = context.resume.bind(context);
          const pending = Promise.withResolvers();
          await context.suspend();
          context.resume = () => pending.promise;
          const loops = [];
          const createSource = context.createBufferSource.bind(context);
          context.createBufferSource = () => {
            const source = createSource();
            const start = source.start.bind(source);
            source.start = (...args) => {
              loops.push(source.loop);
              start(...args);
            };
            return source;
          };
          window.loopAudit = { audio, loops, sound };
          document.querySelector('button').addEventListener('click', () => {
            resume().then(pending.resolve, pending.reject);
          });
        });
        await page.waitForFunction(() => window.loopAudit.sound.state() === 'loaded');
        await page.evaluate(() => {
          const { sound } = window.loopAudit;
          const voice = sound.play('note');
          sound.loop(true, voice);
        });
        await page.getByRole('button').click();
        await page.waitForFunction(() => window.loopAudit.loops.length === 1);
        const loops = await page.evaluate(async () => {
          const { audio, loops } = window.loopAudit;
          await audio.dispose();
          return loops;
        });
        assert.deepEqual(loops, [true]);
      } finally {
        await browser.close();
      }
    },
  );
}

for (const [name, engine] of engines) {
  test(
    `${name}: falls back at the last audible frame when a buffered block misses its deadline`,
    { timeout: 15_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(async () => {
          const { createAudio } = await import('/audio.js');
          const { createBufferedMusic } = await import('/music.js');
          const audio = createAudio();
          const { context } = audio.getOutput();
          const { sampleRate } = context;
          const blockFrames = sampleRate / 4;
          const pcm = [new Float32Array(blockFrames)];
          const delayed = Promise.withResolvers();
          const report = { failures: 0, plays: 0, reads: 0, releases: 0 };
          let clock = 0;
          Object.defineProperty(context, 'currentTime', { get: () => clock });
          const timeout = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) =>
            timeout(callback, delay === 10 ? 60_000 : delay, ...args);

          const track = createBufferedMusic(
            audio,
            {
              blockFrames,
              async open() {
                return {
                  close() {
                    report.releases++;
                  },
                  duration: 1,
                  async read() {
                    return ++report.reads === 1 ? pcm : delayed.promise;
                  },
                };
              },
              sampleRate,
            },
            {
              onFailure() {
                report.failures++;
                report.position = track.position();
                track.unload();
              },
              onPlay() {
                report.plays++;
              },
            },
          );

          window.musicAudit = {
            audio,
            missDeadline() {
              clock = 0.31 + 0.5 / sampleRate;
              delayed.resolve(pcm);
            },
            report,
            track,
          };
          document.querySelector('button').addEventListener('click', () => track.play());
        });
        await page.getByRole('button').click();
        await page.waitForFunction(() => window.musicAudit.report.reads === 2);
        await page.evaluate(() => window.musicAudit.missDeadline());
        await page.waitForFunction(() => window.musicAudit.report.failures === 1);
        const result = await page.evaluate(async () => {
          const { audio, report, track } = window.musicAudit;
          await audio.dispose();
          return { ...report, playing: track.playing() };
        });
        assert.deepEqual(result, {
          failures: 1,
          playing: false,
          plays: 0,
          position: 0.25,
          reads: 2,
          releases: 1,
        });
      } finally {
        await browser.close();
      }
    },
  );
}

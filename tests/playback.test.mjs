import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';

const audio = await readFile(new URL('./audio/sound1.wav', import.meta.url));
const server = createServer((request, response) => {
  if (request.url.startsWith('/sound.wav')) {
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
  test(`${name}: plays Web Audio and HTML media from one gesture`, { timeout: 15_000 }, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);
      await page.addScriptTag({ path: 'dist/audio.js' });
      await page.evaluate(() => {
        const { Audio, Sound } = window.NkzwAudio;
        if (typeof Sound.prototype.stereo !== 'function') {
          throw new Error('Spatial playback is unavailable.');
        }
        Audio.volume(0);
        window.playback = {};
        document.querySelector('button').addEventListener('click', () => {
          for (const html5 of [false, true]) {
            const name = html5 ? 'html' : 'web';
            const sound = new Sound({ src: ['/sound.wav?' + name], html5, preload: false });
            sound.on('loaderror', (_, error) => { window.playback[name] = String(error); });
            sound.on('playerror', (_, error) => { window.playback[name] = String(error); });
            sound.on('play', (id) => {
              window.playback[name] = sound.playing(id) && sound.duration(id) > 0;
              sound.stop(id);
              sound.unload();
            });
            sound.load();
            sound.play();
          }
        }, { once: true });
      });
      await page.getByRole('button').click();
      await page.waitForFunction(() => Object.keys(window.playback).length === 2);
      assert.deepEqual(await page.evaluate(() => window.playback), { html: true, web: true });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

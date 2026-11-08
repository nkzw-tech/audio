import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite-plus';

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null },
});
await server.listen();
const [origin] = server.resolvedUrls.local;
test.after(() => server.close());

const radioTrack = await readFile(new URL('./audio/sound2.mp3', import.meta.url));

async function serveRadio(route) {
  const range = route
    .request()
    .headers()
    .range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2]
    ? Math.min(Number(range[2]), radioTrack.length - 1)
    : radioTrack.length - 1;
  await route.fulfill({
    body: radioTrack.subarray(start, end + 1),
    contentType: 'audio/mpeg',
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${radioTrack.length}` } : {}),
    },
    status: range ? 206 : 200,
  });
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(
    `${name}: runs the audio examples through the built package`,
    { timeout: 35_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({ viewport: { height: 800, width: 1200 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(() => {
          window.demoStarts = 0;
          window.radioStarts = 0;
          const start = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function (...args) {
            if (this.buffer?.duration > 1) {
              window.demoStarts++;
            }
            return start.apply(this, args);
          };
          const play = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = async function () {
            await play.call(this);
            if (this.src.includes('bbc_radio_one')) {
              window.radioStarts++;
            }
          };
        });

        await page.goto(new URL('examples/', origin).href);
        await page.getByRole('link', { name: 'Audio player' }).click();
        await page.locator('#playBtn').click();
        await page.waitForFunction(
          () => Number.parseFloat(document.querySelector('#progress').style.width) > 0,
        );
        await page.locator('#pauseBtn').click();
        await page.locator('#playBtn').waitFor({ state: 'visible' });
        await page.locator('#nextBtn').click();
        await page.waitForFunction(() =>
          document.querySelector('#track').textContent.includes('80s Vibe'),
        );

        await page.goto(new URL('examples/sprite/', origin).href);
        await page.locator('#sprite5').click();
        await page.waitForFunction(
          () => window.demoStarts === 1 && document.querySelector('#sprite5 .progress'),
        );

        await page.goto(new URL('examples/3d/', origin).href);
        await page.locator('canvas').click();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(
          () => window.demoStarts >= 2 && document.querySelector('canvas').width > 1,
        );

        await page.route('https://stream.live.vc.bbcmedia.co.uk/**', serveRadio);
        await page.goto(new URL('examples/radio/', origin).href);
        await page.locator('#station0').click();
        await page.waitForFunction(() => window.radioStarts === 1);
        await page.locator('#station0').click();
        await page.locator('#playing0').waitFor({ state: 'hidden' });
        await page.locator('#station0').click();
        await page.waitForFunction(() => window.radioStarts === 2);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    },
  );

  test(
    `${name}: starts each manual audio test from the examples index`,
    { timeout: 25_000 },
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        for (const label of ['RUN WEB AUDIO TESTS', 'RUN HTML5 TESTS', 'RUN SPATIAL TESTS']) {
          await page.goto(new URL('examples/', origin).href);
          await page.getByRole('link', { name: 'Manual playback tests' }).click();
          await page.getByRole('button', { name: label }).click();
          await page.getByRole('button', { name: /^BEGIN/ }).click();
          await page.getByText('PLAYING', { exact: true }).waitFor();
        }
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    },
  );
}

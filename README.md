# @nkzw/audio

> [!NOTE]
> This project is a fork of [Howler.js](https://github.com/goldfire/howler.js), based on version 2.2.4.

Cross-platform sound playback for the web with Web Audio, HTML media fallback, and spatial audio.

```sh
pnpm add @nkzw/audio
```

```ts
import { createAudio } from '@nkzw/audio';

const audio = createAudio();
const sound = audio.sound({ src: ['/effects.ogg', '/effects.mp3'] });

playButton.addEventListener('click', () => sound.play());
```

Create one audio instance per mixer. It owns its audio context, decoded-sound cache, master volume, and playback lifecycle. Creating a sound preloads it by default, so effects can be prepared before gameplay. Use `{ html5: true }` for native media playback or `{ preload: false }` to load explicitly. Call `sound.unload()` when an asset is no longer needed and `await audio.dispose()` to shut down the mixer.

Sounds support overlapping playback, sprites, pause and resume, looping, fades, seeking, rate, and spatial controls. `play()` returns a playback ID that you can pass to methods such as `pause(id)` or `stop(id)` to control one voice.

```ts
const effects = audio.sound({
  src: '/effects.wav',
  sprite: { impact: [0, 300], move: [300, 250] },
});

const voice = effects.play('impact');
if (voice !== null) {
  effects.volume(0.5, voice);
}
```

Call playback from a user gesture when starting audio for the first time. `audio.getOutput()` exposes the instance's Web Audio context and master gain for applications that schedule their own sources. Call `retain()` on that output while using external sources and invoke the returned release function when they stop.

Both ES modules and CommonJS are supported.

## Buffered music

Import `@nkzw/audio/music` to play long looping tracks with bounded decoded PCM. The default 30-second window holds about 11 MiB of stereo PCM at 48 kHz, plus the compressed track and small decoder buffers. Music shares the mixer's master gain and audio context with sound effects. The application chooses which tracks to buffer and when to crossfade or fall back.

The included WebCodecs adapter reads 48 kHz stereo AAC-LC in ADTS. Provide the encoder's leading priming and, if applicable, trailing padding in frames. Use a module worker entry in your application so the bundler can emit its URL.

```ts
// music-worker.ts
import '@nkzw/audio/music/worker';
```

```ts
import { createAdtsMusicSource, createBufferedMusic } from '@nkzw/audio/music';

const track = createBufferedMusic(
  audio,
  createAdtsMusicSource({
    createWorker: () =>
      new Worker(new URL('./music-worker.ts', import.meta.url), { type: 'module' }),
    primingFrames: 2112, // Use the trim for your own encoder.
    src: '/music.aac',
  }),
  {
    onFailure() {
      const seconds = track?.position() ?? 0;
      startFallback(seconds);
    },
  },
);

if (track) {
  track.fade(0, 1, 250);
  playButton.addEventListener('click', () => track.play());
} else {
  playButton.addEventListener('click', () => startFallback(0));
}
```

The scheduler returns `null` when Web Audio is unavailable or the output and source sample rates differ. Decoder, fetch, and underrun errors go through `onFailure`. Use `position()` to resume a fallback, and unload the buffered track once it is no longer needed. `pause()` keeps the bounded buffer for a quick resume, while `unload()` terminates the reader and releases the decoded blocks. Both buffered tracks and regular sounds expose a numeric `position()` in seconds.

For another codec or asset layout, provide a `MusicSource` whose reader returns consecutive planar PCM blocks and wraps at the exact loop boundary. `duration` is the loop length in seconds. The scheduler reads one block at a time and passes an abort signal to the source.

## Development

```sh
vp install
vp exec playwright install chromium webkit
vp check
vp run test
```

## License

Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
Copyright (c) 2026 Nakazawa Tech.

Released under the [MIT License](./LICENSE.md).

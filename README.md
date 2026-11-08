# @nkzw/audio

> [!NOTE]
> This project is a fork of [Howler.js](https://github.com/goldfire/howler.js), based on version 2.2.4.

**_audio_** is a modern audio library for the web. It combines preloaded sound effects, spatial audio, and bounded music playback in a typed JavaScript API.

### Features

- **Mixers.** Create a mixer with its own audio context, decoded-sound cache, and master volume. Sounds and music can share a mixer.
- **Sound Effects.** Preload effects so they're ready to play, play several voices from the same asset, and control each voice by its playback ID.
- **Audio Sprites.** Define named regions in a single audio file and play them independently.
- **Spatial Audio.** Pan a sound in stereo or position it in 3D relative to a listener.
- **HTML Media.** Play live streams or long files through the browser's media element. The mixer also falls back to HTML media when Web Audio is unavailable.
- **Buffered Music.** Decode looping music in blocks and schedule them on the Web Audio clock. The amount of decoded audio in memory stays bounded as track length increases.

### Audio for games and interactive apps

We built _audio_ out of our work on [Athena Crisis](https://athenacrisis.com). A sound effect should play as soon as a unit moves or attacks, which makes it worth loading and decoding effects ahead of time. Music has a different tradeoff. A track can run for several minutes, and its decoded audio can take up much more memory than the file you downloaded.

_audio_ gives these two jobs separate APIs. Use `@nkzw/audio` for effects and ordinary playback, and add `@nkzw/audio/music` when you want to buffer music. They can use the same mixer, so one master volume controls both. Your application decides what to preload, when to switch tracks, and how to fall back.

## Getting Started

Install `@nkzw/audio` in your project. The package supports ES modules and CommonJS.

```bash
pnpm add @nkzw/audio
```

Let's create a mixer and play a sound when the user presses a button.

```ts
import { createAudio } from '@nkzw/audio';

const audio = createAudio();
const confirm = audio.sound({ src: ['/sounds/confirm.ogg', '/sounds/confirm.mp3'] });

document.querySelector('#play')?.addEventListener('click', () => confirm.play());
```

The sound starts loading when you create it. The mixer picks the first source the browser supports. Start playback from a user gesture to satisfy the browser's audio activation policy.

## Core Concepts

### Mixers, Sounds, and Voices

A mixer owns the audio context and master volume. Use `audio.sound()` to create a sound from one or more sources. Set `preload: false` and call `sound.load()` if you want to decide when loading starts. For a live stream or a file you want the browser to stream, set `html5: true`.

A sound can play more than once at the same time. Each playback has its own ID, so you can change the volume, rate, or position of one voice while the others keep playing.

### Playing Audio Sprites

Let's put two effects in the same file. Each sprite defines a start offset and a duration in milliseconds.

```ts
const effects = audio.sound({
  sprite: {
    impact: [0, 300],
    move: [300, 250],
  },
  src: '/sounds/effects.wav',
});

const voice = effects.play('impact');
if (voice != null) {
  effects.volume(0.5, voice);
}
```

Pass the ID to `pause(voice)`, `play(voice)`, or `stop(voice)` to control that playback. `position(voice)` returns its current position in seconds.

### Managing Audio Resources

Call `sound.unload()` when you're done with a sound and `await audio.dispose()` when you're done with the mixer.

If you schedule your own Web Audio nodes, `audio.getOutput()` gives you the context and master gain. Call `retain()` on the output while your nodes need the context to stay active, and call the returned release function when they stop.

## Buffered Music

### Playing a Loop

The default buffer holds 30 seconds of decoded audio, or about 11 MiB of stereo PCM at 48 kHz. The AAC worker also keeps the compressed track and a small decoder buffer. You can set `bufferSeconds` when creating a track.

The included WebCodecs adapter reads 48 kHz stereo AAC-LC in ADTS. Give it the leading priming frames and any trailing padding from your encoder. In a bundled application, create a module worker entry so your bundler can emit the worker URL.

```ts
// music-worker.ts
import '@nkzw/audio/music/worker';
```

Use the same mixer you created for your sound effects. The example takes a `startFallback` function from your application so you can choose how to play the track if buffered playback is unavailable.

```ts
import type { Audio } from '@nkzw/audio';
import { createAdtsMusicSource, createBufferedMusic } from '@nkzw/audio/music';

export function setupMusic(
  audio: Audio,
  button: HTMLButtonElement,
  startFallback: (seconds: number) => void,
) {
  const track = createBufferedMusic(
    audio,
    createAdtsMusicSource({
      createWorker: () =>
        new Worker(new URL('./music-worker.ts', import.meta.url), { type: 'module' }),
      primingFrames: 2112,
      src: '/music.aac',
    }),
    {
      onFailure() {
        const position = track?.position() ?? 0;
        track?.unload();
        startFallback(position);
      },
    },
  );

  track?.fade(0, 1, 250);
  button.addEventListener(
    'click',
    () => {
      if (track) {
        track.play();
      } else {
        startFallback(0);
      }
    },
    { once: true },
  );
}
```

The value `2112` is an example. Use the trim values for the file you encoded. `createBufferedMusic()` returns `null` when Web Audio is unavailable or the output and source sample rates differ. Decoder, fetch, and underrun errors go through `onFailure`. Read `position()` before unloading if you want to resume the track with a fallback.

Use `pause()` to keep the buffer for a quick resume. Use `unload()` to close the reader and release the decoded blocks.

### Using Your Own Music Source

For another codec or asset layout, provide a `MusicSource`. Its reader returns consecutive planar PCM blocks and wraps at the loop boundary. Set `duration` to the loop length in seconds. The scheduler reads one block at a time and passes an abort signal to the source.

## Examples

Run `vp run dev` from the repository root to build the package and open the [examples](./examples/). You can try the audio player, live radio, spatial audio, and sprites, or run the manual Web Audio, HTML media, and spatial playback tests.

## Development

```bash
vp install
vp exec playwright install chromium firefox webkit
vp check
vp run test
```

## Acknowledgements

_audio_ builds on [Howler.js](https://github.com/goldfire/howler.js) by James Simpson and GoldFire Studios, Inc. It is maintained by [Nakazawa Tech](https://nakazawa.tech/) and released under the [MIT License](./LICENSE.md).

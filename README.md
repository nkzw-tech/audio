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

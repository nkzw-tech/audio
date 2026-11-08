/*!
 *  @nkzw/audio 3D Sound Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

/**
 * Setup and control all of the game's audio.
 */
export function GameAudio(audio) {
  // Setup the shared Sound.
  this.sound = audio.sound({
    sprite: {
      lightning: [2000, 4147],
      music: [34_000, 31_994, true],
      rain: [8000, 9962, true],
      thunder: [19_000, 13_858],
    },
    src: ['./assets/sprite.webm', './assets/sprite.mp3'],
    volume: 0,
  });

  // Begin playing background sounds.
  this.rain();
  this.thunder();
}
GameAudio.prototype = {
  /**
   * Play a rain loop in the background.
   */
  rain() {
    this._rain = this.sound.play('rain');
    this.sound.volume(0.2, this._rain);
  },

  /**
   * Randomly play thunder sounds periodically.
   */
  thunder() {
    setTimeout(
      () => {
        // Play the thunder sound in a random position.
        const x = Math.round(100 * (2 - Math.random() * 4)) / 100;
        const y = Math.round(100 * (2 - Math.random() * 4)) / 100;
        this._thunder = this.sound.play('thunder');
        this.sound.pos(x, y, -0.5, this._thunder);
        this.sound.volume(1, this._thunder);

        // Schedule the next clap.
        this.thunder();
      },
      5000 + Math.round(Math.random() * 15_000),
    );
  },

  /**
   * Play lightning in a random location with a random rate/pitch.
   */
  lightning() {
    const x = Math.round(100 * (2.5 - Math.random() * 5)) / 100;
    const y = Math.round(100 * (2.5 - Math.random() * 5)) / 100;
    const rate = Math.round(100 * (0.4 + Math.random() * 1.25)) / 100;

    // Play the lightning sound.
    const id = this.sound.play('lightning');

    // Change the position and rate.
    this.sound.pos(x, y, -0.5, id);
    this.sound.rate(rate, id);
    this.sound.volume(1, id);
  },

  /**
   * Setup a speaker in 3D space to play music from.
   * @param  {Number} x x-tile position of speaker.
   * @param  {Number} y y-tile position of speaker.
   */
  speaker(x, y) {
    const soundId = this.sound.play('music');
    this.sound.once(
      'play',
      () => {
        // Set the position of the speaker in 3D space.
        this.sound.pos(x + 0.5, y + 0.5, -0.5, soundId);
        this.sound.volume(1, soundId);

        // Tweak the attributes to get the desired effect.
        this.sound.pannerAttr(
          {
            distanceModel: 'exponential',
            panningModel: 'HRTF',
            refDistance: 0.8,
            rolloffFactor: 2.5,
          },
          soundId,
        );
      },
      soundId,
    );
  },
};

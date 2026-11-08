/*!
 *  @nkzw/audio Audio Sprite Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

import { createAudio } from '../../lib/index.js';

const audio = createAudio();

// Cache references to DOM elements.
/**
 * Sprite class containing the state of our sprites to play and their progress.
 * @param {Object} options Settings to pass into and setup the sound and visuals.
 */
const Sprite = function (options) {
  const self = this;

  self.sounds = [];

  // Setup the options to define this sprite display.
  self._width = options.width;
  self._left = options.left;
  self._spriteMap = options.spriteMap;
  self._sprite = options.sprite;
  self.setupListeners();

  // Create our audio sprite definition.
  self.sound = audio.sound({
    sprite: options.sprite,
    src: options.src,
  });

  // Setup a resize event and fire it to setup our sprite overlays.
  window.addEventListener(
    'resize',
    () => {
      self.resize();
    },
    false,
  );
  self.resize();

  // Begin the progress step tick.
  requestAnimationFrame(self.step.bind(self));
};
Sprite.prototype = {
  /**
   * Setup the listeners for each sprite click area.
   */
  setupListeners() {
    const self = this;
    const keys = Object.keys(self._spriteMap);

    keys.forEach((key) => {
      document.getElementById(key).addEventListener(
        'click',
        () => {
          self.play(key);
        },
        false,
      );
    });
  },

  /**
   * Play a sprite when clicked and track the progress.
   * @param  {String} key Key in the sprite map object.
   */
  play(key) {
    const self = this;
    const sprite = self._spriteMap[key];

    // Play the sprite sound and capture the ID.
    const id = self.sound.play(sprite);

    // Create a progress element and begin visually tracking it.
    const elm = document.createElement('div');
    elm.className = 'progress';
    elm.id = id;
    elm.dataset.sprite = sprite;
    document.getElementById(key).append(elm);
    self.sounds.push(elm);

    // When this sound is finished, remove the progress element.
    self.sound.once(
      'end',
      () => {
        const index = self.sounds.indexOf(elm);
        if (index >= 0) {
          self.sounds.splice(index, 1);
          document.getElementById(key).removeChild(elm);
        }
      },
      id,
    );
  },

  /**
   * Called on window resize to correctly position and size the click overlays.
   */
  resize() {
    const self = this;

    // Calculate the scale of our window from "full" size.
    const scale = window.innerWidth / 3600;

    // Resize and reposition the sprite overlays.
    const keys = Object.keys(self._spriteMap);
    for (let i = 0; i < keys.length; i++) {
      const sprite = document.getElementById(keys[i]);
      sprite.style.width = Math.round(self._width[i] * scale) + 'px';
      if (self._left[i]) {
        sprite.style.left = Math.round(self._left[i] * scale) + 'px';
      }
    }
  },

  /**
   * The step called within requestAnimationFrame to update the playback positions.
   */
  step() {
    const self = this;

    // Loop through all active sounds and update their progress bar.
    for (let i = 0; i < self.sounds.length; i++) {
      const id = Number.parseInt(self.sounds[i].id, 10);
      const offset = self._sprite[self.sounds[i].dataset.sprite][0];
      const seek = self.sound.position(id) - offset / 1000;
      self.sounds[i].style.width = ((seek / self.sound.duration(id)) * 100 || 0) + '%';
    }

    requestAnimationFrame(self.step.bind(self));
  },
};

// Setup our new sprite class and pass in the options.
new Sprite({
  left: [0, 342, 680, 1022, 1361],
  sprite: {
    beat: [10_000, 11_163],
    five: [8000, 340],
    four: [6000, 380],
    one: [0, 450],
    three: [4000, 350],
    two: [2000, 250],
  },
  spriteMap: {
    sprite0: 'one',
    sprite1: 'two',
    sprite2: 'three',
    sprite3: 'four',
    sprite4: 'five',
    sprite5: 'beat',
  },
  src: ['../../tests/audio/sound2.webm', '../../tests/audio/sound2.mp3'],
  width: [78, 60, 62, 70, 62, 1895],
});

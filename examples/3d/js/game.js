/*!
 *  @nkzw/audio 3D Sound Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

import { createAudio } from '../../../dist/index.js';
import { Camera } from './camera.js';
import { Controls } from './controls.js';
import { Scene } from './map.js';
import { Player } from './player.js';
import { GameAudio } from './sound.js';

// Cache some commonly used values.
const isMobile = /iPhone|iPad|iPod|Android|BlackBerry|BB10|Silk/i.test(navigator.userAgent);
const canvas = document.getElementById('canvas');

/**
 * Main game class that runs the tick and sets up all other components.
 */
const Game = function () {
  this.lastTime = 0;

  // Setup our different game components.
  const audio = createAudio();
  this.audio = new GameAudio(audio);
  this.player = new Player(this, audio, 10, 26, Math.PI * 1.9, 2.5);
  this.controls = new Controls();
  this.map = new Scene(25, this.audio);
  this.camera = new Camera(this, canvas, isMobile);

  requestAnimationFrame(this.tick.bind(this));
};
Game.prototype = {
  /**
   * Main game loop that renders the full scene on each screen refresh.
   * @param  {Number} time
   */
  tick(time) {
    const ms = time - this.lastTime;
    this.lastTime = time;

    // Update the different components of the scene.
    this.map.update(ms / 1000);
    this.player.update(ms / 1000);
    this.camera.render();

    // Continue the game loop.
    requestAnimationFrame(this.tick.bind(this));
  },
};

// Setup and start the new game instance.
const game = new Game();

// Generate the new map.
game.map.setup();

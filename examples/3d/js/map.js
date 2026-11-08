/*!
 *  @nkzw/audio 3D Sound Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

import { Texture } from './texture.js';

/**
 * Generates the map and calculates the casting of arrays for the camera to display on screen.
 * @param {Number} size Grid size of the map to use.
 */
export function Scene(size, audio) {
  this.audio = audio;
  this.size = size;
  this.grid = new Array(size * size);
  this.skybox = new Texture('./assets/skybox.jpg', 4096, 1024);
  this.wall = new Texture('./assets/wall.jpg', 1024, 1024);
  this.speaker = new Texture('./assets/speaker.jpg', 1024, 1024);
  this.light = 0;

  // Define the pre-defined map template on a 25x25 grid.
  this.grid = [
    1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 0, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1,
    1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
    1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1,
    1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0,
    1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1,
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2,
    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0,
    0, 2, 2, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0,
    1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1,
    0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1,
    0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1,
    1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1,
    1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1,
  ];
}
Scene.prototype = {
  /**
   * Sets up the map including the speaker audio points.
   */
  setup() {
    // Loop through the tiles and setup the audio listeners.
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === 2) {
        const y = Math.floor(i / this.size);
        const x = i % this.size;
        this.audio.speaker(x, y);
      }
    }
  },

  /**
   * Check if a gird location is out of bounds, a wall or empty.
   * @param  {Number} x x-coordinate
   * @param  {Number} y y-coordinate
   * @return {Number}   -1, 0, 1
   */
  check(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);

    if (x < 0 || x > this.size - 1 || y < 0 || y > this.size - 1) {
      return -1;
    }

    return this.grid[y * this.size + x];
  },

  /**
   * Emit a ray to beginb uilding the scene.
   * @param  {Number} sin    Sine of the cast angle.
   * @param  {Number} cos    Cosine of the cast angle.
   * @param  {Number} range  Max length of the ray.
   * @param  {Object} origin x, y, height and sitance
   */
  ray(sin, cos, range, origin) {
    const stepX = this.step(sin, cos, origin.x, origin.y, false);
    const stepY = this.step(cos, sin, origin.y, origin.x, true);

    const inspectX = [sin, cos, stepX, 1, 0, origin.dist, stepX.y];
    const inspectY = [sin, cos, stepY, 0, 1, origin.dist, stepY.x];
    const next = this.inspect.apply(this, stepX.len2 < stepY.len2 ? inspectX : inspectY);

    if (next.dist > range) {
      return [origin];
    }

    return [origin].concat(this.ray(sin, cos, range, next));
  },

  /**
   * Processes each step along the ray.
   * @param  {Number} rise     Slope of line: sine of the cast angle.
   * @param  {Number} run      Slope of line: cosine of the cast angle.
   * @param  {Number} x        Origin x-position.
   * @param  {Number} y        Origin y-position.
   * @param  {Boolean} inverted
   */
  step(rise, run, x, y, inverted) {
    if (run === 0) {
      return { len2: Infinity };
    }

    const dx = run > 0 ? Math.floor(x + 1) - x : Math.ceil(x - 1) - x;
    const dy = dx * (rise / run);

    return {
      len2: dx * dx + dy * dy,
      x: inverted ? y + dy : x + dx,
      y: inverted ? x + dx : y + dy,
    };
  },

  /**
   * Inspect the next position to determine distance, height, shading, etc.
   * @param  {Number} sin    Sine of the cast angle.
   * @param  {Number} cos    Cosine of the cast angle.
   * @param  {Object} step   x, y and length of the step.
   * @param  {Number} shiftX X shifted by 1 or 0.
   * @param  {Number} shiftY Y shifted by 1 or 0.
   * @param  {Number} dist   Distnace from origin.
   * @param  {Number} offset Step offset.
   */
  inspect(sin, cos, step, shiftX, shiftY, dist, offset) {
    const dx = cos < 0 ? shiftX : 0;
    const dy = sin < 0 ? shiftY : 0;

    step.type = this.check(step.x - dx, step.y - dy);
    step.height = step.type > 0 ? 1 : 0;
    step.dist = dist + Math.sqrt(step.len2);

    if (shiftX) {
      step.shading = cos < 0 ? 2 : 0;
    } else {
      step.shading = sin < 0 ? 2 : 1;
    }

    step.offset = offset - Math.floor(offset);

    return step;
  },

  /**
   * Casts a ray from the camera and returns the results.
   * @param  {Object} point Player/camera's x/y position.
   * @param  {Number} angle Angle (in radians) of camera.
   * @param  {Number} range Max length of the ray.
   */
  cast(point, angle, range) {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);

    return this.ray(sin, cos, range, {
      dist: 0,
      height: 0,
      x: point.x,
      y: point.y,
    });
  },

  /**
   * Update loop on the map, in this case used to add in lightning by adjusting global lighting.
   * @param  {Number} secs Seconds since last tick.
   */
  update(secs) {
    if (this.light > 0) {
      this.light = Math.max(this.light - 10 * secs, 0);
    } else if (Math.random() * 6 < secs) {
      this.light = 2;

      // Play the lightning sound.
      this.audio.lightning();
    }
  },
};

/*!
 *  @nkzw/audio 3D Sound Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

/**
 * Camera that draws everything you see on the screen from the player's perspective.
 * @param {Number} resolution Resolution to render at (higher has better quality, but lower performance).
 */
export function Camera(game, canvas, isMobile) {
  this.game = game;
  this.canvas = canvas;
  this.context = canvas.getContext('2d');
  const resolution = isMobile ? 256 : 512;
  this.width = canvas.width = window.innerWidth;
  this.height = canvas.height = window.innerHeight;
  this.resolution = resolution;
  this.spacing = this.width / resolution;
  this.focalLen = this.height / this.width;
  this.range = isMobile ? 9 : 18;
  this.lightRange = 9;
  this.scale = canvas.width / 1200;
}
Camera.prototype = {
  /**
   * Draw the skybox based on the player's direction.
   */
  drawSky() {
    const dir = this.game.player.dir;
    const sky = this.game.map.skybox;
    const ambient = this.game.map.light;
    const width = sky.width * (this.height / sky.height) * 2;
    const left = (dir / (Math.PI * 2)) * -width;

    this.context.save();
    this.context.drawImage(sky.image, left, 0, width, this.height);
    if (left < width - this.width) {
      this.context.drawImage(sky.image, left + width, 0, width, this.height);
    }
    if (ambient > 0) {
      this.context.fillStyle = '#fff';
      this.context.globalAlpha = ambient * 0.1;
      this.context.fillRect(0, this.height * 0.5, this.width, this.height * 0.5);
    }
    this.context.restore();
  },

  /**
   * Based on the resolution, split the scene up and draw it column by column.
   */
  drawCols() {
    let x, angle, ray;

    this.context.save();

    for (let col = 0; col < this.resolution; col++) {
      x = col / this.resolution - 0.5;
      angle = Math.atan2(x, this.focalLen);
      ray = this.game.map.cast(this.game.player, this.game.player.dir + angle, this.range);

      this.drawCol(col, ray, angle);
    }

    this.context.restore();
  },

  /**
   * Draw a single column of the scene.
   * @param  {Number} col   Which column in the sequence.
   * @param  {Array} ray   Ray to follow.
   * @param  {Number} angle Angle of the ray.
   */
  drawCol(col, ray, angle) {
    let step, drops, rain, texX, wall;
    const tex1 = this.game.map.wall;
    const tex2 = this.game.map.speaker;
    const left = Math.floor(col * this.spacing);
    const width = Math.ceil(this.spacing);
    let hit = -1;

    // Find the next wall hit.
    while (hit + 1 < ray.length && ray[hit + 1].height <= 0) {
      hit++;
    }
    hit++;

    // Draw the wall sections and rain drops.
    for (let i = ray.length - 1; i >= 0; i--) {
      step = ray[i];
      drops = Math.pow(Math.random(), 100) * i;
      rain = drops > 0 && this.project(0.2, angle, step.dist);

      const tex = step.type === 1 ? tex1 : tex2;

      if (i === hit) {
        texX = Math.floor(tex.width * step.offset);
        wall = this.project(step.height, angle, step.dist);

        this.context.globalAlpha = 1;
        this.context.drawImage(
          tex.image,
          texX,
          0,
          1,
          tex.height,
          left,
          wall.top,
          width,
          wall.height,
        );

        this.context.fillStyle = '#000';
        this.context.globalAlpha = Math.max(
          (step.dist + step.shading) / this.lightRange - this.game.map.light,
          0,
        );
        this.context.fillRect(left, wall.top, width, wall.height);
      }

      this.context.fillStyle = '#fff';
      this.context.globalAlpha = 0.15;
      while (--drops > 0) {
        this.context.fillRect(left, Math.random() * rain.top, 1, rain.height);
      }
    }
  },

  /**
   * Draw the hand holding the gun and implement a "bobbing" to simulate walking.
   */
  drawHand() {
    const hand = this.game.player.hand;
    const steps = this.game.player.steps;
    const scaleFactor = this.scale * 6;

    // Calculate the position of each hand relative to the steps taken.
    const xScale = Math.cos(steps * 2);
    const yScale = Math.sin(steps * 4);
    const bobX = xScale * scaleFactor;
    const bobY = yScale * scaleFactor;
    const x = this.canvas.width - hand.width * this.scale + scaleFactor + bobX;
    const y = this.canvas.height - hand.height * this.scale + scaleFactor + bobY;
    const w = hand.width * this.scale;
    const h = hand.height * this.scale;

    this.context.drawImage(hand.image, x, y, w, h);
  },

  /**
   * Based on the angle and distance, determine how we are going to project the image.
   * @param  {Number} height Wall piece height.
   * @param  {Number} angle  Angle of the ray.
   * @param  {Number} dist   Distnace from the player.
   * @return {Object}        top and height
   */
  project(height, angle, dist) {
    const z = dist * Math.cos(angle);
    const wallH = (this.height * height) / z;
    const bottom = (this.height / 2) * (1 + 1 / z);

    return {
      height: wallH,
      top: bottom - wallH,
    };
  },

  /**
   * Render the sky, walls and hand in the correct order.
   */
  render() {
    this.drawSky();
    this.drawCols();
    this.drawHand();
  },
};

/*!
 *  @nkzw/audio 3D Sound Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

/**
 * Load a texture and store its details.
 * @param {String} src Image URL.
 * @param {Number} w   Image width.
 * @param {Number} h   Image height.
 */
export function Texture(src, w, h) {
  this.image = new Image();
  this.image.src = src;
  this.width = w;
  this.height = h;
}

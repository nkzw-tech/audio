/*!
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

export const SampleRate = 48_000;
export const BlockFrames = 2 * SampleRate;

export type DecoderRequest =
  | { paddingFrames: number; primingFrames: number; url: string }
  | { read: true };

export type DecoderResponse =
  | { duration: number }
  | { channels: ReadonlyArray<Float32Array<ArrayBuffer>> }
  | { error: string };

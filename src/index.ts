/*!
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import { createAudio as createEngine } from './audio.core.js';

export const createAudio: (options?: AudioOptions) => Audio = createEngine;

export type AudioOptions = {
  autoSuspend?: boolean;
  html5PoolSize?: number;
};

export type AudioOutput = {
  context: AudioContext;
  destination: GainNode;
  retain(): () => void;
  signal: AbortSignal;
};

export type Audio = {
  codecs(extension: string): boolean;
  dispose(): Promise<void>;
  getOutput(): AudioOutput | null;
  mute(muted: boolean): void;
  orientation(): [number, number, number, number, number, number];
  orientation(x: number, y: number, z: number, upX: number, upY: number, upZ: number): void;
  pos(): Vector;
  pos(x: number, y?: number, z?: number): void;
  sound(options: SoundOptions): Sound;
  stereo(pan: number): void;
  stop(): void;
  volume(): number;
  volume(value: number): void;
};

export type Vector = [x: number, y: number, z: number];

export type SoundEvent =
  | 'end'
  | 'fade'
  | 'load'
  | 'loaderror'
  | 'mute'
  | 'orientation'
  | 'pause'
  | 'play'
  | 'playerror'
  | 'pos'
  | 'rate'
  | 'seek'
  | 'stereo'
  | 'stop'
  | 'unlock'
  | 'volume';

export type SoundListener = (id: number | null | undefined, detail?: unknown) => void;

export type SoundOptions = {
  autoplay?: boolean;
  format?: string | ReadonlyArray<string>;
  html5?: boolean;
  loop?: boolean;
  mute?: boolean;
  orientation?: Vector;
  pool?: number;
  pos?: Vector;
  preload?: boolean | 'metadata';
  rate?: number;
  sprite?: Readonly<Record<string, readonly [start: number, length: number, loop?: boolean]>>;
  src: string | ReadonlyArray<string>;
  stereo?: number;
  volume?: number;
  xhr?: { headers?: Readonly<Record<string, string>>; method?: string; withCredentials?: boolean };
} & { [Event in SoundEvent as `on${Event}`]?: SoundListener } & PannerOptions;

export type Sound = {
  duration(id?: number): number;
  fade(from: number, to: number, duration: number, id?: number): Sound;
  load(): Sound | undefined;
  loop(): boolean;
  loop(id: number): boolean;
  loop(value: boolean, id?: number): Sound;
  mute(muted: boolean, id?: number): Sound;
  off(event?: SoundEvent, listener?: SoundListener | number, id?: number): Sound;
  on(event: SoundEvent, listener: SoundListener, id?: number): Sound;
  once(event: SoundEvent, listener: SoundListener, id?: number): Sound;
  orientation(): Sound | Vector;
  orientation(x: number, y?: number, z?: number, id?: number): Sound;
  pannerAttr(): PannerOptions;
  pannerAttr(id: number): PannerOptions;
  pannerAttr(options: PannerOptions, id?: number): Sound;
  pause(id?: number): Sound;
  play(spriteOrId?: string | number): number | null | undefined;
  playing(id?: number): boolean;
  pos(): Sound | Vector | null;
  pos(x: number, y?: number, z?: number, id?: number): Sound;
  position(id?: number): number;
  rate(): number;
  rate(valueOrId: number): Sound | number;
  rate(value: number, id: number): Sound;
  seek(): number;
  seek(valueOrId: number): Sound | number;
  seek(value: number, id: number): Sound;
  state(): 'loaded' | 'loading' | 'unloaded';
  stereo(): Sound | number | null;
  stereo(pan: number, id?: number): Sound;
  stop(id?: number): Sound;
  unload(): null;
  volume(): number;
  volume(valueOrId: number): Sound | number;
  volume(value: number, id: number): Sound;
};

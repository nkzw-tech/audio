/*!
 * Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 * Copyright (c) 2026 Nakazawa Tech
 * SPDX-License-Identifier: MIT
 */

import type { Vector } from './index.ts';

export type SpatialState = {
  attributes: PannerOptions;
  orientation: Vector;
  pan: number | null;
  position: Vector | null;
};

type Panner = { kind: 'stereo'; node: StereoPannerNode } | { kind: 'spatial'; node: PannerNode };

export function setVector(
  parameters: [AudioParam, AudioParam, AudioParam],
  values: Vector,
  time: number,
  transition = 0,
) {
  for (const [index, param] of parameters.entries()) {
    if (transition) {
      param.setTargetAtTime(values[index], time, transition);
    } else {
      param.setValueAtTime(values[index], time);
    }
  }
}

export class SpatialAudio {
  #panner: Panner | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly gain: GainNode,
  ) {}

  get input() {
    return this.#panner?.node ?? this.gain;
  }

  update(
    { attributes, orientation, pan, position }: SpatialState,
    ...sources: ReadonlyArray<AudioBufferSourceNode | null | undefined>
  ) {
    const time = this.context.currentTime;
    if (pan !== null) {
      const node =
        this.#panner?.kind === 'stereo' ? this.#panner.node : this.context.createStereoPanner();
      this.#route({ kind: 'stereo', node }, sources);
      node.pan.setValueAtTime(pan, time);
    } else if (position) {
      const node =
        this.#panner?.kind === 'spatial' ? this.#panner.node : this.context.createPanner();
      this.#route({ kind: 'spatial', node }, sources);
      node.coneInnerAngle = attributes.coneInnerAngle ?? 360;
      node.coneOuterAngle = attributes.coneOuterAngle ?? 360;
      node.coneOuterGain = attributes.coneOuterGain ?? 0;
      node.distanceModel = attributes.distanceModel ?? 'inverse';
      node.maxDistance = attributes.maxDistance ?? 10_000;
      node.panningModel = attributes.panningModel ?? 'HRTF';
      node.refDistance = attributes.refDistance ?? 1;
      node.rolloffFactor = attributes.rolloffFactor ?? 1;
      setVector([node.positionX, node.positionY, node.positionZ], position, time);
      setVector([node.orientationX, node.orientationY, node.orientationZ], orientation, time);
    } else {
      this.#route(null, sources);
    }
  }

  #route(panner: Panner | null, sources: ReadonlyArray<AudioBufferSourceNode | null | undefined>) {
    if (this.#panner?.node !== panner?.node) {
      this.#panner?.node.disconnect();
      this.#panner = panner;
      panner?.node.connect(this.gain);
      for (const source of sources) {
        source?.disconnect();
        source?.connect(this.input);
      }
    }
  }

  dispose() {
    this.#panner?.node.disconnect();
    this.#panner = null;
  }
}

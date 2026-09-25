import { Matrix4, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { FoamDrift } from './foam-drift'
import { createLakeBed, sampleShore } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { Voxel } from './voxel-world'
import { WindModel } from './wind'

const block: Voxel = { x: 0, y: 0.5, z: 0, size: 4, color: 0 }
const bed = createLakeBed([block], 42, true)
const windy = new WindModel(42, { meanSpeed: 8, bearing: 0, gustStrength: 0, turnStrength: 0 })
const calm = new WindModel(42, { meanSpeed: 0, gustStrength: 0, turnStrength: 0 })

const positionsOf = (foam: FoamDrift) => {
  const matrix = new Matrix4(),
    position = new Vector3()
  return Array.from({ length: foam.mesh.count }, (_, i) => {
    foam.mesh.getMatrixAt(i, matrix)
    return position.setFromMatrixPosition(matrix).toArray()
  })
}

const run = (seed: number, seconds: number, hz: number, wind = windy) => {
  const foam = new FoamDrift(new Scene(), bed, seed, true)
  try {
    for (let frame = 0; frame <= seconds * hz; frame++) {
      const time = frame / hz
      foam.update(time, wind.sample(time))
    }
    return positionsOf(foam)
  } finally {
    foam.dispose()
  }
}

describe('foam drift', () => {
  it('drifts patches downwind while keeping them on open water', () => {
    const foam = new FoamDrift(new Scene(), bed, 42, true)
    try {
      const start = positionsOf(foam)
      for (let frame = 1; frame <= 60; frame++) {
        const time = frame / 60
        foam.update(time, windy.sample(time))
      }
      const end = positionsOf(foam)
      const drift = []
      for (const [i, position] of end.entries()) {
        const [x, y, z] = [required(position[0]), required(position[1]), required(position[2])]
        expect(Number.isFinite(x + y + z)).toBe(true)
        expect(sampleShore(bed, x, z)).toBeGreaterThanOrEqual(-0.05)
        drift.push(x - required(required(start[i])[0]))
      }
      drift.sort((a, b) => a - b)
      expect(required(drift[Math.floor(drift.length / 2)])).toBeGreaterThan(0.03)
      expect(run(42, 3, 60)).not.toEqual(run(42, 3, 60, calm))
    } finally {
      foam.dispose()
    }
  })

  it('replays the same drift deterministically', () => {
    const first = run(42, 3, 60)
    expect(run(42, 3, 60)).toEqual(first)
    expect(run(43, 3, 60)).not.toEqual(first)
  })

  it('keeps patch positions stable across frame rates', () => {
    const [slow, medium, fast] = [run(42, 2, 30), run(42, 2, 60), run(42, 2, 120)]
    for (const positions of [medium, fast]) {
      expect(positions).toHaveLength(required(slow).length)
      for (const [i, position] of positions.entries()) {
        const expected = required(required(slow)[i])
        position.forEach((value, axis) =>
          expect(Math.abs(value - required(expected[axis]))).toBeLessThan(1e-9),
        )
      }
    }
  })

  it('parks every patch when the bed holds no water', () => {
    const dry: LakeBed = {
      resolution: 4,
      water: new Uint8Array(16),
      depth: new Float32Array(16),
      obstacle: new Float32Array(16),
      shore: new Float32Array(64).fill(-1),
      stones: [],
    }
    const foam = new FoamDrift(new Scene(), dry, 42, true)
    try {
      for (let frame = 1; frame <= 60; frame++) {
        const time = frame / 60
        foam.update(time, windy.sample(time))
      }
      const matrix = new Matrix4(),
        scale = new Vector3()
      for (let i = 0; i < foam.mesh.count; i++) {
        foam.mesh.getMatrixAt(i, matrix)
        expect(matrix.elements.every(Number.isFinite)).toBe(true)
        expect(scale.setFromMatrixScale(matrix).lengthSq()).toBe(0)
      }
    } finally {
      foam.dispose()
    }
  })
})

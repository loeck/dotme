import { Matrix4, Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { LANTERN, LakeLanterns, isDoubleTap } from './lake-lanterns'
import { WindModel } from './wind'

const flat = () => 0
const lake = () => true
const position = (lanterns: LakeLanterns, index: number) => {
  const matrix = new Matrix4()
  lanterns.mesh.getMatrixAt(index, matrix)
  return new Vector3().setFromMatrixPosition(matrix)
}

describe('lake lanterns', () => {
  it('recognises a double tap only when quick and close', () => {
    const first = { x: 100, y: 200, time: 1000 }
    expect(isDoubleTap(first, { x: 104, y: 203, time: 1200 })).toBe(true)
    expect(isDoubleTap(first, { x: 104, y: 203, time: 1000 + LANTERN.doubleTapMs + 1 })).toBe(false)
    expect(isDoubleTap(first, { x: 160, y: 200, time: 1100 })).toBe(false)
    expect(isDoubleTap(null, first)).toBe(false)
  })

  it('drifts downwind on the water, stays off the bank and keeps a bounded count', () => {
    const wind = new WindModel(3, { meanSpeed: 5, bearing: 0 })
    const lanterns = new LakeLanterns()
    lanterns.place(0, 0, 0)
    let t = 0
    for (; t < 30; t += 1 / 30) lanterns.update(t, wind.sample(t), 1, flat, lake, false)
    const moved = position(lanterns, 0)
    expect(Math.hypot(moved.x, moved.z)).toBeGreaterThan(0.5)
    expect(lanterns.mesh.visible).toBe(true)
    // A bank one step away holds it in place.
    const held = new LakeLanterns()
    held.place(0, 0, 0)
    for (let s = 0; s < 10; s += 1 / 30) held.update(s, wind.sample(s), 1, flat, () => false, false)
    expect(position(held, 0).x).toBeCloseTo(0, 9)
    for (let i = 0; i < LANTERN.limit + 3; i++) lanterns.place(i, i, t)
    expect(lanterns.count).toBe(LANTERN.limit)
    lanterns.dispose()
    held.dispose()
  })

  it('goes out by day', () => {
    const wind = new WindModel(1)
    const lanterns = new LakeLanterns()
    lanterns.place(1, 2, 0)
    lanterns.update(0.1, wind.sample(0.1), 1, flat, lake, false)
    expect(lanterns.count).toBe(1)
    lanterns.update(0.2, wind.sample(0.2), 0, flat, lake, false)
    expect(lanterns.count).toBe(0)
    expect(lanterns.mesh.visible).toBe(false)
    lanterns.place(Number.NaN, 0, 1)
    expect(lanterns.count).toBe(0)
  })
})

import { Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { FallingLeaves, LEAVES } from './falling-leaves'
import { GUST, WindGusts } from './wind-gusts'

function seeded(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

const calm = { direction: [1, 0], speed: 0 } as const
const stroke = { x: 0, z: 0, dx: 1, dz: 0, pixelsPerSecond: GUST.fullSweep }

function forest(onWater?: (x: number, z: number) => void, water = false) {
  const leaves = new FallingLeaves(
    32,
    new Vector3(0, 2, 16),
    () => ({ y: 0, water }),
    onWater,
    seeded(7),
  )
  // One crown band 6 m up, and a twig-sized sphere that never sheds.
  leaves.setSources(Float32Array.from([0, 6, 0, 2, 30, 6, 0, 0.3]))
  return leaves
}

describe('falling leaves', () => {
  it('stay on the trees in a calm without gusts', () => {
    const leaves = forest()
    // Find a lull: ambient patches stay below the shedding threshold at low breeze.
    for (let t = 0; t < 20; t += 0.05) leaves.update(t, 0.05, calm, 0, undefined)
    expect(leaves.count).toBe(0)
    leaves.dispose()
  })

  it('are torn off by a cursor gust, flutter down and land', () => {
    const leaves = forest()
    const gusts = new WindGusts()
    let most = 0
    for (let t = 0; t < 1.5; t += 1 / 60) {
      gusts.update(stroke, 1 / 60)
      leaves.update(t, 1 / 60, calm, 0, gusts)
      most = Math.max(most, leaves.count)
    }
    expect(most).toBeGreaterThan(2)
    // From 6 m at about a metre a second they are all down after ~8 s, then rest and fade.
    for (let t = 1.5; t < 9; t += 1 / 30) leaves.update(t, 1 / 30, calm, 0, undefined)
    expect(leaves.mesh.visible).toBe(true)
    for (let t = 9; t < 9 + LEAVES.rest[1] + LEAVES.fade + 0.5; t += 1 / 30)
      leaves.update(t, 1 / 30, calm, 0, undefined)
    expect(leaves.count).toBe(0)
    expect(leaves.mesh.visible).toBe(false)
    leaves.dispose()
  })

  it('ripples the lake where they land on water, spaced out', () => {
    const ripples: number[] = []
    const leaves = forest((x) => ripples.push(x), true)
    const gusts = new WindGusts()
    for (let t = 0; t < 12; t += 1 / 60) {
      gusts.update(t < 2 ? stroke : null, 1 / 60)
      leaves.update(t, 1 / 60, calm, 0, t < 2 ? gusts : undefined)
    }
    expect(ripples.length).toBeGreaterThan(0)
    expect(ripples.length).toBeLessThanOrEqual(Math.ceil(12 / LEAVES.rippleSpacing))
    leaves.dispose()
  })

  it('never holds more leaves than its capacity, and clears', () => {
    const leaves = forest()
    const gusts = new WindGusts()
    for (let t = 0; t < 4; t += 1 / 60) {
      gusts.update(stroke, 1 / 60)
      leaves.update(t, 1 / 60, calm, 1.4, gusts)
    }
    expect(leaves.count).toBeLessThanOrEqual(32)
    leaves.clear()
    expect(leaves.count).toBe(0)
    leaves.dispose()
  })
})

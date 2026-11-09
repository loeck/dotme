import { Matrix4, Quaternion, Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { FallingLeaves, LEAVES, paletteColour, seasonPalette } from './falling-leaves'
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

describe('seasonal leaf fall', () => {
  it('lets autumn leaves go without a gust and colours them from the season', () => {
    const leaves = forest()
    leaves.setSeason({ rate: 3.5, trickle: 1, autumn: 1, winter: 0 })
    let shed = 0
    for (let t = 0; t < 600; t += 0.1) {
      const before = leaves.count
      leaves.update(t, 0.1, calm, 0.25, undefined)
      shed += Math.max(0, leaves.count - before)
    }
    // About 0.008 leaves a second from a 2 m crown band in a light breeze.
    expect(shed).toBeGreaterThan(0)
    expect(shed).toBeLessThan(15)
    leaves.dispose()
  })

  it('picks palettes by season weight', () => {
    const summer = { rate: 1, trickle: 0, autumn: 0, winter: 0 }
    const autumn = { rate: 3.5, trickle: 1, autumn: 1, winter: 0 }
    const winter = { rate: 0.4, trickle: 0, autumn: 0, winter: 1 }
    expect(seasonPalette(summer, 0.5)).not.toBe(seasonPalette(autumn, 0.5))
    expect(seasonPalette(winter, 0.5)).not.toBe(seasonPalette(autumn, 0.5))
    // A colour is always drawn from its palette, whatever the pick.
    for (const pick of [0, 0.3, 0.999]) {
      const palette = seasonPalette(autumn, 0.5)
      expect(palette.map(([hex]) => hex)).toContain(paletteColour(palette, pick))
    }
  })
})

const surface = (x: number, _z: number, time: number) => 0.03 * Math.sin(x * 2 - time * 3)

describe('leaves as bodies', () => {
  it('rest on the ground below them and lie flat there', () => {
    const leaves = forest()
    const gusts = new WindGusts()
    for (let t = 0; t < 1; t += 1 / 60) {
      gusts.update(stroke, 1 / 60)
      leaves.update(t, 1 / 60, calm, 0, gusts)
    }
    for (let t = 1; t < 9; t += 1 / 30) leaves.update(t, 1 / 30, calm, 0, undefined)
    expect(leaves.grounded).toBeGreaterThan(0)
    const matrix = new Matrix4(),
      position = new Vector3(),
      rotation = new Quaternion(),
      scale = new Vector3(),
      normal = new Vector3()
    for (let i = 0; i < leaves.mesh.count; i++) {
      leaves.mesh.getMatrixAt(i, matrix)
      matrix.decompose(position, rotation, scale)
      if (scale.x === 0) continue
      expect(position.y).toBeGreaterThanOrEqual(0)
      expect(position.y).toBeLessThan(0.05)
      expect(Math.abs(normal.set(0, 1, 0).applyQuaternion(rotation).y)).toBeGreaterThan(0.95)
    }
    leaves.dispose()
  })

  it('float on the live surface, riding its waves and drifting', () => {
    const ripples: number[] = []
    const leaves = new FallingLeaves(
      32,
      new Vector3(0, 2, 16),
      () => ({ y: 0, water: true }),
      (x) => ripples.push(x),
      seeded(3),
      {
        water: (x, z, time, _wind, out) => {
          out[0] = surface(x, z, time)
          out[1] = 0.06 * Math.cos(x * 2 - time * 3)
          out[2] = 0
        },
      },
    )
    leaves.setSources(Float32Array.from([0, 6, 0, 2]))
    const gusts = new WindGusts()
    for (let t = 0; t < 1; t += 1 / 60) {
      gusts.update(stroke, 1 / 60)
      leaves.update(t, 1 / 60, calm, 0, gusts)
    }
    let t = 1
    for (; t < 9; t += 1 / 60) leaves.update(t, 1 / 60, calm, 0, undefined)
    expect(leaves.floating).toBeGreaterThan(0)
    expect(ripples.length).toBeGreaterThan(0)
    const matrix = new Matrix4(),
      position = new Vector3()
    for (let i = 0; i < leaves.mesh.count; i++) {
      leaves.mesh.getMatrixAt(i, matrix)
      position.setFromMatrixPosition(matrix)
      if (matrix.elements[0] === 0 && matrix.elements[5] === 0) continue
      expect(Math.abs(position.y - surface(position.x, position.z, t - 1 / 60))).toBeLessThan(0.05)
    }
    leaves.dispose()
  })
})

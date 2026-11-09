import { describe, expect, it } from 'vitest'

import {
  createLeafBody,
  floatLeaf,
  LEAF_AERO,
  leafNormalY,
  rotateLeaf,
  settleLeaf,
  stepLeafInAir,
} from './leaf-physics'

function flutterer() {
  const leaf = createLeafBody()
  leaf.y = 6
  leaf.normalDrag = LEAF_AERO.gravity / 1 ** 2
  leaf.flutter = 100
  leaf.flutterRate = 3.2
  rotateLeaf(leaf, 1, 0, 0, 0.3)
  return leaf
}

function fall(leaf: ReturnType<typeof createLeafBody>, h: number, air = [0, 0, 0] as const) {
  let time = 0,
    minX = leaf.x,
    maxX = leaf.x,
    flattest = 1,
    steepest = 1
  while (leaf.y > 0 && time < 30) {
    stepLeafInAir(leaf, air[0], air[1], air[2], time, h)
    time += h
    minX = Math.min(minX, leaf.x)
    maxX = Math.max(maxX, leaf.x)
    const tilt = Math.abs(leafNormalY(leaf))
    flattest = Math.max(flattest, tilt)
    steepest = Math.min(steepest, tilt)
  }
  return { time, sway: maxX - minX, steepest }
}

describe('leaf aerodynamics', () => {
  it('falls slowly, rocking and gliding to and fro rather than dropping like a stone', () => {
    const leaf = flutterer()
    const { time, sway, steepest } = fall(leaf, 1 / 60)
    // A stone takes 1.1 s from 6 m; a leaf settles near a metre a second.
    expect(time).toBeGreaterThan(3.5)
    expect(time).toBeLessThan(12)
    expect(sway).toBeGreaterThan(0.15)
    // It rocks visibly (over ~15°) but does not stay edge-on.
    expect(steepest).toBeLessThan(Math.cos((15 * Math.PI) / 180))
    expect(Math.hypot(leaf.vx, leaf.vy, leaf.vz)).toBeLessThan(3)
  })

  it('tumbles end over end when driven past the broadside moment', () => {
    const leaf = flutterer()
    leaf.tumble = LEAF_AERO.broadside * 1.3
    let turned = 0,
      time = 0
    let previous = leafNormalY(leaf)
    while (time < 3) {
      stepLeafInAir(leaf, 0, 0, 0, time, 1 / 60)
      time += 1 / 60
      const now = leafNormalY(leaf)
      if (Math.sign(now) !== Math.sign(previous)) turned++
      previous = now
    }
    expect(turned).toBeGreaterThan(3)
    // Spin stays visible frame to frame rather than strobing.
    expect(Math.hypot(leaf.wx, leaf.wy, leaf.wz)).toBeLessThanOrEqual(LEAF_AERO.maxSpin + 1e-9)
  })

  it('rides the wind', () => {
    const leaf = flutterer()
    leaf.y = 40
    for (let t = 0; t < 6; t += 1 / 60) stepLeafInAir(leaf, 2, 0, 0, t, 1 / 60)
    expect(leaf.vx).toBeGreaterThan(1.4)
    expect(leaf.vx).toBeLessThan(2.6)
  })

  it('stays finite and bounded at a 0.1 s step in a gale', () => {
    const leaf = flutterer()
    leaf.tumble = 200
    leaf.y = 200
    for (let t = 0; t < 20; t += 0.1) stepLeafInAir(leaf, 9, 3, -6, t, 0.1)
    for (const value of [leaf.x, leaf.y, leaf.vx, leaf.vy, leaf.qw, leaf.wx])
      expect(Number.isFinite(value)).toBe(true)
    expect(Math.hypot(leaf.vx - 9, leaf.vy - 3, leaf.vz + 6)).toBeLessThan(6)
    expect(Math.hypot(leaf.qx, leaf.qy, leaf.qz, leaf.qw)).toBeCloseTo(1, 6)
  })
})

describe('floating leaves', () => {
  it('ride the surface, lie on its slope and slide down it', () => {
    const leaf = flutterer()
    rotateLeaf(leaf, 0, 0, 1, 1.2)
    for (let t = 0; t < 3; t += 1 / 60) floatLeaf(leaf, 1.05, 0.05, 0, 0, 0, 1 / 60)
    expect(leaf.y).toBe(1.05)
    // Down a slope rising toward +x.
    expect(leaf.vx).toBeLessThan(-0.05)
    expect(Math.abs(leafNormalY(leaf))).toBeGreaterThan(0.99)
  })

  it('take the drift', () => {
    const leaf = flutterer()
    for (let t = 0; t < 4; t += 1 / 60) floatLeaf(leaf, 1, 0, 0, 0.2, -0.1, 1 / 60)
    expect(leaf.vx).toBeCloseTo(0.2, 2)
    expect(leaf.vz).toBeCloseTo(-0.1, 2)
  })

  it('settle on the nearer face', () => {
    const leaf = createLeafBody()
    rotateLeaf(leaf, 1, 0, 0, 2.6)
    for (let i = 0; i < 60; i++) settleLeaf(leaf, 0, 1, 0, 0.2)
    expect(leafNormalY(leaf)).toBeCloseTo(-1, 3)
  })
})

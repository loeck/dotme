import { describe, expect, it } from 'vitest'

import { GUST, WindGusts } from './wind-gusts'

const stroke = { x: 0, z: 0, dx: 1, dz: 0, pixelsPerSecond: GUST.fullSweep }
const push: [number, number] = [0, 0]

describe('cursor wind', () => {
  it('eases into a steady lean and settles without oscillating when the cursor stops', () => {
    const gusts = new WindGusts()
    gusts.update(stroke, 1 / 60)
    const first = gusts.pushAt(0, 0, push)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(0.05)
    let previous = first
    for (let frame = 1; frame < 120; frame++) {
      gusts.update(stroke, 1 / 60)
      const current = gusts.pushAt(0, 0, push)
      expect(current).toBeGreaterThanOrEqual(previous)
      expect(current).toBeLessThanOrEqual(1)
      previous = current
    }
    expect(previous).toBeGreaterThan(0.99)
    for (let frame = 0; frame < 180; frame++) {
      gusts.update(null, 1 / 60)
      const current = gusts.pushAt(0, 0, push)
      expect(current).toBeLessThanOrEqual(previous)
      expect(push[0]).toBeGreaterThanOrEqual(0)
      previous = current
    }
    expect(previous).toBeLessThan(0.0001)
    expect(gusts.active()).toBe(false)
  })

  it('responds proportionally to slow and fast motion, locally and in the stroke direction', () => {
    const slow = new WindGusts(),
      fast = new WindGusts()
    for (let frame = 0; frame < 120; frame++) {
      slow.update({ ...stroke, pixelsPerSecond: 100, dx: 0, dz: -1 }, 1 / 60)
      fast.update({ ...stroke, pixelsPerSecond: 400, dx: 0, dz: -1 }, 1 / 60)
    }
    const gentle = slow.pushAt(0, 0, push)
    expect(gentle).toBeGreaterThan(0)
    expect(push[0]).toBe(0)
    expect(push[1]).toBeLessThan(0)
    const brisk = fast.pushAt(0, 0, push)
    expect(brisk / gentle).toBeCloseTo(4)
    expect(fast.pushAt(GUST.radius * 3, 0, push)).toBeLessThan(brisk * 0.01)
    // Moving the cursor's contact must not teleport a full-strength wind patch.
    fast.update({ ...stroke, x: GUST.radius * 2, pixelsPerSecond: 400, dx: 0, dz: -1 }, 1 / 60)
    expect(fast.pushAt(0, 0, push)).toBeGreaterThan(brisk * 0.95)
  })

  it('keeps momentum through a direction reversal and clears for reduced motion', () => {
    const gusts = new WindGusts()
    for (let frame = 0; frame < 60; frame++) gusts.update(stroke, 1 / 60)
    gusts.update({ ...stroke, dx: -1 }, 1 / 60)
    gusts.pushAt(0, 0, push)
    expect(push[0]).toBeGreaterThan(0.9)
    for (let frame = 0; frame < 60; frame++) gusts.update({ ...stroke, dx: -1 }, 1 / 60)
    gusts.pushAt(0, 0, push)
    expect(push[0]).toBeLessThan(-0.9)
    gusts.clear()
    expect(gusts.pushAt(0, 0, push)).toBe(0)
    expect(gusts.active()).toBe(false)
  })

  it('keeps the same response at different frame rates, including a stop and reversal', () => {
    const results = [30, 60, 144].map((fps) => {
      const gusts = new WindGusts()
      for (let frame = 0; frame < fps; frame++) gusts.update(stroke, 1 / fps)
      for (let frame = 0; frame < fps / 2; frame++)
        gusts.update({ ...stroke, x: 9, pixelsPerSecond: 0 }, 1 / fps)
      for (let frame = 0; frame < fps; frame++)
        gusts.update({ ...stroke, x: 9, dx: 0, dz: -1 }, 1 / fps)
      const value: [number, number] = [0, 0]
      gusts.pushAt(9, 0, value)
      return value
    })
    for (const result of results.slice(1)) {
      expect(result[0]).toBeCloseTo(results[0]?.[0] ?? 0, 10)
      expect(result[1]).toBeCloseTo(results[0]?.[1] ?? 0, 10)
    }
  })
})

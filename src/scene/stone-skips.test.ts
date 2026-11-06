import { Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { SKIP, SkippingStone, flickOrigin, hopDuration, planSkips } from './stone-skips'
import type { Touchdown } from './stone-skips'

const openLake = () => true
const hop = (a: Touchdown, b: Touchdown) => Math.hypot(b.x - a.x, b.z - a.z)

describe('skipping stones', () => {
  it('skips further and more often for a faster flick, each hop shorter than the last', () => {
    const slow = planSkips({ x: 0, z: 0 }, { x: 0, z: -1 }, SKIP.minSpeed, openLake)
    const fast = planSkips({ x: 0, z: 0 }, { x: 0, z: -1 }, 30, openLake)
    expect(fast.length).toBeGreaterThan(slow.length)
    expect(fast.length).toBeLessThanOrEqual(SKIP.maxTouchdowns)
    expect(fast[0]).toEqual({ x: 0, z: 0, at: SKIP.throwTime, energy: 1 })
    for (let i = 2; i < fast.length; i++) {
      const previous = fast[i - 1],
        current = fast[i],
        before = fast[i - 2]
      if (!previous || !current || !before) throw new Error('missing touchdown')
      expect(hop(previous, current)).toBeLessThan(hop(before, previous))
      expect(current.at - previous.at).toBeCloseTo(hopDuration(hop(previous, current)), 9)
      expect(current.energy).toBeLessThan(previous.energy)
      // Skips run along the flick.
      expect(current.z).toBeLessThan(previous.z)
      expect(current.x).toBeCloseTo(0, 9)
    }
    const [landing, firstSkip] = fast
    if (!landing || !firstSkip) throw new Error('missing touchdown')
    expect(hop(landing, firstSkip)).toBeCloseTo(SKIP.maxFirstHop, 9)
  })

  it('sinks before the bank and treats a still flick as a plain drop', () => {
    const bank = (x: number) => x < 6
    const plan = planSkips({ x: 0, z: 0 }, { x: 1, z: 0 }, 30, (x) => bank(x))
    for (const touchdown of plan) expect(bank(touchdown.x)).toBe(true)
    expect(plan.length).toBe(1)
    const shortPlan = planSkips({ x: 0, z: 0 }, { x: 1, z: 0 }, 6, (x) => bank(x))
    expect(shortPlan.length).toBeGreaterThan(1)
    for (const touchdown of shortPlan) expect(touchdown.x).toBeLessThan(6)
    expect(planSkips({ x: 2, z: 3 }, { x: 0, z: 0 }, 20, openLake)).toHaveLength(1)
    expect(planSkips({ x: 2, z: 3 }, { x: 1, z: 0 }, Number.NaN, openLake)).toHaveLength(1)
  })

  it('reports each touchdown once, in order, then hides the stone', () => {
    const plan = planSkips({ x: 0, z: 0 }, { x: 0, z: -1 }, 20, openLake)
    const stone = new SkippingStone(0)
    const seen: [number, boolean][] = []
    stone.throw(new Vector3(1, 1.5, 5), plan, 10)
    expect(stone.active).toBe(true)
    let lowest = Infinity
    for (let t = 10; t < 20; t += 1 / 60) {
      stone.update(t, (_, index, last) => seen.push([index, last]))
      if (stone.active) lowest = Math.min(lowest, stone.mesh.position.y)
    }
    expect(seen.map(([index]) => index)).toEqual(plan.map((_, index) => index))
    expect(seen.filter(([, last]) => last)).toEqual([[plan.length - 1, true]])
    expect(stone.active).toBe(false)
    // The stone never dips below the water while it flies.
    expect(lowest).toBeGreaterThanOrEqual(-1e-9)
    stone.dispose()
  })

  it('measures a flick over at least 40 ms, even when the last move sits on the release', () => {
    const press = { x: 700, y: 780, time: 0 }
    const samples = [press, { x: 718, y: 726, time: 30 }, { x: 736, y: 672, time: 95 }]
    expect(flickOrigin(samples, 100)).toBe(samples[1])
    expect(flickOrigin(samples, 140)).toBe(samples[2])
    expect(flickOrigin([press], 20)).toBe(press)
    expect(flickOrigin([], 20)).toBeUndefined()
  })
})

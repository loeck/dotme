import { Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { BirdFlock, FLOCK, flockRandom, flockRoute } from './bird-flock'

const viewer = new Vector3(0, 4, 30)
const crown = new Vector3(-12, 9, -10)

describe('bird flock', () => {
  it('routes the flock up, away from the viewer and off over the far hills', () => {
    const route = flockRoute(crown, viewer, 1)
    expect(route).toHaveLength(4)
    const distance = (point: Vector3) => Math.hypot(point.x - viewer.x, point.z - viewer.z)
    for (const point of route) expect(point.y).toBeGreaterThan(crown.y)
    const last = route[route.length - 1]
    if (!last) throw new Error('missing waypoint')
    expect(distance(last)).toBeGreaterThan(distance(crown) + 100)
    // Mirrored turn for the other side.
    const mirrored = flockRoute(crown, viewer, -1)
    expect(mirrored[1]?.x).not.toBeCloseTo(route[1]?.x ?? 0, 3)
  })

  it('takes off, climbs, flies away, then lands nowhere: it is gone after its lifetime', () => {
    const flock = new BirdFlock(FLOCK.size)
    expect(flock.active).toBe(false)
    flock.launch(crown, viewer, 7)
    expect(flock.active).toBe(true)
    for (let t = 0; t < 4; t += 1 / 60) flock.update(1 / 60)
    // Two instanced wing meshes, one per side.
    expect(flock.group.children).toHaveLength(2)
    for (let t = 4; t < FLOCK.lifetime + 1; t += 1 / 60) flock.update(1 / 60)
    expect(flock.active).toBe(false)
    flock.dispose()
  })

  it('climbs above its crown and moves away from the viewer', () => {
    const flock = new BirdFlock(FLOCK.lowPowerSize)
    flock.launch(crown, viewer, 3)
    for (let t = 0; t < 6; t += 1 / 60) flock.update(1 / 60)
    const centre = flock.centre()
    expect(centre.y).toBeGreaterThan(crown.y + 3)
    expect(centre.distanceTo(viewer)).toBeGreaterThan(crown.distanceTo(viewer) + 10)
    for (const value of centre.toArray()) expect(Number.isFinite(value)).toBe(true)
    flock.cancel()
    expect(flock.active).toBe(false)
    flock.dispose()
  })

  it('spreads flocks deterministically from a seed', () => {
    const a = flockRandom(5),
      b = flockRandom(5)
    for (let i = 0; i < 5; i++) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
    expect(flockRandom(0)()).toBeGreaterThan(0)
  })
})

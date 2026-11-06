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

describe('bird flock among trees', () => {
  it('climbs over the canopy and keeps out of the crowns it passes', () => {
    // A wood of tall crowns between the take-off tree and the far hills.
    const crowns: number[] = []
    for (let x = -30; x <= 10; x += 6) for (let z = -60; z <= -14; z += 6) crowns.push(x, 14, z, 3)
    const spheres = new Float32Array(crowns)
    const flock = new BirdFlock(FLOCK.size)
    flock.setObstacles(spheres)
    flock.launch(crown, viewer, 11)
    const inside = (p: Vector3) => {
      for (let i = 0; i < spheres.length; i += 4) {
        const d = Math.hypot(
          p.x - (spheres[i] ?? 0),
          p.y - (spheres[i + 1] ?? 0),
          p.z - (spheres[i + 2] ?? 0),
        )
        if (d < (spheres[i + 3] ?? 0) * 0.8) return true
      }
      return false
    }
    let deepInside = 0
    for (let t = 0; t < FLOCK.lifetime - 1; t += 1 / 60) {
      flock.update(1 / 60)
      // Past the first second (the take-off crown), nobody flies through a crown's heart.
      if (t > 1.5 && inside(flock.centre())) deepInside++
    }
    expect(deepInside).toBe(0)
    flock.dispose()
  })

  it('beats about three times a second, with glides between bursts', () => {
    expect(FLOCK.flapRate).toBeGreaterThanOrEqual(2.5)
    expect(FLOCK.flapRate).toBeLessThanOrEqual(4)
  })
})

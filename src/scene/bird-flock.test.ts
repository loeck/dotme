import { InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import {
  BirdFlock,
  FLOCK,
  duckRoute,
  flockRandom,
  flockRoute,
  gullRoute,
  swiftRoute,
} from './bird-flock'
import { BIRD_SPECIES, SPECIES } from './bird-species'
import { WATER_LEVEL } from './lake-bed'

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
    const flock = new BirdFlock(FLOCK.capacity)
    expect(flock.active).toBe(false)
    flock.launch(crown, viewer, 7)
    expect(flock.active).toBe(true)
    for (let t = 0; t < 4; t += 1 / 60) flock.update(1 / 60)
    // One instanced draw for the whole flock.
    expect(flock.group.children).toHaveLength(1)
    for (let t = 4; t < FLOCK.lifetime + 1; t += 1 / 60) flock.update(1 / 60)
    expect(flock.active).toBe(false)
    flock.dispose()
  })

  it('climbs above its crown and moves away from the viewer', () => {
    const flock = new BirdFlock(6)
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
    const flock = new BirdFlock(FLOCK.capacity)
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

  it('crows beat about four times a second, with glides between bursts', () => {
    expect(SPECIES.crow.flight.flapRate).toBeGreaterThanOrEqual(3)
    expect(SPECIES.crow.flight.flapRate).toBeLessThanOrEqual(4.5)
    expect(SPECIES.crow.flight.burst[1]).toBeGreaterThan(0)
  })
})

const routes = (seed: number) => {
  const random = flockRandom(seed)
  return {
    mallard: duckRoute(viewer, random, () => -5),
    gull: gullRoute(viewer, random),
    swift: swiftRoute(viewer, random),
  }
}

describe('flocks of each species', () => {
  it('keeps every species aloft, apart, at flying speed and finite', () => {
    for (const species of BIRD_SPECIES) {
      for (const seed of [1, 7, 23]) {
        const flock = new BirdFlock(FLOCK.capacity)
        const count = SPECIES[species].count
        if (species === 'crow') flock.launch(crown, viewer, seed, count)
        else flock.fly({ species, count, seed, route: routes(seed)[species], takeOff: false })
        expect(flock.flying).toBe(species)
        expect(flock.size).toBe(Math.min(count, FLOCK.capacity))
        const cruise = SPECIES[species].flight.speed
        let crowded = 0,
          frames = 0,
          slowest = Infinity,
          fastest = 0,
          lowest = Infinity
        for (let t = 0; t < 40 && flock.active; t += 1 / 60) {
          flock.update(1 / 60)
          if (!flock.active) break
          const { low, high } = flock.speeds()
          fastest = Math.max(fastest, high)
          lowest = Math.min(lowest, flock.lowest())
          if (t > 1.5) {
            slowest = Math.min(slowest, low)
            frames++
            if (flock.closestPair() < SPECIES[species].shape.span * 0.5) crowded++
          }
          expect(flock.centre().toArray().every(Number.isFinite)).toBe(true)
        }
        expect(fastest).toBeLessThanOrEqual(cruise * 1.7 + 4)
        expect(slowest).toBeGreaterThanOrEqual(cruise * 0.5 - 1e-6)
        expect(lowest).toBeGreaterThan(WATER_LEVEL + 0.8)
        // Separation keeps birds apart: a close pass is brief and rare.
        expect(crowded / frames, `${species} ${seed}`).toBeLessThan(0.02)
        expect(flock.active).toBe(false)
        flock.dispose()
      }
    }
  })

  it('flies mallards low across the view and gulls up on their thermal', () => {
    const ducks = new BirdFlock(FLOCK.capacity)
    const route = routes(3).mallard
    ducks.fly({ species: 'mallard', count: 7, seed: 3, route, takeOff: false })
    const start = ducks.centre().clone()
    for (let t = 0; t < 6; t += 1 / 60) ducks.update(1 / 60)
    const crossing = ducks.centre()
    expect(Math.abs(crossing.x - start.x)).toBeGreaterThan(40)
    expect(crossing.y).toBeLessThan(WATER_LEVEL + 7)
    ducks.dispose()

    const gulls = new BirdFlock(FLOCK.capacity)
    const thermal = routes(5).gull
    gulls.fly({ species: 'gull', count: 6, seed: 5, route: thermal, takeOff: false })
    const core = thermal[1] ?? new Vector3()
    let near = 0
    for (let t = 0; t < 20; t += 1 / 60) {
      gulls.update(1 / 60)
      const c = gulls.centre()
      if (t > 8 && Math.hypot(c.x - core.x, c.z - core.z) < 25) near++
    }
    // Most of the circling time is spent around the thermal's core.
    expect(near / (12 * 60)).toBeGreaterThan(0.6)
    gulls.dispose()
  })

  it('lifts the duck route over ground on the way', () => {
    const route = duckRoute(viewer, flockRandom(2), (x) => (Math.abs(x) > 50 ? 8 : -5))
    const overGround = route.filter((point) => Math.abs(point.x) > 50)
    const overWater = route.filter((point) => Math.abs(point.x) <= 50)
    expect(overGround.length).toBeGreaterThan(0)
    expect(Math.min(...overGround.map((point) => point.y))).toBeGreaterThanOrEqual(11.5)
    expect(Math.max(...overWater.map((point) => point.y))).toBeLessThan(WATER_LEVEL + 4.1)
  })
})

describe('bird instance frames', () => {
  it('writes an orthogonal, evenly scaled frame and a bounded pose for every bird', () => {
    for (const species of BIRD_SPECIES) {
      const flock = new BirdFlock(FLOCK.capacity)
      const count = SPECIES[species].count
      if (species === 'crow') flock.launch(crown, viewer, 5, count)
      else flock.fly({ species, count, seed: 5, route: routes(5)[species], takeOff: false })
      const mesh = flock.group.children[0]
      if (!(mesh instanceof Mesh)) throw new Error('missing bird mesh')
      const geometry: unknown = mesh.geometry
      if (!(geometry instanceof InstancedBufferGeometry)) throw new Error('missing bird geometry')
      const axes = ['aAxisX', 'aAxisY', 'aAxisZ'].map((name) => {
        const attribute: unknown = geometry.getAttribute(name)
        if (!(attribute instanceof InstancedBufferAttribute)) throw new Error(`missing ${name}`)
        return attribute
      })
      let worstSkew = 0,
        worstScale = 0,
        worstAngle = 0
      const v = [new Vector3(), new Vector3(), new Vector3()]
      for (let t = 0; t < 20 && flock.active; t += 1 / 30) {
        flock.update(1 / 30)
        for (let i = 0; i < flock.size; i++) {
          for (const [k, axis] of axes.entries()) {
            v[k]?.set(axis.getX(i), axis.getY(i), axis.getZ(i))
            worstAngle = Math.max(worstAngle, Math.abs(axis.getW(i)))
          }
          const [x, y, z] = v
          if (!x || !y || !z) continue
          const scale = z.length()
          worstScale = Math.max(
            worstScale,
            Math.abs(x.length() - scale),
            Math.abs(y.length() - scale),
          )
          worstSkew = Math.max(
            worstSkew,
            Math.abs(x.dot(y)),
            Math.abs(y.dot(z)),
            Math.abs(z.dot(x)),
          )
          // Right-handed, so the wings' upper faces stay front faces.
          expect(x.clone().cross(y).dot(z)).toBeGreaterThan(0)
        }
      }
      expect(worstScale).toBeLessThan(1e-4)
      expect(worstSkew).toBeLessThan(1e-4)
      // Shoulder, wrist and fold stay within a wing's reach.
      expect(worstAngle).toBeLessThan(1.3)
      flock.dispose()
    }
  })
})

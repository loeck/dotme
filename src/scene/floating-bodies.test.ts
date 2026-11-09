import { Matrix4, Ray, Scene, Vector3, Vector4 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { createBoxIndex } from './box-index'
import type { Box } from './box-index'
import { FloatingBodies, GRAB, grabAcceleration } from './floating-bodies'
import { createLakeBed, sampleShore, WATER_LEVEL } from './lake-bed'
import { LakeSplashes } from './lake-splashes'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { WaterContact } from './water-contact'
import { sampleWindField } from './water-surface'
import { WindModel } from './wind'

const block: Box = { x: 0, y: 0.5, z: 0, size: 4, color: 0 }
const bed = createLakeBed([block], 42, true)
const windy = new WindModel(42, { meanSpeed: 8, bearing: 0, gustStrength: 0, turnStrength: 0 })

const physicsFor = async () => createPhysicsWorld(await loadPhysics(), createBoxIndex([block]))

const positionsOf = (floating: FloatingBodies) => {
  const matrix = new Matrix4(),
    position = new Vector3()
  return Array.from({ length: floating.mesh.count }, (_, i) => {
    floating.mesh.getMatrixAt(i, matrix)
    return position.setFromMatrixPosition(matrix).toArray()
  })
}

const run = async (seed: number, frames = 600) => {
  const physics = await physicsFor()
  const scene = new Scene()
  const splashes = new LakeSplashes(scene, bed, seed, true, physics)
  const floating = new FloatingBodies(scene, bed, seed, true, physics, splashes)
  const contact = new WaterContact(bed)
  splashes.setWaterContact(contact)
  floating.setWaterContact(contact)
  try {
    const wakes: number[][] = []
    floating.onWake = (...event) => wakes.push(event)
    const start = positionsOf(floating)
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / 60
      const wind = windy.sample(time)
      floating.update(time, wind)
      splashes.update(time, wind)
    }
    return { start, end: positionsOf(floating), wakes }
  } finally {
    floating.dispose()
    splashes.dispose()
    physics.dispose()
    expect(scene.children).toHaveLength(0)
  }
}

describe('floating bodies', () => {
  it('holds the picked buoy above water, then drops it into a splash and floats again', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    const calm = new WindModel(42, { meanSpeed: 0, gustStrength: 0, turnStrength: 0 })
    try {
      const [bx, by, bz] = required(positionsOf(floating)[0])
      const ray = new Ray(new Vector3(bx, by + 3, bz), new Vector3(0, -1, 0))
      expect(floating.grab(ray, 0.005, 1)).toBeNull() // Ground occludes the pick.
      const miss = new Ray(new Vector3(bx + 0.5, by + 3, bz), new Vector3(0, -1, 0))
      expect(floating.grab(miss, 0.005, 10)).toBeNull()
      expect(floating.grab(ray, 0.005, 10)).not.toBeNull()
      floating.moveGrab(new Vector3(bx + 0.6, 2, bz))
      const advance = (from: number, to: number) => {
        for (let frame = from; frame < to; frame++) {
          const time = frame / 60
          floating.update(time, calm.sample(time))
          splashes.update(time, calm.sample(time))
        }
      }
      advance(0, 120)
      const held = required(positionsOf(floating)[0])
      expect(held[0]).toBeCloseTo(bx + 0.6, 2)
      expect(held[1]).toBeCloseTo(2, 2)
      const waves: number[][] = []
      floating.onWake = (...wave) => waves.push(wave)
      floating.releaseGrab()
      advance(120, 135)
      expect(required(positionsOf(floating)[0])[1]).toBeLessThan(1.85)
      advance(135, 480)
      expect(Math.abs(required(required(positionsOf(floating)[0])[1]) - WATER_LEVEL)).toBeLessThan(
        0.15,
      )
      expect(waves.some((wave) => required(wave[3]) < -0.025)).toBe(true)
      expect(splashes.impacts.landed).toBeGreaterThan(0)
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('sheds occasional leaves from overhanging crowns into water and recycles a bounded pool', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    const calm = new WindModel(42, { meanSpeed: 0, gustStrength: 0, turnStrength: 0 })
    try {
      const [bx, , bz] = required(positionsOf(floating)[0])
      const originalCount = floating.mesh.count
      floating.setLeafSources(new Float32Array([bx, 4, bz, 1]))
      const waves: number[][] = []
      floating.onWake = (...wave) => waves.push(wave)
      let airAt = -1
      let landed = false
      for (let frame = 0; frame < 3600; frame++) {
        const time = frame / 60
        floating.update(time, calm.sample(time))
        splashes.update(time, calm.sample(time))
        const firstLeaf = required(positionsOf(floating)[1])
        if (required(firstLeaf[1]) > 3) airAt = time
        if (airAt >= 0 && time > airAt + 1 && Math.abs(required(firstLeaf[1]) - WATER_LEVEL) < 0.12)
          landed = true
      }
      expect(airAt).toBeGreaterThanOrEqual(6)
      expect(landed).toBe(true)
      expect(waves.some((wave) => required(wave[3]) < 0)).toBe(true)
      expect(floating.mesh.count).toBe(originalCount)
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('keeps fallen leaves afloat in a sheltered inlet without carrying them through its banks', async () => {
    const banks: Box[] = [
      { x: 0, y: 0.5, z: 5, size: 2, color: 0 },
      { x: 6, y: 0.5, z: 5, size: 2, color: 0 },
      { x: 2, y: 0.5, z: 7, size: 2, color: 0 },
      { x: 4, y: 0.5, z: 7, size: 2, color: 0 },
    ]
    const inlet = createLakeBed(banks, 42, false)
    const physics = createPhysicsWorld(await loadPhysics(), createBoxIndex(banks))
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, inlet, 42, true, physics)
    const floating = new FloatingBodies(scene, inlet, 42, true, physics, splashes)
    floating.setLeafSources(new Float32Array([3, 2.5, 5.2, 0.7]))
    try {
      let airborne = false
      let retained = 0
      let closestBank = Infinity
      for (let frame = 0; frame < 5100; frame++) {
        const time = frame / 60
        const wind = windy.sample(time)
        floating.update(time, wind)
        splashes.update(time, wind)
        const [x, y, z] = required(positionsOf(floating)[1])
        if (time >= 6 && y > 2) airborne = true
        if (airborne && y < WATER_LEVEL + 0.1)
          closestBank = Math.min(closestBank, sampleShore(inlet, x, z))
        if (time > 30 && x > 1 && x < 5 && z > 3.9 && z < 6 && Math.abs(y - WATER_LEVEL) < 0.12)
          retained++
      }
      expect(airborne).toBe(true)
      expect(closestBank).toBeGreaterThan(0.03)
      // At least forty of the last fifty-five seconds remain in the water pocket,
      // despite a sustained crosswind pushing toward its right-hand wall.
      expect(retained / 60).toBeGreaterThan(40)
      const [x, , z] = required(positionsOf(floating)[1])
      expect(sampleShore(inlet, x, z)).toBeGreaterThan(0.12)
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('reports a waterline circle for floaters resting on the surface', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    try {
      for (let frame = 0; frame < 240; frame++) {
        const time = frame / 60
        floating.update(time, windy.sample(time))
        splashes.update(time, windy.sample(time))
      }
      const slots = Array.from({ length: 8 }, () => new Vector4())
      floating.waterlines(slots)
      const [buoy] = slots
      expect(required(buoy).w).toBe(1)
      expect(required(buoy).z).toBeGreaterThan(0.03)
      expect(required(buoy).z).toBeLessThanOrEqual(0.09)
      expect(required(slots.at(-1)).toArray()).toEqual([0, 0, 0, 0])
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('only receives an immediate shove when the click reaches its hull', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    try {
      const [buoy] = positionsOf(floating)
      const [bx, , bz] = required(buoy)
      floating.splash(bx - 1.5, bz, 0.55)
      physics.world.step()
      floating.update(0, windy.sample(0), false)
      const [afterFarClick] = positionsOf(floating)
      expect(required(afterFarClick)[0]).toBeCloseTo(bx, 6)

      floating.splash(bx - 0.1, bz, 0.55)
      physics.world.step()
      floating.update(0, windy.sample(0), false)
      const [after] = positionsOf(floating)
      expect(required(after)[0]).toBeGreaterThan(bx)
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('rides the surface and drifts downwind without sinking', async () => {
    const { start, end, wakes } = await run(42)
    expect(end.length).toBeGreaterThan(0)
    const time = 599 / 60,
      wind = windy.sample(time)
    for (const [i, position] of end.entries()) {
      const [x, y, z] = [required(position[0]), required(position[1]), required(position[2])]
      expect(Number.isFinite(x + y + z)).toBe(true)
      const surface = WATER_LEVEL + sampleWindField(x, z, time, wind, 0.08)[0]
      expect(Math.abs(y - surface)).toBeLessThan(0.35)
      const from = required(start[i])
      expect(Math.hypot(x - required(from[0]), z - required(from[2]))).toBeGreaterThan(0.05)
    }
    const buoy = required(end[0]),
      buoyStart = required(start[0])
    expect(required(buoy[0])).toBeGreaterThan(required(buoyStart[0]))
    expect(wakes.length).toBeGreaterThan(0)
    expect(wakes.length).toBeLessThan(100)
    expect(
      wakes.every(
        ([x, z, radius, velocity]) =>
          Number.isFinite(required(x) + required(z)) &&
          required(radius) > 0 &&
          required(velocity) < 0,
      ),
    ).toBe(true)
  })

  it('replays the same trajectory deterministically', async () => {
    const first = await run(42)
    expect(await run(42)).toEqual(first)
    expect((await run(43)).end).not.toEqual(first.end)
  })
})

const follow = (immersion: number, water = 0) => {
  // A hand moving at 1 m/s; the body starts with it.
  let x = 0,
    v = 1,
    lag = 0
  for (let t = 0; t < 2; t += 1 / 120) {
    v += grabAcceleration(t - x, v, water, immersion, false) / 120
    x += v / 120
    lag = t - x
  }
  return lag
}

describe('grab spring', () => {
  it('lags the hand more through water than through air', () => {
    expect(follow(0)).toBeLessThan(0.16)
    expect(follow(1)).toBeGreaterThan(follow(0) * 1.2)
  })

  it('floats a wet body a little above the hand and carries it with the water', () => {
    // At rest, wet: buoyancy balances the spring a few centimetres high.
    const rise = (9.81 * 0.5) / GRAB.stiffness
    expect(grabAcceleration(-rise, 0, 0, 0.5, true)).toBeCloseTo(0, 6)
    expect(grabAcceleration(0, 0, 0.3, 1, false)).toBeGreaterThan(0)
  })

  it('bounds the pull', () => {
    expect(grabAcceleration(100, 0, 0, 0, false)).toBe(GRAB.limit)
  })
})

describe('held buoy in the water', () => {
  it('sends a wake and spray while dragged through the lake, and collides on', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    const contact = new WaterContact(bed)
    splashes.setWaterContact(contact)
    floating.setWaterContact(contact)
    const calm = new WindModel(42, { meanSpeed: 0, gustStrength: 0, turnStrength: 0 })
    try {
      const [bx, by, bz] = required(positionsOf(floating)[0])
      const ray = new Ray(new Vector3(bx, by + 3, bz), new Vector3(0, -1, 0))
      expect(floating.grab(ray, 0.005, 10)).not.toBeNull()
      const wakes: number[][] = []
      floating.onWake = (...wake) => wakes.push(wake)
      let lowest = Infinity
      for (let frame = 0; frame < 150; frame++) {
        const time = frame / 60
        // Swept back and forth along the waterline at up to ~2 m/s.
        const x = bx + Math.sin(time * 3) * 0.7
        floating.moveGrab(new Vector3(x, WATER_LEVEL - 0.03, bz))
        floating.update(time, calm.sample(time))
        splashes.update(time, calm.sample(time))
        if (frame > 30) lowest = Math.min(lowest, required(required(positionsOf(floating)[0])[1]))
      }
      // Buoyancy holds it near the surface rather than at the hand's depth.
      expect(lowest).toBeGreaterThan(WATER_LEVEL - 0.075)
      const troughs = wakes.filter((wake) => required(wake[3]) < 0)
      // A continuous furrow: troughs nearly every step, never more than a few per step.
      expect(troughs.length).toBeGreaterThan(100)
      expect(wakes.length).toBeLessThanOrEqual(150 * (GRAB.wakeSamples + 2))
      // Broad, bounded troughs: the GPU field takes them without steepening.
      const deepest = Math.min(...troughs.map((wake) => required(wake[3])))
      expect(deepest).toBeLessThan(-0.01)
      expect(deepest).toBeGreaterThanOrEqual(-GRAB.wakeDepth)
      // Consecutive troughs lie along the path, a splat's width apart at most: no gaps.
      let gap = 0
      for (let i = 1; i < troughs.length; i++) {
        const a = required(troughs[i - 1]),
          b = required(troughs[i])
        gap = Math.max(
          gap,
          Math.hypot(required(b[0]) - required(a[0]), required(b[1]) - required(a[1])),
        )
      }
      expect(gap).toBeLessThan(GRAB.wakeRadius)
      expect(splashes.emitted).toBeGreaterThan(0)
      floating.releaseGrab()
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })
})

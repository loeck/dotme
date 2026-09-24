import { Matrix4, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { createLakeBed, WATER_LEVEL } from './lake-bed'
import { LakeSplashes } from './lake-splashes'
import { sampleWindField } from './water-surface'
import { WindModel } from './wind'

const bed = createLakeBed([{ x: 0, y: 0.5, z: 0, size: 4, color: 0 }], 42, true)
const calm = new WindModel(42, { meanSpeed: 0, gustStrength: 0, turnStrength: 0 })
const windy = new WindModel(42, { meanSpeed: 8, bearing: 0, gustStrength: 0, turnStrength: 0 })

const replay = (seed: number) => {
  const splashes = new LakeSplashes(new Scene(), bed, seed, true)
  const shapes = new Map<number, number[]>()
  const returns: number[][] = []
  splashes.onReturn = (...event) => returns.push(event)
  for (let frame = 0; frame < 600; frame++) {
    const time = frame / 30
    splashes.update(time, windy.sample(time))
    const data = splashes.sheets.geometry.getAttribute('aSheet')
    const shape = splashes.sheets.geometry.getAttribute('aSheetShape')
    const timing = splashes.sheets.geometry.getAttribute('aSheetTiming')
    for (let i = 0; i < data.count; i++) {
      if (!data.getY(i)) continue
      shapes.set(data.getZ(i), [
        shape.getX(i),
        shape.getY(i),
        shape.getZ(i),
        shape.getW(i),
        timing.getX(i),
        timing.getY(i),
      ])
    }
  }
  splashes.dispose()
  return { shapes: [...shapes.values()], returns }
}

describe('wave impacts', () => {
  it('varies successive rendered shapes and replays the same wind and seed deterministically', () => {
    const first = replay(42)
    expect(first.shapes.length).toBeGreaterThan(3)
    // Every rendered shape dimension varies, including breakup and duration.
    for (let dimension = 0; dimension < 6; dimension++)
      expect(new Set(first.shapes.map((shape) => shape[dimension])).size).toBeGreaterThan(3)
    expect(first.returns.length).toBeGreaterThan(0)
    expect(replay(42)).toEqual(first)
    expect(replay(43)).not.toEqual(first)
  })

  it('emits nothing without wind, during reduced motion, or without an obstacle', () => {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    expect(splashes.contacts.length).toBeGreaterThan(0)
    for (let frame = 0; frame < 600; frame++) splashes.update(frame / 30, calm.sample(frame / 30))
    expect(splashes.emitted).toBe(0)
    for (let frame = 0; frame < 600; frame++)
      splashes.update(frame / 30, windy.sample(frame / 30), true)
    expect(splashes.emitted).toBe(0)
    expect(splashes.mesh.visible).toBe(false)
    expect(splashes.sheets.visible).toBe(false)
    splashes.dispose()
    const empty = new LakeSplashes(new Scene(), createLakeBed([], 42, true), 42, true)
    expect(empty.contacts).toHaveLength(0)
    for (let frame = 0; frame < 600; frame++) empty.update(frame / 30, windy.sample(frame / 30))
    expect(empty.emitted).toBe(0)
    empty.dispose()
  })

  it('spreads an impact across a wet face with independent ejection speeds and air drag', () => {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    for (let frame = 0; frame < 600 && !splashes.emitted; frame++)
      splashes.update(frame / 60, windy.sample(frame / 60))
    const drops = (
      splashes as unknown as { drops: Array<Record<string, number> | null> }
    ).drops.filter((drop): drop is Record<string, number> => drop !== null)
    expect(drops.length).toBeGreaterThan(5)
    const span = (key: string) =>
      Math.max(...drops.map((d) => d[key]!)) - Math.min(...drops.map((d) => d[key]!))
    expect(span('z')).toBeGreaterThan(0.15)
    expect(span('vy')).toBeGreaterThan(0.3)
    expect(span('born')).toBeGreaterThan(0.04)
    expect(span('drag')).toBeGreaterThan(2)
    expect(drops.every((drop) => Math.max(Math.abs(drop.x!), Math.abs(drop.z!)) > 2)).toBe(true)
    splashes.dispose()
  })

  it('breaks intermittent windward crests into airborne drops and returns ripples to water', () => {
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true)
    const returns: number[][] = []
    splashes.onReturn = (...impact) => returns.push(impact)
    const matrix = new Matrix4(),
      position = new Vector3(),
      scale = new Vector3()
    let airborneFrames = 0,
      quietFrames = 0,
      sheetFrames = 0
    for (let frame = 0; frame < 1200; frame++) {
      const time = frame / 60
      splashes.update(time, windy.sample(time))
      expect(splashes.active).toBeLessThanOrEqual(splashes.capacity)
      if (splashes.active) airborneFrames++
      else quietFrames++
      if (splashes.sheets.visible) sheetFrames++
      for (let i = 0; i < splashes.capacity; i++) {
        splashes.mesh.getMatrixAt(i, matrix)
        scale.setFromMatrixScale(matrix)
        if (scale.lengthSq() < 0.000001) continue
        expect(matrix.elements.every(Number.isFinite)).toBe(true)
        position.setFromMatrixPosition(matrix)
        expect(position.y).toBeGreaterThanOrEqual(
          WATER_LEVEL +
            sampleWindField(position.x, position.z, time, windy.sample(time), 0.08)[0] -
            0.001,
        )
        // Wind travels +X: west-facing walls break, the sheltered east face does not.
        expect(position.x).toBeLessThan(0)
        expect(Math.max(Math.abs(position.x), Math.abs(position.z))).toBeGreaterThan(1.94)
      }
    }
    expect(splashes.emitted).toBeGreaterThan(0)
    expect(splashes.emitted).toBeLessThan(30)
    expect(airborneFrames).toBeGreaterThan(10)
    expect(quietFrames).toBeGreaterThan(100)
    expect(sheetFrames).toBeGreaterThan(0)
    expect(returns.length).toBeGreaterThan(splashes.emitted * 2)
    expect(splashes.impacts.landed).toBe(returns.length)
    expect(
      returns.every(
        ([x, z, radius, velocity]) =>
          Math.max(Math.abs(x!), Math.abs(z!)) > 2 && radius! > 0 && velocity! < 0,
      ),
    ).toBe(true)
    splashes.dispose()
    expect(scene.children).toHaveLength(0)
  })
})

it('each falling drop hits the moving surface once, with size-dependent impact and a finite ripple lifetime', () => {
  const contactPositions: number[] = []
  for (const hz of [30, 60]) {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    // Two controlled drops over water and one blocked by solid terrain.
    const state = splashes as unknown as { drops: Array<Record<string, number> | null> }
    for (const [i, size] of [0.02, 0.045, 0.03].entries())
      state.drops[i] = {
        x: i === 2 ? 0 : -4,
        z: 0,
        y: WATER_LEVEL + 0.4,
        vx: 0.6,
        vz: 0,
        vy: 0.5,
        born: 0,
        size,
        life: 2,
        lastAge: 0,
      }
    const events: number[][] = []
    splashes.onReturn = (...event) => events.push(event)
    let visible = false
    for (let frame = 0; frame < hz * 2; frame++) {
      const time = frame / hz
      splashes.update(time, calm.sample(time), false, 0)
      visible ||= splashes.impacts.mesh.visible
    }
    expect(events).toHaveLength(2)
    expect(splashes.impacts.landed).toBe(2)
    expect(visible).toBe(true)
    expect(splashes.impacts.active).toBe(0)
    expect(splashes.impacts.mesh.visible).toBe(false)
    expect(Math.abs(events[1]![3]!)).toBeGreaterThan(Math.abs(events[0]![3]!))
    const x = events[0]![0]!,
      t = (x + 4) / 0.6
    const y = WATER_LEVEL + 0.4 + 0.5 * t - 4.905 * t * t
    expect(
      Math.abs(y - WATER_LEVEL - sampleWindField(x, 0, t, calm.sample(t), 0.08)[0]),
    ).toBeLessThan(0.002)
    contactPositions.push(x)
    splashes.dispose()
  }
  expect(Math.abs(contactPositions[0]! - contactPositions[1]!)).toBeLessThan(0.001)
})

it('combines clustered landing waves and clears both the crown and normal contribution', async () => {
  const { SplashImpacts } = await import('./splash-impacts')
  const scene = new Scene()
  const impacts = new SplashImpacts(scene, false)
  impacts.add(0, 0, 0, 0.6)
  impacts.add(0.1, 0.02, 0.04, 0.6)
  impacts.add(2, 0, 0.04, 0.6)
  impacts.update(0.12)
  expect(impacts.landed).toBe(3)
  expect(impacts.active).toBe(2)
  expect(impacts.slopes.count).toBe(2)
  expect(impacts.mesh.visible).toBe(true)
  expect(impacts.slopes.geometry.getAttribute('aLanding').getY(0)).toBeGreaterThan(0.6)
  impacts.update(0.5)
  expect(impacts.mesh.visible).toBe(false)
  expect(impacts.slopes.visible).toBe(true)
  impacts.update(1.5)
  expect(impacts.slopes.visible).toBe(false)
  impacts.add(0, 0, 2, 1)
  impacts.update(2.05, true)
  expect(impacts.active).toBe(0)
  expect(impacts.mesh.visible).toBe(false)
  expect(impacts.slopes.visible).toBe(false)
  impacts.dispose()
  expect(scene.children).toHaveLength(0)
})

it('keeps wind-dragged landing positions stable across frame rates', () => {
  const landings: number[][] = []
  for (const hz of [30, 60, 120]) {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    const state = splashes as unknown as { drops: Array<Record<string, number> | null> }
    state.drops[0] = {
      x: -4,
      y: WATER_LEVEL + 0.3,
      z: 0,
      vx: -0.8,
      vy: 1.4,
      vz: 0.4,
      windX: 0.3,
      windZ: 0.1,
      drag: 4,
      born: 0,
      size: 0.025,
      life: 2,
      lastAge: 0,
    }
    const events: number[][] = []
    splashes.onReturn = (...event) => events.push(event)
    for (let frame = 0; frame < hz * 2; frame++)
      splashes.update(frame / hz, calm.sample(frame / hz), false, 0)
    expect(events).toHaveLength(1)
    landings.push(events[0]!)
    splashes.dispose()
  }
  for (const landing of landings.slice(1)) {
    expect(Math.abs(landing[0]! - landings[0]![0]!)).toBeLessThan(0.001)
    expect(Math.abs(landing[1]! - landings[0]![1]!)).toBeLessThan(0.001)
  }
})

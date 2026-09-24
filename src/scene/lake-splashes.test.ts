import { Matrix4, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
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
  it('restores inactive batches before asynchronous compilation settles, including failure', async () => {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    const meshes = [splashes.mesh, splashes.sheets, splashes.impacts.mesh, splashes.impacts.slopes]
    const before = meshes.map((mesh) => ({ visible: mesh.visible, count: mesh.count }))
    const matrixVersions = meshes.map((mesh) => mesh.instanceMatrix.version)
    const failure = new Error('Compilation cancelled')
    let rejectCompilation: (error: Error) => void = () => {
      throw failure
    }
    const pending = new Promise<void>((_resolve, reject) => {
      rejectCompilation = reject
    })
    try {
      const compiling = splashes.compileAsync(() => {
        expect(meshes.every((mesh) => mesh.visible && mesh.count > 0)).toBe(true)
        return pending
      })
      expect(meshes.map((mesh) => ({ visible: mesh.visible, count: mesh.count }))).toEqual(before)
      expect(meshes.map((mesh) => mesh.instanceMatrix.version)).toEqual(matrixVersions)
      expect(splashes.emitted).toBe(0)
      splashes.warmup(() => {
        expect(meshes.every((mesh) => mesh.visible && mesh.count > 0)).toBe(true)
      })
      expect(meshes.map((mesh) => ({ visible: mesh.visible, count: mesh.count }))).toEqual(before)
      rejectCompilation(failure)
      await expect(compiling).rejects.toBe(failure)
      expect(meshes.map((mesh) => ({ visible: mesh.visible, count: mesh.count }))).toEqual(before)
      expect(() =>
        splashes.compileAsync(() => {
          throw failure
        }),
      ).toThrow(failure)
      expect(meshes.map((mesh) => ({ visible: mesh.visible, count: mesh.count }))).toEqual(before)
    } finally {
      splashes.dispose()
    }
  })

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

  it('spreads a rendered impact across the wet face', () => {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    const positions: Vector3[] = [],
      matrix = new Matrix4(),
      scale = new Vector3()
    const observed = new Set<number>()
    let firstEmission: number | undefined
    for (let frame = 0; frame < 600; frame++) {
      const time = frame / 60
      if (firstEmission !== undefined && time - firstEmission > 0.6) break
      splashes.update(time, windy.sample(time))
      for (let i = 0; i < splashes.capacity; i++) {
        if (observed.has(i)) continue
        splashes.mesh.getMatrixAt(i, matrix)
        scale.setFromMatrixScale(matrix)
        if (scale.lengthSq() > 0.000001) {
          firstEmission ??= time
          observed.add(i)
          positions.push(new Vector3().setFromMatrixPosition(matrix))
        }
      }
    }
    expect(positions.length).toBeGreaterThan(5)
    // Observe the complete emission on either wall orientation, rather than its first frame.
    const spanX = Math.max(...positions.map((p) => p.x)) - Math.min(...positions.map((p) => p.x))
    const spanZ = Math.max(...positions.map((p) => p.z)) - Math.min(...positions.map((p) => p.z))
    expect(Math.max(spanX, spanZ)).toBeGreaterThan(0.15)
    expect(positions.every((p) => Math.max(Math.abs(p.x), Math.abs(p.z)) > 1.94)).toBe(true)
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
          Math.max(Math.abs(required(x)), Math.abs(required(z))) > 2 &&
          required(radius) > 0 &&
          required(velocity) < 0,
      ),
    ).toBe(true)
    splashes.dispose()
    expect(scene.children).toHaveLength(0)
  })
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
  const landings: number[][][] = []
  for (const hz of [30, 60, 120]) {
    const splashes = new LakeSplashes(new Scene(), bed, 42, true)
    let born = 0
    for (let frame = 0; frame < 600 && !splashes.emitted; frame++) {
      born = frame / 60
      splashes.update(born, windy.sample(born))
    }
    const events: number[][] = []
    splashes.onReturn = (...event) => events.push(event)
    for (let frame = 1; frame < hz * 3; frame++) {
      const time = born + frame / hz
      splashes.update(time, windy.sample(time), false, 0)
    }
    expect(events.length).toBeGreaterThan(5)
    expect(splashes.impacts.landed).toBe(events.length)
    expect(splashes.impacts.active).toBe(0)
    landings.push(events.toSorted((a, b) => required(a[1]) - required(b[1])))
    splashes.dispose()
  }
  const reference = required(landings[0])
  for (const events of landings.slice(1)) {
    expect(events).toHaveLength(reference.length)
    for (let i = 0; i < events.length; i++) {
      const event = required(events[i]),
        expected = required(reference[i])
      expect(Math.abs(required(event[0]) - required(expected[0]))).toBeLessThan(0.003)
      expect(Math.abs(required(event[1]) - required(expected[1]))).toBeLessThan(0.003)
    }
  }
})

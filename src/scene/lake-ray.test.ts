import { Scene } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { bedDepth } from './lake-fish'
import { LakeRay, rayOutlineRadius, rayPose, selectRayCircuit } from './lake-ray'
import { createVoxelWorld } from './voxel-world'

const beds = new Map<string, LakeBed>()
const cases = [false, true].flatMap((mobile) => [0, 12, 42, 9182].map((seed) => ({ mobile, seed })))
function lakeBed(seed: number, mobile: boolean) {
  const key = `${seed}:${mobile}`
  let bed = beds.get(key)
  if (!bed) {
    bed = createVoxelWorld(seed, mobile).lakeBed
    beds.set(key, bed)
  }
  return bed
}

describe('gliding ray', () => {
  it.each(cases)(
    'keeps the circuit over water with bed clearance (mobile=$mobile, seed=$seed)',
    ({ mobile, seed }) => {
      const bed = lakeBed(seed, mobile)
      const circuit = selectRayCircuit(bed, seed)
      expect(circuit).toEqual(selectRayCircuit(bed, seed))
      const ray = new LakeRay(new Scene(), bed, seed, false)
      let visible = 0
      const hidden: { x: number; z: number }[] = []
      for (let t = 0; t < 240; t += 2) {
        ray.update(t, 2)
        const pose = ray.group.position
        const at = lakeIndex(bed, pose.x, pose.z)
        if (!ray.group.visible) {
          hidden.push({ x: pose.x, z: pose.z })
          continue
        }
        visible++
        expect(at).toBeGreaterThanOrEqual(0)
        expect(bed.water[at]).toBe(255)
        expect(WATER_LEVEL - pose.y).toBeLessThan(bedDepth(bed, pose.x, pose.z) - 0.2)
        expect(pose.y).toBeLessThan(WATER_LEVEL - 0.3)
      }
      expect(visible).toBeGreaterThan(100)
      for (const pose of hidden) {
        const at = lakeIndex(bed, pose.x, pose.z)
        expect(at < 0 || !required(bed.water[at]) || required(bed.depth[at]) < 0.8).toBe(true)
      }
      ray.dispose()
    },
  )

  it.each(cases)(
    'glides without vertical snaps or blinking (mobile=$mobile, seed=$seed)',
    ({ mobile, seed }) => {
      const ray = new LakeRay(new Scene(), lakeBed(seed, mobile), seed, false)
      ray.update(0, 0.1)
      let previous = ray.group.position.y
      let transitions = 0
      let wasVisible = ray.group.visible
      for (let t = 0.1; t < 120; t += 0.1) {
        ray.update(t, 0.1)
        const y = ray.group.position.y
        expect(Math.abs(y - previous)).toBeLessThan(0.12)
        previous = y
        if (ray.group.visible !== wasVisible) transitions++
        wasVisible = ray.group.visible
      }
      expect(transitions).toBe(0)
      ray.dispose()
    },
  )

  it('reports a unit wake heading with speed only while swimming', () => {
    const bed = lakeBed(12, true)
    const swimming = new LakeRay(new Scene(), bed, 12, false)
    for (let t = 0; t < 4; t += 0.5) swimming.update(t, 0.5)
    const wake = swimming.wake
    expect(Math.hypot(wake.hx, wake.hz)).toBeCloseTo(1, 5)
    expect(wake.speed).toBeGreaterThan(0.2)
    const frozen = new LakeRay(new Scene(), bed, 12, true)
    for (let t = 0; t < 4; t += 0.5) frozen.update(t, 0.5)
    expect(frozen.wake.speed).toBe(0)
    swimming.dispose()
    frozen.dispose()
  })

  it('keeps a smooth symmetric outline with swept-back wingtips', () => {
    expect(rayOutlineRadius(0)).toBeCloseTo(0.72, 5)
    expect(rayOutlineRadius(Math.PI)).toBeCloseTo(0.55, 5)
    expect(rayOutlineRadius((120 * Math.PI) / 180)).toBeCloseTo(1.55, 5)
    for (const t of [0.3, 0.9, 1.7, 2.6]) {
      expect(rayOutlineRadius(t)).toBeCloseTo(rayOutlineRadius(-t), 10)
    }
    let maxStep = 0
    const samples = 720
    for (let i = 0; i < samples; i++) {
      const a = rayOutlineRadius((i / samples) * Math.PI * 2)
      const b = rayOutlineRadius(((i + 1) / samples) * Math.PI * 2)
      maxStep = Math.max(maxStep, Math.abs(b - a))
    }
    expect(maxStep).toBeLessThan(0.025)
  })

  it('builds the disc with upward smooth normals', () => {
    const ray = new LakeRay(new Scene(), lakeBed(12, true), 12, false)
    const normals = ray.disc.geometry.getAttribute('normal')
    let y = 0
    for (let i = 0; i < normals.count; i++) {
      const ny = normals.getY(i)
      expect(Number.isNaN(ny)).toBe(false)
      y += ny
    }
    expect(y / normals.count).toBeGreaterThan(0.9)
    ray.dispose()
  })

  it('moves continuously and freezes with reduced motion', () => {
    const bed = lakeBed(12, true)
    expect(rayPose(selectRayCircuit(bed, 12), 0.1)).not.toEqual(
      rayPose(selectRayCircuit(bed, 12), 0),
    )
    const frozen = new LakeRay(new Scene(), bed, 12, true)
    frozen.update(0)
    const still = frozen.group.position.clone()
    frozen.update(60)
    expect(frozen.group.position.equals(still)).toBe(true)
    const swimming = new LakeRay(new Scene(), bed, 12, false)
    swimming.update(0)
    swimming.update(60)
    expect(swimming.group.position.equals(still)).toBe(false)
    frozen.dispose()
    swimming.dispose()
  })
})

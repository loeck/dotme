import {
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
} from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { apparentFishSurface } from './fish-pointer'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { createFishHabitats, LakeFish } from './lake-fish'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { createVoxelIndex } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import { createVoxelWorld } from './voxel-world'

// Worlds are immutable inputs; retain only the lake data needed by these tests.
const worlds = new Map<string, { bed: LakeBed; index: VoxelIndex }>()
const cases = [false, true].flatMap((mobile) => [0, 12, 42, 9182].map((seed) => ({ mobile, seed })))
function lakeData(seed: number, mobile: boolean) {
  const key = `${seed}:${mobile}`
  let entry = worlds.get(key)
  if (!entry) {
    const world = createVoxelWorld(seed, mobile)
    entry = { bed: world.lakeBed, index: createVoxelIndex(world.voxels) }
    worlds.set(key, entry)
  }
  return entry
}
function lakeBed(seed: number, mobile: boolean) {
  return lakeData(seed, mobile).bed
}
const physicsFor = async (seed: number, mobile: boolean) =>
  createPhysicsWorld(await loadPhysics(), lakeData(seed, mobile).index)

/** Height of the actual two-triangle cell used by SubmergedScene's mesh. */
function bottomHeight(bed: LakeBed, x: number, z: number) {
  const n = bed.resolution
  const u = ((x - LAKE_BOUNDS.minX) * n) / LAKE_BOUNDS.size - 0.5
  const v = ((z - LAKE_BOUNDS.minZ) * n) / LAKE_BOUNDS.size - 0.5
  const fx = u - Math.floor(u)
  const fz = v - Math.floor(v)
  const i = Math.floor(v) * n + Math.floor(u)
  const depth =
    fx + fz < 1
      ? required(bed.depth[i]) * (1 - fx - fz) +
        required(bed.depth[i + 1]) * fx +
        required(bed.depth[i + n]) * fz
      : required(bed.depth[i + n + 1]) * (fx + fz - 1) +
        required(bed.depth[i + 1]) * (1 - fz) +
        required(bed.depth[i + n]) * (1 - fx)
  return WATER_LEVEL - depth
}

describe('submerged fish', () => {
  it.each(cases)(
    'keeps actual shoals submerged and clear of terrain for a full passage (mobile=$mobile, seed=$seed)',
    async ({ mobile, seed }) => {
      const matrix = new Matrix4()
      const position = new Vector3()
      const bed = lakeBed(seed, mobile)
      const physics = await physicsFor(seed, mobile)
      const fish = new LakeFish(new Scene(), bed, seed, mobile, physics)
      const repeat = new LakeFish(new Scene(), bed, seed, mobile, physics)
      expect(fish.schools).toEqual(repeat.schools)
      expect(fish.schoolSizes).toEqual(repeat.schoolSizes)
      expect(fish.count).toBeGreaterThan(0)
      expect(fish.count).toBeLessThanOrEqual(mobile ? 15 : 26)
      repeat.dispose()
      const visibleCounts = new Set<number>()
      let highestFish = -Infinity
      let leastClearance = Infinity
      let outsideWater = 0
      for (let frame = 0; frame < 600; frame++) {
        fish.update(frame / 10, 0.1, required(fish.habitats[0]))
        if (frame % 10 !== 0) continue
        let visible = 0
        for (const mesh of fish.meshes) {
          for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, matrix)
            position.setFromMatrixPosition(matrix)
            highestFish = Math.max(highestFish, position.y + 0.2)
            for (const dx of [-0.5, 0, 0.5]) {
              for (const dz of [-0.5, 0, 0.5]) {
                if (bed.water[lakeIndex(bed, position.x + dx, position.z + dz)] !== 255)
                  outsideWater++
                leastClearance = Math.min(
                  leastClearance,
                  position.y - 0.2 - bottomHeight(bed, position.x + dx, position.z + dz),
                )
              }
            }
            if (mesh.geometry.getAttribute('aFishVisibility').getX(i) > 0.1) visible++
          }
        }
        visibleCounts.add(visible)
      }
      expect(highestFish).toBeLessThan(WATER_LEVEL - 1)
      expect(leastClearance).toBeGreaterThan(0)
      expect(outsideWater).toBe(0)
      expect(visibleCounts.size).toBeGreaterThan(2)
      expect(Math.max(...visibleCounts)).toBeGreaterThan(Math.max(...fish.schoolSizes))
      fish.dispose()
      physics.dispose()
    },
  )

  it.each(cases)(
    'keeps the opening shoal inside the refracted camera projection (mobile=$mobile, seed=$seed)',
    async ({ mobile, seed }) => {
      const matrix = new Matrix4()
      const position = new Vector3()
      const camera = new PerspectiveCamera(54, mobile ? 390 / 844 : 1280 / 720, 0.05, 500)
      camera.position.set(0, 2.3, 16)
      camera.lookAt(0, mobile ? 2.3 : 7.3, -25)
      camera.updateMatrixWorld()
      const physics = await physicsFor(seed, mobile)
      const fish = new LakeFish(new Scene(), lakeBed(seed, mobile), seed, mobile, physics)
      for (let i = 0; i < required(fish.schoolSizes[0]); i++) {
        required(fish.meshes[i % 3]).getMatrixAt(Math.floor(i / 3), matrix)
        position.setFromMatrixPosition(matrix)
        apparentFishSurface(position, camera.position, position).project(camera)
        expect(Math.abs(position.x)).toBeLessThan(0.95)
        expect(position.y).toBeGreaterThan(-0.94)
        expect(position.y).toBeLessThan(0)
      }
      fish.dispose()
      physics.dispose()
    },
  )

  it('reacts smoothly, uses its own optical layer and disposes its batch', async () => {
    const scene = new Scene()
    const bed = lakeBed(12, true)
    const physics = await physicsFor(12, true)
    const fish = new LakeFish(scene, bed, 12, true, physics)
    expect(fish.count).toBe(15)
    expect(fish.schoolSizes).toEqual([6, 4, 5])
    expect(fish.mesh.layers.mask).toBe(8)
    const matrix = new Matrix4()
    const before = new Vector3()
    const after = new Vector3()
    fish.mesh.getMatrixAt(0, matrix)
    const size = new Vector3().setFromMatrixScale(matrix)
    expect(size.x).toBeGreaterThan(0.15)
    expect(size.x).toBeLessThan(0.42)
    expect(size.z).toBeGreaterThan(0.35)
    expect(size.z).toBeLessThan(0.85)
    // The articulated body and tail fit the validated swimming footprint.
    const positions = fish.mesh.geometry.getAttribute('position')
    const normals = fish.mesh.geometry.getAttribute('normal')
    expect(positions.count).toBeGreaterThan(200)
    expect(fish.meshes.reduce((total, mesh) => total + mesh.count, 0)).toBe(fish.count)
    for (let i = 0; i < positions.count; i++) {
      const maxX = (Math.abs(positions.getX(i)) + 0.35) * size.x
      expect(Math.hypot(maxX, positions.getZ(i) * size.z)).toBeLessThan(0.8)
    }
    for (let i = 0; i < normals.count; i++)
      expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 5)
    before.setFromMatrixPosition(matrix)
    fish.update(1 / 60, 1 / 60, before)
    fish.mesh.getMatrixAt(0, matrix)
    after.setFromMatrixPosition(matrix)
    expect(before.distanceTo(after)).toBeGreaterThan(0)
    expect(before.distanceTo(after)).toBeLessThan(0.06)
    const index = lakeIndex(bed, after.x, after.z)
    expect(after.y - 0.29).toBeGreaterThan(WATER_LEVEL - required(bed.depth[index]))
    expect(after.y + 0.29).toBeLessThan(WATER_LEVEL)
    fish.dispose()
    physics.dispose()
    expect(scene.children).toHaveLength(0)
  })

  it('keeps a tapered silhouette with a genuinely forked vertical tail', async () => {
    const physics = await physicsFor(42, true)
    const fish = new LakeFish(new Scene(), lakeBed(42, true), 42, true, physics)
    const material = new MeshBasicMaterial({ side: DoubleSide })
    const silhouette = new Mesh(fish.mesh.geometry, material)
    const ray = new Raycaster(new Vector3(2, 0, -0.76), new Vector3(-1, 0, 0), 0, 4)
    expect(ray.intersectObject(silhouette)).toHaveLength(0)
    ray.ray.origin.y = 0.22
    expect(ray.intersectObject(silhouette).length).toBeGreaterThan(0)
    ray.ray.origin.y = -0.22
    expect(ray.intersectObject(silhouette).length).toBeGreaterThan(0)
    expect(fish.mesh.geometry.getAttribute('position').count).toBeLessThan(500)
    material.dispose()
    fish.dispose()
    physics.dispose()
  })

  it('fades pointer avoidance to zero at the screen-space hover boundary', async () => {
    const bed = lakeBed(12, true)
    const physics = await physicsFor(12, true)
    const baseline = new LakeFish(new Scene(), bed, 12, true, physics)
    const boundary = new LakeFish(new Scene(), bed, 12, true, physics)
    const hovered = new LakeFish(new Scene(), bed, 12, true, physics)
    const matrix = new Matrix4()
    const position = new Vector3()
    const displaced = new Vector3()
    for (let frame = 1; frame <= 60; frame++) {
      baseline.update(frame / 60, 1 / 60)
      baseline.mesh.getMatrixAt(0, matrix)
      position.setFromMatrixPosition(matrix)
      const pointer = { x: position.x + 0.3, z: position.z, strength: 0 }
      boundary.update(frame / 60, 1 / 60, pointer)
      hovered.mesh.getMatrixAt(0, matrix)
      const previous = new Vector3().setFromMatrixPosition(matrix)
      hovered.update(frame / 60, 1 / 60, { ...pointer, strength: 1 })
      hovered.mesh.getMatrixAt(0, matrix)
      const movement = new Vector3().setFromMatrixPosition(matrix).sub(previous)
      movement.y = 0
      const forward = new Vector3(matrix.elements[8], 0, matrix.elements[10]).normalize()
      // Escape must follow the fish's nose, never slide sideways as a rigid sprite.
      expect(movement.normalize().dot(forward)).toBeGreaterThan(0.995)
    }
    expect(boundary.mesh.instanceMatrix.array).toEqual(baseline.mesh.instanceMatrix.array)
    hovered.mesh.getMatrixAt(0, matrix)
    displaced.setFromMatrixPosition(matrix)
    expect(displaced.distanceTo(position)).toBeGreaterThan(0.05)
    expect(displaced.distanceTo(position)).toBeLessThan(0.65)
    for (const fish of [baseline, boundary, hovered]) fish.dispose()
    physics.dispose()
  })

  it('steers toward clicked bait while the shoal route still reforms', async () => {
    const bed = lakeBed(12, true)
    const physics = await physicsFor(12, true)
    const baseline = new LakeFish(new Scene(), bed, 12, true, physics)
    const fed = new LakeFish(new Scene(), bed, 12, true, physics)
    const matrix = new Matrix4()
    const position = new Vector3()
    baseline.update(1 / 60, 1 / 60)
    fed.update(1 / 60, 1 / 60)
    baseline.mesh.getMatrixAt(0, matrix)
    position.setFromMatrixPosition(matrix)
    const bait = { x: position.x + 1.5, z: position.z, strength: 1 }
    for (let frame = 2; frame <= 120; frame++) {
      baseline.update(frame / 60, 1 / 60)
      fed.update(frame / 60, 1 / 60, null, null, bait)
    }
    const plain = new Vector3()
    const hungry = new Vector3()
    baseline.mesh.getMatrixAt(0, matrix)
    plain.setFromMatrixPosition(matrix)
    fed.mesh.getMatrixAt(0, matrix)
    hungry.setFromMatrixPosition(matrix)
    const target = new Vector3(bait.x, hungry.y, bait.z)
    expect(hungry.distanceTo(target)).toBeLessThan(plain.distanceTo(target))
    for (const fish of [baseline, fed]) fish.dispose()
    physics.dispose()
  })

  it('contains three distinct anatomical profiles with deterministic individual sizes', async () => {
    const bed = lakeBed(42, true)
    const physics = await physicsFor(42, true)
    const fish = new LakeFish(new Scene(), bed, 42, true, physics)
    const repeat = new LakeFish(new Scene(), bed, 42, true, physics)
    expect(fish.appearances).toEqual(repeat.appearances)
    expect(new Set(fish.appearances.map((appearance) => appearance.species)).size).toBe(3)
    expect(new Set(fish.appearances.map((appearance) => appearance.scale)).size).toBe(fish.count)
    expect(fish.mesh.children).toHaveLength(2)
    for (const batch of fish.meshes) {
      expect(batch.layers.mask).toBe(8)
      expect(Array.isArray(batch.material)).toBe(false)
      expect(batch.geometry.getAttribute('aFishVisibility')).toBeDefined()
    }
    fish.dispose()
    repeat.dispose()
    physics.dispose()
  })

  it('freezes motion and pointer reactions for reduced motion', async () => {
    const scene = new Scene()
    const bed = lakeBed(12, true)
    const physics = await physicsFor(12, true)
    const fish = new LakeFish(scene, bed, 12, true, physics, true)
    const initial = fish.meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))
    const initialMotion = fish.meshes.map((mesh) =>
      Array.from(mesh.geometry.getAttribute('aFishPhase').array),
    )
    fish.update(100, 0.016, { x: 0, z: 0 })
    expect(fish.meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))).toEqual(initial)
    expect(
      fish.meshes.map((mesh) => Array.from(mesh.geometry.getAttribute('aFishPhase').array)),
    ).toEqual(initialMotion)
    fish.dispose()
    physics.dispose()
  })

  it('advances compact shoals through water with continuous tail phases', async () => {
    const bed = lakeBed(42, true)
    const physics = await physicsFor(42, true)
    const fish = new LakeFish(new Scene(), bed, 42, true, physics)
    expect(fish.count).toBeGreaterThan(0)
    const previousPhases = fish.appearances.map((_, i) =>
      required(fish.meshes[i % 3])
        .geometry.getAttribute('aFishPhase')
        .getX(Math.floor(i / 3)),
    )
    let minPhaseStep = Infinity
    let maxPhaseStep = -Infinity
    // Cover a complete passage, including the shallowest part of its route.
    for (let frame = 1; frame <= 720; frame++) {
      fish.update(frame / 10, 0.1, {
        x: required(fish.habitats[0]).x,
        z: required(fish.habitats[0]).z,
      })
      for (let i = 0; i < fish.count; i++) {
        const batch = required(fish.meshes[i % 3])
        const instance = Math.floor(i / 3)
        const phase = batch.geometry.getAttribute('aFishPhase').getX(instance)
        const phaseStep = phase - required(previousPhases[i])
        minPhaseStep = Math.min(minPhaseStep, phaseStep)
        maxPhaseStep = Math.max(maxPhaseStep, phaseStep)
        previousPhases[i] = phase
      }
    }
    expect(minPhaseStep).toBeGreaterThan(0)
    expect(maxPhaseStep).toBeLessThan(0.9)
    fish.dispose()
    physics.dispose()
  })

  it('omits shoals when there is no safe water', async () => {
    const bed = lakeBed(12, true)
    const dry = { ...bed, water: new Uint8Array(bed.water.length) }
    expect(createFishHabitats(dry, 12, 3)).toEqual([])
    const physics = await physicsFor(12, true)
    const fish = new LakeFish(new Scene(), dry, 12, true, physics)
    expect(fish.count).toBe(0)
    fish.dispose()
    physics.dispose()
  })
})

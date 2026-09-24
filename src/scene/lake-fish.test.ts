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

import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { createFishHabitats, LakeFish, sampleFishPose } from './lake-fish'
import { createVoxelWorld } from './voxel-world'

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
      ? bed.depth[i]! * (1 - fx - fz) + bed.depth[i + 1]! * fx + bed.depth[i + n]! * fz
      : bed.depth[i + n + 1]! * (fx + fz - 1) +
        bed.depth[i + 1]! * (1 - fz) +
        bed.depth[i + n]! * (1 - fx)
  return WATER_LEVEL - depth
}

describe('submerged fish', () => {
  it('places deterministic shoals entirely in water across seeds and quality levels', () => {
    for (const mobile of [false, true]) {
      for (const seed of [0, 12, 42, 9182]) {
        const bed = createVoxelWorld(seed, mobile).lakeBed
        const habitats = createFishHabitats(bed, seed, mobile ? 3 : 6, mobile)
        expect(habitats).toHaveLength(mobile ? 3 : 6)
        expect(habitats).toEqual(createFishHabitats(bed, seed, mobile ? 3 : 6, mobile))
        const pose = { x: 0, y: 0, z: 0, heading: 0 }
        for (const habitat of habitats) {
          for (let time = 0; time < 100; time += 0.7) {
            for (const fishIndex of [0, 1]) {
              // Move the pointer around/through the orbit, including direct contact.
              const pointer = {
                x: habitat.x + Math.sin(time) * 2,
                z: habitat.z + Math.cos(time) * 2,
              }
              sampleFishPose(bed, habitat, fishIndex, time, pointer, pose)
              expect(Math.hypot(pose.x - habitat.x, pose.z - habitat.z)).toBeLessThanOrEqual(
                habitat.radius + 1e-8,
              )
              for (const offsetX of [-0.8, 0, 0.8]) {
                for (const offsetZ of [-0.8, 0, 0.8]) {
                  const i = lakeIndex(bed, pose.x + offsetX, pose.z + offsetZ)
                  expect(i).toBeGreaterThanOrEqual(0)
                  expect(bed.water[i]).toBe(255)
                  expect(pose.y - 0.2).toBeGreaterThan(
                    bottomHeight(bed, pose.x + offsetX, pose.z + offsetZ),
                  )
                  expect(pose.y + 0.2).toBeLessThan(WATER_LEVEL)
                }
              }
              for (const [offsetX, offsetZ] of [
                [-0.8, 0],
                [0.8, 0],
                [0, -0.8],
                [0, 0.8],
              ]) {
                expect(
                  pose.y + 0.2 - bottomHeight(bed, pose.x + offsetX!, pose.z + offsetZ!),
                ).toBeLessThan(2.2)
              }
              // Highest captured fin remains below the rejection threshold;
              // slopes can soften contrast slightly but never erase the fish.
              expect(pose.y + 0.2 - bottomHeight(bed, pose.x, pose.z)).toBeLessThan(1.5)
            }
          }
        }
      }
    }
  })

  it('always keeps a readable foreground pair inside the actual camera projection', () => {
    const projected = new Vector3()
    const pose = { x: 0, y: 0, z: 0, heading: 0 }
    for (const mobile of [false, true]) {
      const camera = new PerspectiveCamera(54, mobile ? 390 / 844 : 1280 / 720, 0.05, 500)
      camera.position.set(0, 2.3, 16)
      camera.lookAt(0, mobile ? 2.3 : 7.3, -25)
      camera.updateMatrixWorld()
      for (const seed of [0, 12, 42, 9182]) {
        const bed = createVoxelWorld(seed, mobile).lakeBed
        const habitat = createFishHabitats(bed, seed, mobile ? 3 : 6, mobile)[0]!
        expect(habitat.z).toBeGreaterThan(-8)
        expect(habitat.z).toBeLessThan(5)
        for (const index of [0, 1]) {
          sampleFishPose(bed, habitat, index, 0, null, pose)
          expect(Math.abs(Math.sin(pose.heading))).toBeGreaterThan(0.95)
        }
        for (let time = 0; time < 60; time += 1.3) {
          for (const index of [0, 1]) {
            sampleFishPose(bed, habitat, index, time, { x: habitat.x, z: habitat.z }, pose)
            projected.set(pose.x, pose.y, pose.z).project(camera)
            expect(Math.abs(projected.x)).toBeLessThan(0.88)
            expect(projected.y).toBeGreaterThan(-0.94)
            expect(projected.y).toBeLessThan(0)
            // The body alone spans several display pixels, independent of atlas sampling.
            const width = mobile ? 0.58 : 0.48
            const left = new Vector3(pose.x - width / 2, pose.y, pose.z).project(camera)
            const right = new Vector3(pose.x + width / 2, pose.y, pose.z).project(camera)
            const pixels = ((right.x - left.x) * (mobile ? 390 : 1280)) / 2
            expect(pixels).toBeGreaterThan(4)
          }
        }
      }
    }
  })

  it('reacts smoothly, stays on layer 1 and disposes its batch', () => {
    const scene = new Scene()
    const bed = createVoxelWorld(12, true).lakeBed
    const fish = new LakeFish(scene, bed, 12, true)
    expect(fish.count).toBe(6)
    expect(fish.mesh.layers.mask).toBe(2)
    const matrix = new Matrix4()
    const before = new Vector3()
    const after = new Vector3()
    fish.mesh.getMatrixAt(0, matrix)
    const size = new Vector3().setFromMatrixScale(matrix)
    expect(size.x).toBeGreaterThan(LAKE_BOUNDS.size / 512)
    expect(size.z).toBeGreaterThan((LAKE_BOUNDS.size / 512) * 2)
    // The merged smooth body and animated fan both fit the validated footprint.
    const positions = fish.mesh.geometry.getAttribute('position')
    const tail = fish.mesh.geometry.getAttribute('aFishTail')
    const normals = fish.mesh.geometry.getAttribute('normal')
    expect(positions.count).toBeGreaterThan(200)
    expect(fish.meshes.reduce((total, mesh) => total + mesh.count, 0)).toBe(fish.count)
    for (let i = 0; i < positions.count; i++) {
      const maxX = (Math.abs(positions.getX(i)) + tail.getX(i) * 0.12) * size.x
      expect(Math.hypot(maxX, positions.getZ(i) * size.z)).toBeLessThan(0.8)
    }
    expect(Array.from(normals.array).some((normal) => normal > 0.2 && normal < 0.8)).toBe(true)
    before.setFromMatrixPosition(matrix)
    fish.update(1 / 60, 1 / 60, before)
    fish.mesh.getMatrixAt(0, matrix)
    after.setFromMatrixPosition(matrix)
    expect(before.distanceTo(after)).toBeGreaterThan(0)
    expect(before.distanceTo(after)).toBeLessThan(0.06)
    const index = lakeIndex(bed, after.x, after.z)
    // Captured fish must remain inside the refraction shader's bottom-validity band.
    expect(after.y - (WATER_LEVEL - bed.depth[index]!)).toBeLessThan(1.2)
    fish.dispose()
    expect(scene.children).toHaveLength(0)
  })

  it('has a true vertical fork, narrow peduncle and curved paired lateral fins', () => {
    const fish = new LakeFish(new Scene(), createVoxelWorld(42, true).lakeBed, 42, true)
    const material = new MeshBasicMaterial({ side: DoubleSide })
    const silhouette = new Mesh(fish.mesh.geometry, material)
    const ray = new Raycaster(new Vector3(0, 2, 0), new Vector3(0, -1, 0), 0, 4)
    const hits = (x: number, z: number) => {
      ray.ray.origin.set(x, 2, z)
      return ray.intersectObject(silhouette).length
    }
    expect(hits(0.2, -0.35)).toBe(0)
    expect(hits(0.2, 0.12)).toBeGreaterThan(0)
    expect(hits(-0.55, -0.025)).toBeGreaterThan(0)
    expect(hits(0.55, -0.025)).toBeGreaterThan(0)
    ray.ray.direction.set(-1, 0, 0)
    const sideHits = (y: number, z: number) => {
      ray.ray.origin.set(2, y, z)
      return ray.intersectObject(silhouette).length
    }
    expect(sideHits(0, -0.64)).toBe(0)
    expect(sideHits(-0.8, -0.66)).toBeGreaterThan(0)
    expect(sideHits(0.8, -0.66)).toBeGreaterThan(0)
    material.dispose()
    fish.dispose()
  })

  it('contains three distinct anatomical profiles with deterministic individual sizes', () => {
    const bed = createVoxelWorld(42, true).lakeBed
    const fish = new LakeFish(new Scene(), bed, 42, true)
    const repeat = new LakeFish(new Scene(), bed, 42, true)
    expect(fish.appearances).toEqual(repeat.appearances)
    expect(new Set(fish.appearances.map((appearance) => appearance.species)).size).toBe(3)
    expect(new Set(fish.appearances.map((appearance) => appearance.scale)).size).toBe(6)
    expect(fish.mesh.children).toHaveLength(2)
    const material = new MeshBasicMaterial({ side: DoubleSide })
    const ray = new Raycaster(new Vector3(0.44, 2, 0.12), new Vector3(0, -1, 0), 0, 4)
    const silhouettes = fish.meshes.map((mesh) => new Mesh(mesh.geometry, material))
    expect(ray.intersectObject(silhouettes[0]!).length).toBeGreaterThan(0)
    expect(ray.intersectObject(silhouettes[1]!).length).toBe(0)
    for (const batch of fish.meshes) {
      expect(batch.layers.mask).toBe(2)
      const position = batch.geometry.getAttribute('position')
      const bend = batch.geometry.getAttribute('aFishTail')
      for (let i = 0; i < position.count; i++) {
        const maxX = (Math.abs(position.getX(i)) + bend.getX(i) * 0.11) * 0.58
        expect(Math.hypot(maxX, position.getZ(i) * 0.95)).toBeLessThan(0.8)
        expect(Math.abs(position.getY(i) * 0.24)).toBeLessThan(0.29)
      }
    }
    material.dispose()
    fish.dispose()
    repeat.dispose()
  })

  it('freezes motion and pointer reactions for reduced motion', () => {
    const scene = new Scene()
    const bed = createVoxelWorld(12, true).lakeBed
    const fish = new LakeFish(scene, bed, 12, true, true)
    const initial = fish.meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))
    const initialMotion = fish.meshes.map((mesh) =>
      Array.from(mesh.geometry.getAttribute('aFishMotion').array),
    )
    fish.update(100, 0.016, { x: 0, z: 0 })
    expect(fish.meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))).toEqual(initial)
    expect(
      fish.meshes.map((mesh) => Array.from(mesh.geometry.getAttribute('aFishMotion').array)),
    ).toEqual(initialMotion)
    fish.dispose()
  })

  it('advances all three batches inside their safe habitats with continuous tail phases', () => {
    const bed = createVoxelWorld(42, true).lakeBed
    const fish = new LakeFish(new Scene(), bed, 42, true)
    const matrix = new Matrix4()
    const position = new Vector3()
    const previousPhases = fish.appearances.map((_, i) =>
      fish.meshes[i % 3]!.geometry.getAttribute('aFishMotion').getX(Math.floor(i / 3)),
    )
    for (let frame = 1; frame <= 360; frame++) {
      fish.update(frame / 60, 1 / 60, { x: fish.habitats[0]!.x, z: fish.habitats[0]!.z })
      for (let i = 0; i < fish.count; i++) {
        const batch = fish.meshes[i % 3]!
        const instance = Math.floor(i / 3)
        const habitat = fish.habitats[Math.floor(i / 2)]!
        batch.getMatrixAt(instance, matrix)
        position.setFromMatrixPosition(matrix)
        expect(Math.hypot(position.x - habitat.x, position.z - habitat.z)).toBeLessThanOrEqual(
          habitat.radius + 1e-5,
        )
        expect(position.y + 0.2).toBeLessThan(WATER_LEVEL)
        expect(position.y - 0.2).toBeGreaterThan(bottomHeight(bed, position.x, position.z))
        const phase = batch.geometry.getAttribute('aFishMotion').getX(instance)
        expect(phase).toBeGreaterThan(previousPhases[i]!)
        expect(phase - previousPhases[i]!).toBeLessThan(0.3)
        previousPhases[i] = phase
      }
    }
    fish.dispose()
  })

  it('omits shoals when there is no safe water', () => {
    const bed = createVoxelWorld(12, true).lakeBed
    const dry = { ...bed, water: new Uint8Array(bed.water.length) }
    expect(createFishHabitats(dry, 12, 3)).toEqual([])
    const fish = new LakeFish(new Scene(), dry, 12, true)
    expect(fish.count).toBe(0)
    fish.dispose()
  })
})

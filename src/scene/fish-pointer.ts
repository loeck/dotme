import { Vector3 } from 'three'

import { WATER_LEVEL } from './lake-bed'
import type { FireflyPointer } from './lake-fireflies'

type Point = Readonly<{ x: number; y: number; z: number }>
export type FishPointerTarget = { x: number; z: number; strength: number }
export type FishBait = Readonly<{ x: number; z: number; strength: number }>
export type BaitSteering = Readonly<{ x: number; z: number; pull: number }>

/** Unit bearing toward a clicked food drop, fading with distance. */
export function baitSteering(fishX: number, fishZ: number, bait: FishBait): BaitSteering {
  const dx = bait.x - fishX
  const dz = bait.z - fishZ
  const distance = Math.hypot(dx, dz)
  const proximity = Math.max(0, 1 - distance / 3.5)
  const pull = proximity * proximity * bait.strength
  if (!(distance > 1e-3)) return { x: 0, z: 0, pull }
  return { x: dx / distance, z: dz / distance, pull }
}

const origin = new Vector3()
const surface = new Vector3()
const projected = new Vector3()
const ray = new Vector3()

/** Apparent surface position under Snell's law, before the small wave distortion. */
export function apparentFishSurface(position: Point, camera: Point, target: Vector3) {
  const depth = Math.max(0, WATER_LEVEL - position.y)
  const dx = camera.x - position.x
  const dz = camera.z - position.z
  const horizontal = Math.max(0.001, Math.hypot(dx, dz))
  const height = Math.max(0.001, camera.y - WATER_LEVEL)
  let offset = 0
  for (let step = 0; step < 3; step++) {
    const distance = Math.max(0, horizontal - offset)
    const sine = distance / Math.hypot(distance, height) / 1.333
    offset = (depth * sine) / Math.sqrt(1 - sine * sine)
  }
  return target.set(
    position.x + (dx / horizontal) * offset,
    WATER_LEVEL,
    position.z + (dz / horizontal) * offset,
  )
}

/** Screen proximity selects the fish; a flat water ray supplies a stable escape direction. */
export function sampleFishPointer(
  position: Point,
  pointer: FireflyPointer | null,
  target: FishPointerTarget,
): FishPointerTarget | null {
  target.strength = 0
  if (!pointer || pointer.width <= 0 || pointer.height <= 0) return null
  origin.setFromMatrixPosition(pointer.camera.matrixWorld)
  apparentFishSurface(position, origin, surface)
  projected.copy(surface).project(pointer.camera)
  if (projected.z < -1 || projected.z > 1) return null
  const px = (projected.x - pointer.ndc.x) * pointer.width * 0.5
  const py = (projected.y - pointer.ndc.y) * pointer.height * 0.5
  const distance = Math.hypot(px, py)
  if (distance >= 85) return null

  ray.set(pointer.ndc.x, pointer.ndc.y, 0.5).unproject(pointer.camera).sub(origin)
  if (ray.y >= -0.0001) return null
  const t = (WATER_LEVEL - origin.y) / ray.y
  const dx = origin.x + ray.x * t - surface.x
  const dz = origin.z + ray.z * t - surface.z
  // Strength depends on visible proximity, independently of distance/depth.
  // The bounded local point only tells the steering controller which way to turn.
  const scale = Math.min(1, 0.7 / Math.max(0.001, Math.hypot(dx, dz)))
  const proximity = 1 - distance / 85
  target.x = position.x + dx * scale
  target.z = position.z + dz * scale
  target.strength = proximity * proximity * (3 - 2 * proximity)
  return target
}

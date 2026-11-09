import { Plane, Raycaster, Vector2, Vector3 } from 'three/webgpu'
import type { Camera, PerspectiveCamera } from 'three/webgpu'

import { pointSound } from '../audio/environment'
import { panFromCameraMatrix } from '../audio/pan'
import { seesWorld } from './cursor-world'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { PhysicsWorld } from './physics-world'
import type { WaterContact } from './water-contact'
import type { WindModel } from './wind'

const DOWN = new Vector3(0, -1, 0)

/** Nearest entry of a ray (unit direction) into any sphere (x, y, z, radius), before `max`. */
function raySpheres(
  origin: Vector3,
  direction: Vector3,
  spheres: Float32Array,
  max: number,
): number {
  let nearest = max
  for (let i = 0; i + 3 < spheres.length; i += 4) {
    const ox = origin.x - (spheres[i] ?? 0),
      oy = origin.y - (spheres[i + 1] ?? 0),
      oz = origin.z - (spheres[i + 2] ?? 0)
    const r = spheres[i + 3] ?? 0
    const b = ox * direction.x + oy * direction.y + oz * direction.z
    const c = ox * ox + oy * oy + oz * oz - r * r
    const disc = b * b - c
    if (disc < 0) continue
    const t = -b - Math.sqrt(disc)
    if (t > 0 && t < nearest) nearest = t
  }
  return nearest
}

/** Open lake water at (x, z): inside the lake and clear of banks and stones. */
export function isOpenWater(bed: LakeBed, x: number, z: number) {
  const index = lakeIndex(bed, x, z)
  return index >= 0 && Boolean(bed.water[index]) && (bed.obstacle[index] ?? -Infinity) < WATER_LEVEL
}

/** Attenuation and stereo pan of a sound on the water at (x, z), heard from the camera. */
export function placeSound(camera: Camera, x: number, z: number, scratch: Vector3) {
  scratch.set(x, WATER_LEVEL, z)
  const distance = scratch.distanceTo(camera.position)
  return pointSound(distance, panFromCameraMatrix(camera.matrixWorld.elements, scratch))
}

export type PickingWorld = Readonly<{
  canvas: HTMLCanvasElement
  camera: PerspectiveCamera
  bed: LakeBed
  physics: Pick<PhysicsWorld, 'castDistance'>
  wind: WindModel
  /** The simulation's CPU copy of the surface, which lifts the water plane under the pointer. */
  contact: WaterContact
  /** Scene seconds now. */
  time: () => number
}>

/**
 * The pointer ray and what it meets: the water (under its waves, behind the banks and crowns),
 * the colliders and the trees' crowns. One ray is cast at a time and shared: the frame's
 * interactions read the ray the last projection cast.
 */
export class ScenePicker {
  readonly raycaster = new Raycaster()
  /** Normalized device coordinates of the last projected client position. */
  readonly ndc = new Vector2()
  /** Trees' and shrubs' picking spheres (x, y, z, radius), empty until the forest loads. */
  crowns: Float32Array = new Float32Array(0)
  /** The canvas rect; the canvas is fixed fullscreen, so it only changes on resize. */
  bounds: DOMRect | null = null
  /** The GPU water height read back under the pointer, which lifts the ray's water plane. */
  pointerHeight = 0
  private readonly world: PickingWorld
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL)
  private readonly waterHit = new Vector3()
  private readonly waterScratch = new Vector3()
  private readonly restOrigin = new Vector3()

  constructor(world: PickingWorld) {
    this.world = world
  }

  get ray() {
    return this.raycaster.ray
  }

  canvasBounds() {
    return this.bounds ?? this.world.canvas.getBoundingClientRect()
  }

  /** Casts the ray through a client position; false off the canvas or over the page's UI. */
  project(clientX: number, clientY: number): boolean {
    if (!seesWorld(document.elementFromPoint(clientX, clientY))) return false
    const bounds = this.canvasBounds()
    const x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    const y = -((clientY - bounds.top) / bounds.height) * 2 + 1
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return false
    this.ndc.set(x, y)
    this.raycaster.setFromCamera(this.ndc, this.world.camera)
    return true
  }

  /** Writes the water point under a client position into `target`, which it returns. */
  hitWater(clientX: number, clientY: number, target: Vector3): Vector3 | null {
    return this.project(clientX, clientY) ? this.waterOnRay(target) : null
  }

  /** The open water the current ray meets first, or null when a bank, rock or crown hides it. */
  waterOnRay(target: Vector3): Vector3 | null {
    const { bed, camera, contact, wind } = this.world
    const ray = this.raycaster.ray
    this.waterPlane.constant = -WATER_LEVEL
    if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    const time = this.world.time()
    const state = wind.sample(time)
    for (let i = 0; i < 3; i++) {
      this.waterPlane.constant = -(
        contact.sample(this.waterHit.x, this.waterHit.z, time, state)[0] + this.pointerHeight
      )
      if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    }
    const distance = this.waterHit.distanceTo(camera.position)
    const index = lakeIndex(bed, this.waterHit.x, this.waterHit.z)
    if (distance > 130 || index < 0 || !bed.water[index]) return null
    // A crown in front of the water hides it from the pointer.
    if (raySpheres(ray.origin, ray.direction, this.crowns, distance) < distance) return null
    // Conservative raster of the actual solids includes the banks and isolated stones.
    const cell = LAKE_BOUNDS.size / bed.resolution
    for (let d = 0; d < distance - 0.05; d += cell * 0.5) {
      const px = ray.origin.x + ray.direction.x * d
      const pz = ray.origin.z + ray.direction.z * d
      const j = lakeIndex(bed, px, pz)
      if (j >= 0 && (bed.obstacle[j] ?? -Infinity) >= ray.origin.y + ray.direction.y * d)
        return null
    }
    return target.copy(this.waterHit)
  }

  /**
   * Distance along the ray to the first solid it meets: the colliders (ground, cliffs,
   * boulders) or a tree or shrub's crown, which has no collider. Infinity when it meets none.
   */
  solidDistance(max = 130) {
    const ray = this.raycaster.ray
    const solid = this.world.physics.castDistance(ray.origin, ray.direction, max) ?? Infinity
    return Math.min(solid, raySpheres(ray.origin, ray.direction, this.crowns, solid))
  }

  /** Distance along a ray into the nearest crown before `max`, else `max`. */
  crownDistance(origin: Vector3, direction: Vector3, max: number) {
    return raySpheres(origin, direction, this.crowns, max)
  }

  /** Where something falling at (x, z) from `fromY` comes to rest: the ground, or the lake. */
  restingPoint(x: number, z: number, fromY: number) {
    const origin = this.restOrigin.set(x, fromY, z)
    const hit = this.world.physics.castDistance(origin, DOWN, 60)
    const ground = hit === null ? -Infinity : fromY - hit
    if (ground < WATER_LEVEL && isOpenWater(this.world.bed, x, z))
      return { y: WATER_LEVEL, water: true }
    return { y: Number.isFinite(ground) ? ground : WATER_LEVEL - 2, water: false }
  }

  /** The first solid, crown or water the pointer at a client position meets, or null. */
  pointAt(clientX: number, clientY: number, target: Vector3): Vector3 | null {
    if (!this.project(clientX, clientY)) return null
    const ray = this.raycaster.ray
    const water = this.waterOnRay(this.waterScratch)
    const solid = this.solidDistance()
    if (solid < Infinity && (!water || solid < ray.origin.distanceTo(water)))
      return ray.at(solid, target)
    return water ? target.copy(water) : null
  }
}

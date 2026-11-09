import { Vector3 } from 'three/webgpu'
import type { Camera } from 'three/webgpu'

import type { BirdFlock } from './bird-flock'
import { WATER_LEVEL } from './lake-bed'
import type { LandscapeState } from './landscape-state'
import type { PhysicsWorld } from './physics-world'
import type { ScenePicker } from './scene-picking'

/** Seconds into a visit before the first flock crosses the sky, then between flocks. */
const FLOCK_FIRST = 22
const FLOCK_GAP = [55, 95] as const

export type FlockWorld = Readonly<{
  birds: BirdFlock
  camera: Camera
  picker: ScenePicker
  physics: Pick<PhysicsWorld, 'castDistance'>
  state: Readonly<LandscapeState>
  seed: number
  /** The season's share of birds: fewer flocks cross a winter sky. */
  rate: number
}>

/** When and from which crown the flock leaves: on its own by day, or startled by a press. */
export class FlockSchedule {
  private readonly world: FlockWorld
  private nextAt = FLOCK_FIRST
  private count = 0
  private readonly start = new Vector3()

  constructor(world: FlockWorld) {
    this.world = world
  }

  /**
   * A press on a tree's crown startles a flock out of it, by day. The pointer ray is already
   * set by the press; it must meet the crown before any ground or rock.
   */
  startle() {
    const { birds, picker, physics, state } = this.world
    if (birds.active || state.daylight < 0.2) return false
    const ray = picker.ray
    const solid = physics.castDistance(ray.origin, ray.direction, 130) ?? Infinity
    const crown = picker.crownDistance(ray.origin, ray.direction, solid)
    if (!(crown < solid)) return false
    this.launch(ray.at(crown, this.start))
    return true
  }

  private launch(start: Vector3) {
    const { birds, camera, seed, state, rate } = this.world
    this.count++
    birds.launch(start, camera.position, ((seed ^ (this.count * 0x9e37)) >>> 0) + 1)
    // Fewer flocks cross a winter sky.
    const gap = FLOCK_GAP[0] + Math.random() * (FLOCK_GAP[1] - FLOCK_GAP[0])
    this.nextAt = state.elapsed + gap / Math.max(0.2, rate)
  }

  /**
   * Now and then by day a flock leaves a crown in view on its own. Crowns are picked from the
   * tall ones (trees, not shrubs) that project inside the frame.
   */
  update(dt: number, rain: number) {
    const { birds, camera, picker, state } = this.world
    if (state.reducedMotion) {
      if (birds.active) birds.cancel()
      return
    }
    birds.update(dt)
    if (birds.active || state.elapsed < this.nextAt) return
    if (state.daylight < 0.35 || rain > 0.3) {
      this.nextAt = state.elapsed + 10
      return
    }
    const pick = picker.crowns
    const crownTop = (i: number, target: Vector3) =>
      target.set(pick[i] ?? 0, (pick[i + 1] ?? 0) + (pick[i + 3] ?? 0) * 0.6, pick[i + 2] ?? 0)
    const crowns: number[] = []
    for (let i = 0; i + 3 < pick.length; i += 4) {
      // Broad bands high above the water: tree crowns, not shrubs.
      if ((pick[i + 3] ?? 0) < 1.5 || (pick[i + 1] ?? 0) < WATER_LEVEL + 4) continue
      const projected = crownTop(i, this.start).project(camera)
      if (Math.abs(projected.x) < 0.85 && Math.abs(projected.y) < 0.85 && projected.z < 1)
        crowns.push(i)
    }
    const index = crowns[Math.floor(Math.random() * crowns.length)]
    if (index === undefined) this.nextAt = state.elapsed + 10
    else this.launch(crownTop(index, this.start))
  }
}

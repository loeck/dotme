import { Vector3 } from 'three/webgpu'
import type { Camera } from 'three/webgpu'

import { duckRoute, flockRandom, gullRoute, swiftRoute } from './bird-flock'
import type { BirdFlock, FlightPlan } from './bird-flock'
import { BIRD_SPECIES, chooseSpecies } from './bird-species'
import type { BirdSpeciesName, FlockContext } from './bird-species'
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
  /** Birds in a flock of `species` on this device and in this season. */
  flockSize: (species: BirdSpeciesName) => number
  /** The season, the hour and the sky, which decide who flies. */
  context: () => Omit<FlockContext, 'fromCrown'>
}>

const down = new Vector3(0, -1, 0)

/** When and from which crown the flock leaves: on its own by day, or startled by a press. */
export class FlockSchedule {
  private readonly world: FlockWorld
  private nextAt = FLOCK_FIRST
  private count = 0
  private readonly start = new Vector3()
  private readonly probe = new Vector3()
  private readonly viewer = new Vector3()

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

  private nextSeed() {
    this.count++
    return ((this.world.seed ^ (this.count * 0x9e37)) >>> 0) + 1
  }

  /** Crows out of a crown at `start`. */
  private launch(start: Vector3) {
    const { birds, camera, flockSize } = this.world
    birds.launch(start, camera.position, this.nextSeed(), flockSize('crow'))
    this.rest()
  }

  private rest() {
    const { state, rate } = this.world
    // Fewer flocks cross a winter sky.
    const gap = FLOCK_GAP[0] + Math.random() * (FLOCK_GAP[1] - FLOCK_GAP[0])
    this.nextAt = state.elapsed + gap / Math.max(0.2, rate)
  }

  /** Ground (or lake bed) height at (x, z), from the colliders. */
  private ground(x: number, z: number) {
    const distance = this.world.physics.castDistance(this.probe.set(x, 80, z), down, 140)
    return distance === null ? WATER_LEVEL : 80 - distance
  }

  /** Gulls, mallards or swifts over the lake, from beyond the frame. */
  private launchOverLake(species: Exclude<BirdSpeciesName, 'crow'>, nearer = 0) {
    const { birds, camera, flockSize, context } = this.world
    const seed = this.nextSeed()
    const random = flockRandom(seed ^ 0x51ed)
    // `nearer` (debug captures) brings the flight that many metres toward the camera.
    const viewer = this.viewer.copy(camera.position).setZ(camera.position.z + nearer)
    const route =
      species === 'mallard'
        ? duckRoute(viewer, random, (x, z) => this.ground(x, z))
        : species === 'gull'
          ? gullRoute(viewer, random)
          : swiftRoute(viewer, random)
    const { season } = context()
    const plan: FlightPlan = {
      species,
      count: flockSize(species),
      seed,
      route,
      takeOff: false,
      // Black-headed gulls wear their dark hood from late winter to midsummer.
      hood: species === 'gull' && season.spring + season.summer > 0.5,
    }
    birds.fly(plan)
    this.rest()
  }

  /** A crown in view to leave from, or false with none. */
  private launchFromCrown() {
    const { camera, picker } = this.world
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
    if (index === undefined) return false
    this.launch(crownTop(index, this.start))
    return true
  }

  private send(species: BirdSpeciesName, nearer = 0) {
    if (species === 'crow') return this.launchFromCrown()
    this.launchOverLake(species, nearer)
    return true
  }

  /**
   * A flock now, whatever the hour (a debug hook for captures): `species` or one the context
   * picks. False under reduced motion or with no crown in view for crows.
   */
  force(species?: string, nearer = 0) {
    const { birds, state, context } = this.world
    if (state.reducedMotion) return false
    birds.cancel()
    const named = BIRD_SPECIES.find((name) => name === species)
    return this.send(
      named ?? chooseSpecies({ ...context(), fromCrown: false }, Math.random),
      Number.isFinite(nearer) ? nearer : 0,
    )
  }

  /**
   * Now and then by day a flock crosses the view on its own, of a species the season, the hour
   * and the sky make likely (`chooseSpecies`): crows leave a tall crown that projects inside
   * the frame; gulls, mallards and swifts come in over the lake from beyond it.
   */
  update(dt: number, rain: number) {
    const { birds, state } = this.world
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
    const species = chooseSpecies({ ...this.world.context(), fromCrown: false }, Math.random)
    if (!this.send(species)) this.nextAt = state.elapsed + 10
  }
}

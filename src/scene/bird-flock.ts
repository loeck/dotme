import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Object3D,
  Vector3,
} from 'three/webgpu'

import { createBirdBuffers, writeBird } from './bird-geometry'
import { BirdMaterial } from './bird-material'
import { SPECIES, stepWing } from './bird-species'
import type { BirdSpecies, BirdSpeciesName, WingPose, WingState } from './bird-species'
import { WATER_LEVEL } from './lake-bed'

export const FLOCK = {
  /** Most birds in one flock (a party of swifts); flocks are smaller on low-power devices. */
  capacity: 10,
  lowPowerShare: 0.65,
  /** Fewest birds that still read as a flock. */
  minimum: 3,
  /** Seconds a crow flock stays in the air before it is gone. */
  lifetime: 24,
  /** Metres a bird keeps clear of a crown, and the height the flock clears the canopy by. */
  crownMargin: 1.5,
  canopyClearance: 4,
  /** Separation radius in wingspans: closer flockmates push each other apart. */
  separation: 1.8,
} as const

/** Seconds in the air per species: ducks cross fast, gulls circle long. */
const LIFETIME: Readonly<Record<BirdSpeciesName, number>> = {
  crow: FLOCK.lifetime,
  gull: 34,
  mallard: 16,
  swift: 28,
}
/**
 * Drawn a little larger than life so a silhouette still reads at 20–40 m, the swift most: at
 * true size it is a speck.
 */
const READABLE: Readonly<Record<BirdSpeciesName, number>> = {
  crow: 1.15,
  gull: 1.2,
  mallard: 1.2,
  swift: 1.45,
}
/** Seconds before the end that a circling or hawking flock heads off. */
const DEPART = { gull: 11, swift: 8 } as const
/** How quickly a bird answers its steering, per second: a swift turns on a wingtip. */
const AGILITY: Readonly<Record<BirdSpeciesName, number>> = {
  crow: 2.2,
  gull: 1.1,
  mallard: 1.6,
  swift: 4.5,
}

/**
 * Where a flock flies. Wedge and V flocks follow `route` (the leader's waypoints); circling
 * and hawking flocks use `route` as [entry, centre, exit].
 */
export type FlightPlan = Readonly<{
  species: BirdSpeciesName
  count: number
  seed: number
  route: readonly Vector3[]
  /** Birds start at the first waypoint and grow from nothing (a take-off from a crown). */
  takeOff: boolean
  /** Spring and summer black-headed gulls wear their dark hood. */
  hood?: boolean
}>

type Bird = {
  position: Vector3
  velocity: Vector3
  /** Formation slot relative to the leader, in its heading frame (right, up, back). */
  slot: Vector3
  /** How quickly the bird answers its slot: lower birds lag and straggle. */
  response: number
  wing: WingState
  bank: number
  size: number
  /** Brightness, plus 2 for the alternate head (a drake, a jackdaw). */
  tint: number
  /** Wander target (hawking) and seconds until the next. */
  target: Vector3
  retargetIn: number
  /** Orbit radius and height offset in a thermal; speed factor. */
  orbit: number
  level: number
  pace: number
}

const up = new Vector3(0, 1, 0)

/** Deterministic pseudo-random sequence for a flock's spread. */
export function flockRandom(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

/**
 * Where a flock of crows flies after leaving `start`: up and away from the viewer, a wide turn
 * over the lake, then off over the far hills. The waypoints only steer the leader; the birds
 * keep loose slots around it, so the flock stretches and bunches as it turns.
 */
export function flockRoute(start: Vector3, viewer: Vector3, turn: number, canopy = 0) {
  const away = new Vector3(start.x - viewer.x, 0, start.z - viewer.z)
  if (away.lengthSq() < 1e-6) away.set(0, 0, -1)
  away.normalize()
  const side = new Vector3().crossVectors(up, away).multiplyScalar(turn)
  // Up over the tallest crowns around first, so the flock never flies through the woods.
  const rise = Math.max(start.y + 7, 10, canopy + FLOCK.canopyClearance)
  return [
    start
      .clone()
      .addScaledVector(away, 10)
      .add(new Vector3(0, rise - start.y, 0)),
    start
      .clone()
      .addScaledVector(away, 30)
      .addScaledVector(side, 22)
      .setY(rise + 6),
    start
      .clone()
      .addScaledVector(away, 48)
      .addScaledVector(side, -6)
      .setY(rise + 9),
    start
      .clone()
      .addScaledVector(away, 160)
      .addScaledVector(side, -50)
      .setY(rise + 26),
  ]
}

/**
 * Mallards cross the lake low, from one side of the view to the other, a few metres over the
 * water and lifting over any ground on the way (`ground` gives its height at x, z).
 */
export function duckRoute(
  viewer: Vector3,
  random: () => number,
  ground: (x: number, z: number) => number,
) {
  const side = random() < 0.5 ? -1 : 1
  const z = viewer.z - 22 - random() * 18
  const height = WATER_LEVEL + 2.4 + random() * 1.6
  const route: Vector3[] = []
  for (let step = 0; step <= 10; step++) {
    const x = viewer.x + side * (-80 + step * 17)
    const pz = z - step * 2.2
    route.push(new Vector3(x, Math.max(height, ground(x, pz) + 3.5), pz))
  }
  return route
}

/**
 * Gulls drift in from one side, circle up over the lake on a thermal and slide off over the
 * far hills: [entry, centre of the circling, exit].
 */
export function gullRoute(viewer: Vector3, random: () => number) {
  const side = random() < 0.5 ? -1 : 1
  const centre = new Vector3(
    viewer.x + (random() - 0.5) * 16,
    12 + random() * 4,
    viewer.z - 20 - random() * 12,
  )
  return [
    centre.clone().add(new Vector3(side * 45, 5, -20)),
    centre,
    centre.clone().add(new Vector3(-side * 40, 22, -110)),
  ]
}

/** Swifts sweep in from high up, hawk over the near water, then climb away. */
export function swiftRoute(viewer: Vector3, random: () => number) {
  const side = random() < 0.5 ? -1 : 1
  const centre = new Vector3(
    viewer.x + (random() - 0.5) * 10,
    8.5 + random() * 3.5,
    viewer.z - 14 - random() * 8,
  )
  return [
    centre.clone().add(new Vector3(side * 28, 14, -26)),
    centre,
    centre.clone().add(new Vector3(-side * 25, 32, -70)),
  ]
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * A flock of one species: crows leaving a crown in a loose wedge, gulls circling on a thermal,
 * mallards in a V low over the water, swifts hawking. Each bird steers like a boid (its goal,
 * separation from close flockmates, alignment and cohesion in the looser flocks, clear of the
 * crowns and the water), beats and glides on its own rhythm and banks into its turns. One
 * instanced draw; the wings hinge in the vertex shader (`bird-material.ts`).
 */
export class BirdFlock {
  readonly group: Object3D
  private readonly mesh: Mesh<InstancedBufferGeometry, BirdMaterial['material']>
  private readonly paint: BirdMaterial
  private readonly geometry: InstancedBufferGeometry
  private readonly buffers = createBirdBuffers()
  private readonly vertexAttributes: BufferAttribute[]
  private readonly axisX: InstancedBufferAttribute
  private readonly axisY: InstancedBufferAttribute
  private readonly axisZ: InstancedBufferAttribute
  private readonly origin: InstancedBufferAttribute
  private readonly birds: Bird[] = []
  private readonly route: Vector3[] = []
  private readonly leader = new Vector3()
  private readonly heading = new Vector3()
  private readonly leaderVelocity = new Vector3()
  private species: BirdSpecies = SPECIES.crow
  private count = 0
  private lifetime: number = FLOCK.lifetime
  private takeOff = true
  private waypoint = 0
  private obstacles: Float32Array = new Float32Array(0)
  private age = Infinity
  private random = flockRandom(1)
  private readonly pose: WingPose = { shoulder: 0, wrist: 0, fold: 0 }
  private readonly scratch = new Vector3()
  private readonly steer = new Vector3()
  private readonly mean = new Vector3()
  private readonly meanVelocity = new Vector3()
  private readonly before = new Vector3()
  private readonly frame = { x: new Vector3(), y: new Vector3(), z: new Vector3() }
  private readonly basis = { right: new Vector3(), up: new Vector3(), back: new Vector3() }

  constructor(capacity: number) {
    const geometry = new InstancedBufferGeometry()
    const { position, normal, wing, paint } = this.buffers
    this.vertexAttributes = [
      new BufferAttribute(position, 3),
      new BufferAttribute(normal, 3),
      new BufferAttribute(wing, 4),
      new BufferAttribute(paint, 4),
    ]
    const [p, n, w, c] = this.vertexAttributes
    if (p) geometry.setAttribute('position', p)
    if (n) geometry.setAttribute('normal', n)
    if (w) geometry.setAttribute('aWing', w)
    if (c) geometry.setAttribute('aPaint', c)
    const instanced = () =>
      new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage)
    this.axisX = instanced()
    this.axisY = instanced()
    this.axisZ = instanced()
    this.origin = instanced()
    geometry.setAttribute('aAxisX', this.axisX)
    geometry.setAttribute('aAxisY', this.axisY)
    geometry.setAttribute('aAxisZ', this.axisZ)
    geometry.setAttribute('aOrigin', this.origin)
    geometry.instanceCount = 0
    this.geometry = geometry
    this.setShape(SPECIES.crow)
    this.paint = new BirdMaterial()
    this.paint.setPlumage(SPECIES.crow.plumage)
    this.mesh = new Mesh(geometry, this.paint.material)
    this.mesh.name = 'Birds'
    // The flock crosses half the sky: no bounding sphere fits it for long.
    this.mesh.frustumCulled = false
    this.group = new Object3D()
    this.group.add(this.mesh)
    for (let i = 0; i < capacity; i++)
      this.birds.push({
        position: new Vector3(),
        velocity: new Vector3(),
        slot: new Vector3(),
        response: 1,
        wing: { phase: 0, beats: 0, gliding: 0, glide: 0, rate: 1 },
        bank: 0,
        size: 1,
        tint: 1,
        target: new Vector3(),
        retargetIn: 0,
        orbit: 10,
        level: 0,
        pace: 1,
      })
    this.group.visible = false
  }

  get active() {
    return this.group.visible
  }

  /** The species in the air (the last one flown when none is). */
  get flying(): BirdSpeciesName {
    return this.species.name
  }

  /** Birds in the current flock. */
  get size() {
    return this.count
  }

  /** Room for this many birds. */
  get capacity() {
    return this.birds.length
  }

  /** The key light for the wings' transmission and the rim. */
  setLight(light: Parameters<BirdMaterial['setLight']>[0]) {
    this.paint.setLight(light)
  }

  /** The scene's haze, thinned for birds (`BIRD_HAZE`). */
  setHaze(fog: Parameters<BirdMaterial['setHaze']>[0]) {
    this.paint.setHaze(fog)
  }

  /**
   * Crowns as pick spheres (x, y, z, radius per sphere): crows climb over the tallest near
   * their tree and each bird steers clear of any it comes close to.
   */
  setObstacles(spheres: Float32Array) {
    this.obstacles = spheres
  }

  /** Top of the highest crown within 60 m of (x, z), or 0 with none. */
  private canopyNear(x: number, z: number) {
    const spheres = this.obstacles
    let top = 0
    for (let i = 0; i + 3 < spheres.length; i += 4) {
      const dx = (spheres[i] ?? 0) - x,
        dz = (spheres[i + 2] ?? 0) - z
      if (dx * dx + dz * dz < 3600)
        top = Math.max(top, (spheres[i + 1] ?? 0) + (spheres[i + 3] ?? 0))
    }
    return top
  }

  /** Startles crows out of a crown at `start`, flying away from `viewer`. */
  launch(start: Vector3, viewer: Vector3, seed: number, count = SPECIES.crow.count) {
    const random = flockRandom(seed)
    const route = flockRoute(
      start,
      viewer,
      random() < 0.5 ? -1 : 1,
      this.canopyNear(start.x, start.z),
    )
    this.fly({ species: 'crow', count, seed, route: [start.clone(), ...route], takeOff: true })
  }

  /** Sends a flock along `plan`. */
  fly(plan: FlightPlan) {
    const species = SPECIES[plan.species]
    if (species !== this.species) this.setShape(species)
    this.species = species
    this.paint.setPlumage(species.plumage, plan.hood ? 0x3a2b23 : undefined)
    const random = flockRandom(plan.seed)
    this.random = random
    this.count = clamp(Math.round(plan.count), 1, this.birds.length)
    this.lifetime = LIFETIME[species.name]
    this.takeOff = plan.takeOff
    this.route.length = 0
    for (const point of plan.route) this.route.push(point.clone())
    const start = this.route[0] ?? this.scratch.set(0, 10, 0)
    this.waypoint = plan.takeOff ? 1 : 0
    this.age = 0
    this.leader.copy(start)
    const next = this.route[1] ?? start
    this.leaderVelocity
      .copy(next)
      .sub(start)
      .setLength(plan.takeOff ? species.flight.speed * 0.6 : species.flight.speed)
    if (plan.takeOff) this.leaderVelocity.set(0, species.flight.speed * 0.6, 0)
    this.updateBasis()
    const span = species.shape.span
    // V flocks are an echelon now and then: every bird on one side.
    const echelon = species.formation === 'v' && random() < 0.35 ? (random() < 0.5 ? -1 : 1) : 0
    for (let index = 0; index < this.count; index++) {
      const bird = this.birds[index]
      if (!bird) continue
      const row = Math.ceil(index / 2),
        side = echelon || (index % 2 === 0 ? 1 : -1)
      if (species.formation === 'v') {
        // Wingtips nearly overlapping the bird ahead's wake: about a span across, a body back.
        const echelonRow = echelon ? index : row
        bird.slot.set(
          side * echelonRow * span * (0.95 + random() * 0.15),
          (random() - 0.5) * 0.25,
          echelonRow * (span * 0.85 + random() * 0.3),
        )
      } else {
        // A loose wedge behind the leader, jittered so it never looks drilled.
        bird.slot.set(
          side * row * 1.1 + (random() - 0.5) * 1.4,
          (random() - 0.5) * 1.6,
          row * 1.3 + random() * 1.5,
        )
      }
      bird.response = species.formation === 'v' ? 2 + random() * 0.6 : 1.4 + random() * 1.4
      bird.wing.rate = 0.92 + random() * 0.16
      // Birds in a V beat in step with the bird ahead, a little later down the line (Portugal
      // et al. 2014); the others keep their own time.
      bird.wing.phase = species.formation === 'v' ? -row * 0.12 + random() * 0.05 : random() * 8
      bird.wing.beats =
        species.flight.burst[0] + random() * (species.flight.burst[1] - species.flight.burst[0])
      bird.wing.gliding = 0
      bird.wing.glide = 0
      bird.bank = 0
      bird.size = (0.9 + random() * 0.2) * READABLE[species.name]
      bird.tint = 0.9 + random() * 0.2 + (random() < species.plumage.altShare ? 2 : 0)
      bird.orbit = 6 + random() * 8
      bird.level = (random() - 0.5) * 5
      bird.pace = 0.8 + random() * 0.45
      bird.retargetIn = random()
      const spread = plan.takeOff ? 1.5 : 6
      bird.position.set(
        start.x + (random() - 0.5) * spread,
        start.y - random() * (plan.takeOff ? 1.2 : 3),
        start.z + (random() - 0.5) * spread,
      )
      if (species.formation === 'v' || !plan.takeOff) {
        // Already under way: in slot (a V) or spread along the way in.
        if (species.formation === 'v') this.slotTarget(bird, bird.position)
        bird.velocity.copy(this.leaderVelocity)
      } else bird.velocity.set((random() - 0.5) * 2, 3 + random() * 2, (random() - 0.5) * 2)
      bird.target.copy(this.route[1] ?? start)
    }
    this.geometry.instanceCount = this.count
    this.group.visible = true
    this.writeInstances(0)
  }

  /** Rewrites the shared bird geometry for a species: buffer contents only. */
  private setShape(species: BirdSpecies) {
    writeBird(species.shape, this.buffers)
    for (const attribute of this.vertexAttributes) attribute.needsUpdate = true
  }

  /** The flock's mean position. */
  centre(target = new Vector3()) {
    target.set(0, 0, 0)
    for (let i = 0; i < this.count; i++) {
      const bird = this.birds[i]
      if (bird) target.add(bird.position)
    }
    return target.divideScalar(Math.max(1, this.count))
  }

  /** Lowest and highest speed of the flock's birds, metres per second (for tests). */
  speeds() {
    let low = Infinity,
      high = 0
    for (let i = 0; i < this.count; i++) {
      const speed = this.birds[i]?.velocity.length() ?? 0
      low = Math.min(low, speed)
      high = Math.max(high, speed)
    }
    return { low, high }
  }

  /** Closest pair of birds, metres (for tests). */
  closestPair() {
    let best = Infinity
    for (let i = 0; i < this.count; i++)
      for (let j = i + 1; j < this.count; j++) {
        const a = this.birds[i],
          b = this.birds[j]
        if (a && b) best = Math.min(best, a.position.distanceTo(b.position))
      }
    return best
  }

  /** Each bird's height, for tests. */
  lowest() {
    let low = Infinity
    for (let i = 0; i < this.count; i++) low = Math.min(low, this.birds[i]?.position.y ?? Infinity)
    return low
  }

  cancel() {
    this.age = Infinity
    this.group.visible = false
    this.geometry.instanceCount = 0
  }

  update(dt: number) {
    if (!this.group.visible || !(dt > 0)) return
    this.age += dt
    if (this.age > this.lifetime) {
      this.cancel()
      return
    }
    const formation = this.species.formation
    if (formation === 'wedge' || formation === 'v') this.steerLeader(dt)
    this.updateBasis()
    // Flock means for alignment and cohesion.
    this.mean.set(0, 0, 0)
    this.meanVelocity.set(0, 0, 0)
    for (let i = 0; i < this.count; i++) {
      const bird = this.birds[i]
      if (!bird) continue
      this.mean.add(bird.position)
      this.meanVelocity.add(bird.velocity)
    }
    this.mean.divideScalar(Math.max(1, this.count))
    this.meanVelocity.divideScalar(Math.max(1, this.count))
    const flight = this.species.flight
    const agility = AGILITY[this.species.name]
    for (let index = 0; index < this.count; index++) {
      const bird = this.birds[index]
      if (!bird) continue
      const desired = this.steer
      this.goal(bird, dt, desired)
      this.separate(bird, index, desired)
      if (formation === 'thermal' || formation === 'hawking') {
        // Loose flocks: a little of the flock's heading and pull toward its middle.
        desired.lerp(this.meanVelocity, formation === 'thermal' ? 0.15 : 0.08)
        desired.addScaledVector(this.scratch.copy(this.mean).sub(bird.position), 0.06)
      }
      const speed = desired.length()
      const most = flight.speed * 1.6
      if (speed > most) desired.multiplyScalar(most / speed)
      this.before.copy(bird.velocity)
      bird.velocity.lerp(desired, 1 - Math.exp(-dt * agility))
      this.avoidCrowns(bird, dt)
      this.keepAloft(bird, dt)
      // Birds cannot hover: at least half their cruising speed.
      const least = flight.speed * (this.takeOff && this.age < 1.5 ? 0.3 : 0.5)
      const now = bird.velocity.length()
      if (now < least) bird.velocity.multiplyScalar(least / Math.max(now, 1e-3))
      bird.position.addScaledVector(bird.velocity, dt)
      // Bank into the turn by the sideways acceleration, as a turning bird must (tan φ = a/g).
      const side = this.frameOf(bird, this.frame).x
      const lateral = this.before.sub(bird.velocity).negate().dot(side) / dt
      const bank = clamp(-Math.atan2(lateral, 9.8) * 1.2, -1.1, 1.1)
      bird.bank += (bank - bird.bank) * (1 - Math.exp(-dt * 5))
      stepWing(bird.wing, flight, dt, bird.velocity.y > 1.5, this.random, this.pose)
      this.writeBird(index, bird)
    }
    this.markInstances()
  }

  /** The bird's steering goal velocity, written to `desired`. */
  private goal(bird: Bird, dt: number, desired: Vector3): Vector3 {
    const species = this.species
    const speed = species.flight.speed
    switch (species.formation) {
      case 'wedge':
      case 'v': {
        // Toward the slot at a speed near the cruise, so stragglers catch up.
        this.slotTarget(bird, desired)
        desired.sub(bird.position).multiplyScalar(bird.response).add(this.leaderVelocity)
        return desired
      }
      case 'thermal': {
        const [, centre, exit] = this.route
        if (!centre || !exit) return desired.copy(bird.velocity)
        if (this.age > this.lifetime - DEPART.gull) {
          desired
            .copy(exit)
            .sub(bird.position)
            .setLength(speed * bird.pace)
          return desired
        }
        // Circle the thermal's core, all one way round, rising slowly with it.
        const dx = bird.position.x - centre.x,
          dz = bird.position.z - centre.z
        const angle = Math.atan2(dz, dx) + 0.6
        const reach = Math.hypot(dx, dz)
        // Far out, head for the circle; near it, follow it round.
        const radius = reach > bird.orbit * 2.5 ? reach * 0.6 : bird.orbit
        desired.set(
          centre.x + Math.cos(angle) * radius,
          centre.y + bird.level + this.age * 0.25,
          centre.z + Math.sin(angle) * radius,
        )
        desired.sub(bird.position).setLength(speed * bird.pace)
        return desired
      }
      default: {
        // Hawking.
        const [, centre, exit] = this.route
        if (!centre || !exit) return desired.copy(bird.velocity)
        if (this.age > this.lifetime - DEPART.swift) {
          desired
            .copy(exit)
            .sub(bird.position)
            .setLength(speed * 1.2)
          return desired
        }
        // Dash from point to point over the water, as swifts do after insects.
        bird.retargetIn -= dt
        if (bird.retargetIn <= 0) {
          const random = this.random
          const angle = random() * Math.PI * 2,
            reach = 11 * Math.sqrt(random())
          bird.target.set(
            centre.x + Math.cos(angle) * reach,
            centre.y + (random() - 0.5) * 6,
            centre.z + Math.sin(angle) * reach * 0.8,
          )
          bird.retargetIn = 0.5 + random() * 1.1
          bird.pace = 0.75 + random() * 0.55
        }
        desired
          .copy(bird.target)
          .sub(bird.position)
          .setLength(speed * bird.pace)
        return desired
      }
    }
  }

  /** The leader's heading frame for the formation slots. */
  private updateBasis() {
    this.heading.copy(this.leaderVelocity)
    if (this.heading.lengthSq() < 1e-6) this.heading.set(0, 0, -1)
    this.heading.normalize()
    const { right, up: lift, back } = this.basis
    back.copy(this.heading).negate()
    right.crossVectors(this.heading, up)
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
    right.normalize()
    lift.crossVectors(right, this.heading).normalize()
  }

  /** The bird's slot in the leader's frame, written to `target`. */
  private slotTarget(bird: Bird, target: Vector3) {
    const { right, up: lift, back } = this.basis
    return target
      .copy(this.leader)
      .addScaledVector(right, bird.slot.x)
      .addScaledVector(lift, bird.slot.y)
      .addScaledVector(back, bird.slot.z)
  }

  /** Pushes `desired` away from flockmates closer than the separation radius. */
  private separate(bird: Bird, index: number, desired: Vector3) {
    // Fast birds keep a little more room: they close a gap in a fraction of a second.
    const reach = Math.max(
      this.species.shape.span * FLOCK.separation,
      this.species.flight.speed * 0.12,
    )
    const strength = this.species.flight.speed * 1.4
    for (let j = 0; j < this.count; j++) {
      if (j === index) continue
      const other = this.birds[j]
      if (!other) continue
      const dx = bird.position.x - other.position.x,
        dy = bird.position.y - other.position.y,
        dz = bird.position.z - other.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= reach * reach) continue
      const d = Math.sqrt(d2) || 1e-3
      const push = (strength * (reach - d)) / reach / d
      desired.x += dx * push
      desired.y += dy * push
      desired.z += dz * push
    }
  }

  private steerLeader(dt: number) {
    // Past the last waypoint (the index runs off the route) the leader flies straight on.
    const goal = this.route[this.waypoint]
    if (goal && this.leader.distanceTo(goal) < 6) this.waypoint++
    const target = this.route[this.waypoint]
    if (target) {
      const desired = this.scratch
        .copy(target)
        .sub(this.leader)
        .setLength(this.species.flight.speed)
      this.leaderVelocity.lerp(desired, 1 - Math.exp(-dt * 0.9))
    }
    this.leader.addScaledVector(this.leaderVelocity, dt)
  }

  /**
   * A bird inside a crown's margin is pushed out and up, harder the deeper it is, so it skims
   * over or around the tree rather than through it.
   */
  private avoidCrowns(bird: Bird, dt: number) {
    const spheres = this.obstacles
    const p = bird.position
    for (let i = 0; i + 3 < spheres.length; i += 4) {
      const dx = p.x - (spheres[i] ?? 0),
        dy = p.y - (spheres[i + 1] ?? 0),
        dz = p.z - (spheres[i + 2] ?? 0)
      const reach = (spheres[i + 3] ?? 0) + FLOCK.crownMargin
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= reach * reach) continue
      const d = Math.sqrt(d2) || 1e-3
      const depth = (reach - d) / reach
      const push = 30 * depth * dt
      bird.velocity.x += (dx / d) * push
      bird.velocity.y += (Math.max(0, dy / d) + 0.6) * push
      bird.velocity.z += (dz / d) * push
    }
  }

  /** Nobody touches the water: below the floor a bird pulls up. */
  private keepAloft(bird: Bird, dt: number) {
    const floor = WATER_LEVEL + (this.species.name === 'mallard' ? 1.4 : 3)
    const below = floor - bird.position.y
    if (below > 0) bird.velocity.y += Math.min(below, 2) * 12 * dt
    if (below > -0.5 && bird.velocity.y < 0) bird.velocity.y *= Math.exp(-dt * 6)
  }

  /** The bird's frame: x across the wings, y up, z along its flight (unbanked). */
  private frameOf(bird: Bird, frame: { x: Vector3; y: Vector3; z: Vector3 }) {
    frame.z.copy(bird.velocity)
    if (frame.z.lengthSq() < 1e-8) frame.z.set(0, 0, -1)
    frame.z.normalize()
    frame.x.crossVectors(up, frame.z)
    if (frame.x.lengthSq() < 1e-8) frame.x.set(1, 0, 0)
    frame.x.normalize()
    frame.y.crossVectors(frame.z, frame.x)
    return frame
  }

  private writeBird(index: number, bird: Bird) {
    const { x, y, z } = this.frameOf(bird, this.frame)
    // Grow from the crown on take-off; fade out (by size) at the end of the flight.
    const grow = this.takeOff ? clamp(this.age / 0.4, 0, 1) : clamp(this.age / 1.5, 0, 1)
    const scale = Math.max(1e-3, bird.size * grow * clamp((this.lifetime - this.age) / 2, 0, 1))
    const c = Math.cos(bird.bank),
      s = Math.sin(bird.bank)
    const pose = this.pose
    this.axisX.setXYZW(
      index,
      (x.x * c + y.x * s) * scale,
      (x.y * c + y.y * s) * scale,
      (x.z * c + y.z * s) * scale,
      pose.shoulder,
    )
    this.axisY.setXYZW(
      index,
      (y.x * c - x.x * s) * scale,
      (y.y * c - x.y * s) * scale,
      (y.z * c - x.z * s) * scale,
      pose.wrist,
    )
    this.axisZ.setXYZW(index, z.x * scale, z.y * scale, z.z * scale, pose.fold)
    this.origin.setXYZW(index, bird.position.x, bird.position.y, bird.position.z, bird.tint)
  }

  /** Writes every bird at rest pose, for the first frame of a flight. */
  private writeInstances(dt: number) {
    for (let i = 0; i < this.count; i++) {
      const bird = this.birds[i]
      if (!bird) continue
      stepWing(bird.wing, this.species.flight, dt, false, this.random, this.pose)
      this.writeBird(i, bird)
    }
    this.markInstances()
  }

  private markInstances() {
    this.axisX.needsUpdate = true
    this.axisY.needsUpdate = true
    this.axisZ.needsUpdate = true
    this.origin.needsUpdate = true
  }

  dispose() {
    this.geometry.dispose()
    this.paint.dispose()
  }
}

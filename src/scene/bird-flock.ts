import { color } from 'three/tsl'
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  Object3D,
  Vector3,
} from 'three/webgpu'

export const FLOCK = {
  /** Birds in a flock, fewer on low-power devices. */
  size: 9,
  lowPowerSize: 6,
  /** Cruising speed, metres per second. */
  speed: 9,
  /** Seconds a flock stays in the air before it is gone. */
  lifetime: 24,
  /** Wingbeats per second while climbing, and how long a glide lasts between bursts. */
  flapRate: 7,
  glideEvery: 2.6,
  glideLength: 1.1,
  /** Wing length in metres: a crow or a jackdaw, readable as a silhouette across the lake. */
  wing: 0.5,
} as const

type Bird = {
  position: Vector3
  velocity: Vector3
  /** Formation slot relative to the leader, in its heading frame (right, up, back). */
  slot: Vector3
  /** How quickly the bird answers its slot: lower birds lag and straggle. */
  response: number
  phase: number
  bank: number
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
 * Where a flock flies after leaving `start`: up and away from the viewer, a wide turn over the
 * lake, then off over the far hills. The waypoints only steer the leader; the birds keep loose
 * slots around it, so the flock stretches and bunches as it turns.
 */
export function flockRoute(start: Vector3, viewer: Vector3, turn: number) {
  const away = new Vector3(start.x - viewer.x, 0, start.z - viewer.z)
  if (away.lengthSq() < 1e-6) away.set(0, 0, -1)
  away.normalize()
  const side = new Vector3().crossVectors(up, away).multiplyScalar(turn)
  const rise = Math.max(start.y + 7, 10)
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
 * A small flock as silhouettes: each bird is two hinged wings (one instanced mesh per side),
 * beating in bursts and gliding between them, banking into turns. Unlit and dark, it reads
 * against a bright sky the way birds do at dusk.
 */
export class BirdFlock {
  readonly group: Object3D
  private readonly material: MeshBasicNodeMaterial
  private readonly left: InstancedMesh
  private readonly right: InstancedMesh
  private readonly birds: Bird[] = []
  private readonly route: Vector3[] = []
  private readonly leader = new Vector3()
  private readonly heading = new Vector3()
  private readonly leaderVelocity = new Vector3()
  private waypoint = 0
  private age = Infinity
  private readonly dummy = new Object3D()
  private readonly wingFrame = new Object3D()
  private readonly scratch = new Vector3()
  private readonly basis = { right: new Vector3(), up: new Vector3(), back: new Vector3() }

  constructor(count: number) {
    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    material.colorNode = color(0x15181b)
    this.material = material
    // One wing: a swept triangle from the shoulder to the tip, with a sliver of body.
    const wing = (sign: number) => {
      const geometry = new BufferGeometry()
      const w = FLOCK.wing
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute(
          [0, 0, -0.12, sign * w, 0, 0.06, 0, 0, 0.16, 0, 0, -0.18, sign * 0.05, 0, 0.3, 0, 0, 0.3],
          3,
        ),
      )
      return geometry
    }
    this.left = new InstancedMesh(wing(-1), material, count)
    this.right = new InstancedMesh(wing(1), material, count)
    this.group = new Object3D()
    this.group.add(this.left, this.right)
    for (const mesh of [this.left, this.right]) {
      mesh.frustumCulled = false
      mesh.count = 0
    }
    for (let i = 0; i < count; i++)
      this.birds.push({
        position: new Vector3(),
        velocity: new Vector3(),
        slot: new Vector3(),
        response: 1,
        phase: 0,
        bank: 0,
      })
    this.group.visible = false
  }

  get active() {
    return this.group.visible
  }

  /** Startles the flock out of a crown at `start`, flying away from `viewer`. */
  launch(start: Vector3, viewer: Vector3, seed: number) {
    const random = flockRandom(seed)
    this.route.length = 0
    this.route.push(...flockRoute(start, viewer, random() < 0.5 ? -1 : 1))
    this.waypoint = 0
    this.age = 0
    this.leader.copy(start)
    this.leaderVelocity.set(0, FLOCK.speed * 0.6, 0)
    for (const [index, bird] of this.birds.entries()) {
      // A loose wedge behind the leader, jittered so it never looks drilled.
      const row = Math.ceil(index / 2),
        side = index % 2 === 0 ? 1 : -1
      bird.slot.set(
        side * row * 1.1 + (random() - 0.5) * 1.4,
        (random() - 0.5) * 1.6,
        row * 1.3 + random() * 1.5,
      )
      bird.response = 1.4 + random() * 1.4
      bird.phase = random() * Math.PI * 2
      bird.bank = 0
      bird.position.set(
        start.x + (random() - 0.5) * 1.5,
        start.y - random() * 1.2,
        start.z + (random() - 0.5) * 1.5,
      )
      bird.velocity.set((random() - 0.5) * 2, 3 + random() * 2, (random() - 0.5) * 2)
    }
    this.left.count = this.right.count = this.birds.length
    this.group.visible = true
  }

  /** The flock's mean position. */
  centre(target = new Vector3()) {
    target.set(0, 0, 0)
    for (const bird of this.birds) target.add(bird.position)
    return target.divideScalar(Math.max(1, this.birds.length))
  }

  cancel() {
    this.age = Infinity
    this.group.visible = false
  }

  update(dt: number) {
    if (!this.group.visible || !(dt > 0)) return
    this.age += dt
    if (this.age > FLOCK.lifetime) {
      this.cancel()
      return
    }
    this.steerLeader(dt)
    const { right, up: lift, back } = this.basis
    back.copy(this.heading).negate()
    right.crossVectors(this.heading, up)
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
    right.normalize()
    lift.crossVectors(right, this.heading).normalize()
    for (const [index, bird] of this.birds.entries()) {
      const target = this.scratch
        .copy(this.leader)
        .addScaledVector(right, bird.slot.x)
        .addScaledVector(lift, bird.slot.y)
        .addScaledVector(back, bird.slot.z)
      // Steer toward the slot at a speed near the cruise, so stragglers catch up.
      const desired = target.sub(bird.position).multiplyScalar(bird.response)
      desired.add(this.leaderVelocity)
      const speed = desired.length()
      if (speed > FLOCK.speed * 1.5) desired.multiplyScalar((FLOCK.speed * 1.5) / speed)
      const before = Math.atan2(bird.velocity.x, bird.velocity.z)
      bird.velocity.lerp(desired, 1 - Math.exp(-dt * 2.2))
      bird.position.addScaledVector(bird.velocity, dt)
      const after = Math.atan2(bird.velocity.x, bird.velocity.z)
      const turnRate = wrapAngle(after - before) / dt
      bird.bank += (clamp(-turnRate * 0.35, -0.9, 0.9) - bird.bank) * (1 - Math.exp(-dt * 4))
      this.placeBird(index, bird, dt)
    }
    this.left.instanceMatrix.needsUpdate = true
    this.right.instanceMatrix.needsUpdate = true
  }

  private steerLeader(dt: number) {
    const goal = this.route[this.waypoint]
    if (goal && this.leader.distanceTo(goal) < 6 && this.waypoint < this.route.length - 1)
      this.waypoint++
    const target = this.route[this.waypoint]
    if (target) {
      const desired = this.scratch.copy(target).sub(this.leader).setLength(FLOCK.speed)
      this.leaderVelocity.lerp(desired, 1 - Math.exp(-dt * 0.9))
    }
    this.leader.addScaledVector(this.leaderVelocity, dt)
    this.heading.copy(this.leaderVelocity)
    if (this.heading.lengthSq() < 1e-6) this.heading.set(0, 0, -1)
    this.heading.normalize()
  }

  private placeBird(index: number, bird: Bird, dt: number) {
    // Bursts of beats, then a glide with the wings held a little up; faster beats when climbing.
    const climbing = bird.velocity.y > 1.5
    const cycle = (this.age + bird.phase) % FLOCK.glideEvery
    const gliding = !climbing && cycle < FLOCK.glideLength
    bird.phase += dt * FLOCK.flapRate * Math.PI * 2 * (gliding ? 0 : climbing ? 1.25 : 1)
    const flap = gliding ? 0.12 : Math.sin(bird.phase) * 0.75 + 0.1
    // Fade in from the crown and out at the end of the flight.
    const presence = clamp(this.age / 0.4, 0, 1) * clamp((FLOCK.lifetime - this.age) / 2, 0, 1)
    const dummy = this.dummy
    dummy.position.copy(bird.position)
    dummy.up.set(0, 1, 0)
    dummy.lookAt(this.scratch.copy(bird.position).add(bird.velocity))
    dummy.rotateZ(bird.bank)
    dummy.scale.setScalar(presence)
    for (const [mesh, sign] of [
      [this.left, -1],
      [this.right, 1],
    ] as const) {
      this.wingFrame.position.set(0, 0, 0)
      this.wingFrame.rotation.set(0, 0, sign * flap)
      this.wingFrame.updateMatrix()
      dummy.updateMatrix()
      dummy.matrix.multiply(this.wingFrame.matrix)
      mesh.setMatrixAt(index, dummy.matrix)
    }
  }

  dispose() {
    this.left.geometry.dispose()
    this.right.geometry.dispose()
    this.material.dispose()
  }
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))

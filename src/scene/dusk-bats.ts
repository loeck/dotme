import { abs, attribute, cos, positionLocal, sin, uniform, vec3 } from 'three/tsl'
import {
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  Object3D,
  Vector3,
} from 'three/webgpu'

import { flockRandom } from './bird-flock'
import { smoothstep as smooth } from './math'
import type { SolarEndpoints } from './solar-clock'

export const BATS = {
  /** Bats over the lake at full activity, fewer on low-power devices. */
  count: 6,
  lowPowerCount: 4,
  /** Cruising speeds, metres per second: a pipistrelle hawks at 4–7 m/s. */
  speed: [4.5, 7] as const,
  /** Seconds between the sudden turns of a hunting bat. */
  turn: [0.22, 0.75] as const,
  /** Wingbeats per second; real pipistrelles beat 10–15 times, which would alias at 30 fps. */
  flapRate: 9,
  /** Wingspan in metres: a noctule, the big bat that hunts high over lakes at dusk. */
  span: 0.4,
  /** Seconds a bat takes to arrive from, or leave for, the tree line. */
  fade: 1.6,
} as const

const DAY = 86_400
const wrap = (seconds: number) => ((seconds % DAY) + DAY) % DAY
/** Signed seconds from `from` to `to` on the clock, within half a day either way. */
const since = (to: number, from: number) => {
  const d = wrap(to - from)
  return d > DAY / 2 ? d - DAY : d
}

/**
 * How many bats are out at a solar time: they leave the roost about twenty minutes after
 * sunset and hunt hardest for the next hour, then forage scattered and out of sight; before dawn
 * they feed again on the way home. 0–1, fading in over a quarter of an hour.
 */
export function batActivity(solarSeconds: number, solar: SolarEndpoints) {
  const dusk = since(solarSeconds, solar.sunset) / 60
  const dawn = since(solar.sunrise, solarSeconds) / 60
  const evening = smooth(14, 28, dusk) * (1 - smooth(60, 80, dusk))
  const morning = smooth(95, 80, dawn) * (1 - smooth(35, 20, dawn))
  return Math.max(evening, morning)
}

/** Where a bat hunts: a loose beat over the lake's near water and the far tree line. */
export type BatBeat = Readonly<{ centre: Vector3; radius: number; height: number }>

type Bat = {
  beat: BatBeat
  position: Vector3
  velocity: Vector3
  target: Vector3
  speed: number
  retargetIn: number
  glideFor: number
  phase: number
  rate: number
  flap: number
  presence: number
  /** Share of activity this bat needs before it comes out. */
  threshold: number
  bank: number
}

/** Seeded beats over the lake, spread across the frame. */
export function batBeats(seed: number, count: number): BatBeat[] {
  const random = flockRandom((seed ^ 0xba75) >>> 0)
  return Array.from({ length: count }, (_, i) => {
    const across = count > 1 ? i / (count - 1) - 0.5 : 0
    return {
      centre: new Vector3(
        across * 22 + (random() - 0.5) * 5,
        7.5 + random() * 3.5,
        -2 - random() * 12,
      ),
      radius: 4 + random() * 3,
      height: 1.2 + random() * 1.4,
    }
  })
}

/**
 * A hunting bat's flight: it heads for a point in its beat and, every fraction of a second,
 * breaks off for another, so the path zigzags; now and then it drops at prey, or glides a
 * moment on spread wings. Pure apart from `random`, so tests can follow a seeded bat.
 */
export function stepBat(bat: Bat, dt: number, random: () => number) {
  bat.retargetIn -= dt
  if (bat.retargetIn <= 0) {
    const angle = random() * Math.PI * 2
    const reach = bat.beat.radius * Math.sqrt(random())
    // One turn in six is a stoop at an insect, low over the water or the reeds.
    const stoop = random() < 0.17 ? -bat.beat.height * 1.6 : 0
    bat.target.set(
      bat.beat.centre.x + Math.cos(angle) * reach,
      bat.beat.centre.y + (random() - 0.5) * 2 * bat.beat.height + stoop,
      bat.beat.centre.z + Math.sin(angle) * reach * 0.7,
    )
    bat.retargetIn = BATS.turn[0] + random() * (BATS.turn[1] - BATS.turn[0])
    bat.speed = BATS.speed[0] + random() * (BATS.speed[1] - BATS.speed[0])
    if (random() < 0.22) bat.glideFor = 0.12 + random() * 0.25
  }
  bat.glideFor = Math.max(0, bat.glideFor - dt)
  const desiredX = bat.target.x - bat.position.x,
    desiredY = bat.target.y - bat.position.y,
    desiredZ = bat.target.z - bat.position.z
  const length = Math.hypot(desiredX, desiredY, desiredZ) || 1
  // A bat turns on a wingtip: it answers its new heading within a few hundredths of a second.
  const follow = 1 - Math.exp(-dt * 7)
  bat.velocity.x += ((desiredX / length) * bat.speed - bat.velocity.x) * follow
  bat.velocity.y += ((desiredY / length) * bat.speed * 0.6 - bat.velocity.y) * follow
  bat.velocity.z += ((desiredZ / length) * bat.speed - bat.velocity.z) * follow
  bat.position.addScaledVector(bat.velocity, dt)
}

/**
 * A few bats hawking over the lake at dusk and before dawn: dark silhouettes, one instanced
 * draw, the wing beat in the vertex shader. Each comes out of the tree line in turn as
 * activity rises and goes back the same way.
 */
export class DuskBats {
  readonly mesh: InstancedMesh<BufferGeometry, MeshBasicNodeMaterial>
  private readonly bats: Bat[]
  private readonly flaps: InstancedBufferAttribute
  private readonly time = uniform(0)
  private readonly random: () => number
  private readonly dummy = new Object3D()
  private readonly look = new Vector3()

  constructor(count: number, seed: number) {
    this.random = flockRandom((seed ^ 0x5eba7) >>> 0)
    const geometry = batGeometry()
    this.flaps = new InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(
      DynamicDrawUsage,
    )
    geometry.setAttribute('aFlap', this.flaps)
    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    material.colorNode = vec3(0.012, 0.012, 0.014)
    // Wings hinge at the body: each wing vertex turns about the body's long axis by the beat.
    const flap = attribute<'vec3'>('aFlap')
    const angle = sin(this.time.mul(flap.z).add(flap.x)).mul(flap.y).add(0.12)
    const reach = abs(positionLocal.x)
    material.positionNode = vec3(
      positionLocal.x.mul(cos(angle)),
      positionLocal.y.add(reach.mul(sin(angle))),
      positionLocal.z,
    )
    this.mesh = new InstancedMesh(geometry, material, count)
    this.mesh.name = 'Dusk bats'
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    const beats = batBeats(seed, count)
    this.bats = beats.map((beat, i) => ({
      beat,
      position: beat.centre.clone(),
      velocity: new Vector3(),
      target: beat.centre.clone(),
      speed: BATS.speed[0],
      retargetIn: 0,
      glideFor: 0,
      phase: this.random() * Math.PI * 2,
      rate: BATS.flapRate * (0.85 + this.random() * 0.3) * Math.PI * 2,
      flap: 0.9,
      presence: 0,
      threshold: ((i + 0.5) / count) * 0.85,
      bank: 0,
    }))
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, this.dummy.matrix.makeScale(0, 0, 0))
  }

  /** Bats on screen (any presence). */
  get visible() {
    return this.mesh.visible
  }

  /** `activity` 0–1 from `batActivity` and the weather; `time` drives the wing beat. */
  update(time: number, dt: number, activity: number) {
    this.time.value = time
    let any = false
    for (const [index, bat] of this.bats.entries()) {
      const wanted = activity > bat.threshold ? 1 : 0
      if (bat.presence === 0 && wanted === 0) continue
      if (bat.presence === 0) this.emerge(bat)
      const step = dt / BATS.fade
      bat.presence = Math.max(0, Math.min(1, bat.presence + (wanted ? step : -step)))
      if (bat.presence === 0) {
        this.mesh.setMatrixAt(index, this.dummy.matrix.makeScale(0, 0, 0))
        continue
      }
      any = true
      if (wanted === 0) {
        // Leaving: back over the far trees, climbing.
        bat.target.set(bat.beat.centre.x, bat.beat.centre.y + 6, bat.beat.centre.z - 40)
        bat.retargetIn = 1
      }
      const before = Math.atan2(bat.velocity.x, bat.velocity.z)
      stepBat(bat, dt, this.random)
      const after = Math.atan2(bat.velocity.x, bat.velocity.z)
      const turn =
        Math.atan2(Math.sin(after - before), Math.cos(after - before)) / Math.max(dt, 1e-3)
      bat.bank += (Math.max(-1, Math.min(1, -turn * 0.12)) - bat.bank) * (1 - Math.exp(-dt * 10))
      const flap = bat.glideFor > 0 ? 0.18 : 0.95
      bat.flap += (flap - bat.flap) * (1 - Math.exp(-dt * 14))
      this.flaps.setXYZ(index, bat.phase, bat.flap, bat.rate)
      this.place(index, bat)
    }
    this.mesh.visible = any
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.flaps.needsUpdate = true
    }
  }

  /** A bat comes out over the tree line beyond its beat. */
  private emerge(bat: Bat) {
    const random = this.random
    bat.position.set(
      bat.beat.centre.x + (random() - 0.5) * 8,
      bat.beat.centre.y + 3 + random() * 2,
      bat.beat.centre.z - 14 - random() * 8,
    )
    bat.velocity.set(0, 0, BATS.speed[0])
    bat.retargetIn = 0
  }

  private place(index: number, bat: Bat) {
    const dummy = this.dummy
    dummy.position.copy(bat.position)
    dummy.up.set(0, 1, 0)
    dummy.lookAt(this.look.copy(bat.position).add(bat.velocity))
    dummy.rotateZ(bat.bank)
    // Out of the trees and back: the silhouette grows from nothing over the fade.
    dummy.scale.setScalar(smooth(0, 1, bat.presence))
    dummy.updateMatrix()
    this.mesh.setMatrixAt(index, dummy.matrix)
  }

  /** Clears every bat, for reduced motion or a frozen frame. */
  clear() {
    for (const [index, bat] of this.bats.entries()) {
      bat.presence = 0
      this.mesh.setMatrixAt(index, this.dummy.matrix.makeScale(0, 0, 0))
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = false
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}

/**
 * A bat seen from below, flat in its local XZ plane (forward +Z): a small body and two wings
 * whose trailing edges scallop between the fingers.
 */
function batGeometry() {
  const s = BATS.span / 0.3
  const wing = (sign: number) => {
    const p = (x: number, z: number) => [sign * x * s, 0, z * s]
    const shoulder = p(0.012, 0.03)
    const outline = [
      p(0.06, 0.05),
      p(0.15, 0.005),
      p(0.11, -0.018),
      p(0.088, -0.048),
      p(0.055, -0.03),
      p(0.016, -0.058),
    ]
    const triangles: number[] = []
    for (let i = 0; i + 1 < outline.length; i++)
      triangles.push(...shoulder, ...(outline[i] ?? []), ...(outline[i + 1] ?? []))
    return triangles
  }
  const body = [
    [0, 0, 0.07],
    [0.017, 0, 0.005],
    [0, 0, -0.065],
    [-0.017, 0, 0.005],
  ].map(([x = 0, y = 0, z = 0]) => [x * s, y, z * s])
  const [head = [], right = [], tail = [], left = []] = body
  const positions = [...wing(1), ...wing(-1), ...head, ...right, ...tail, ...head, ...tail, ...left]
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return geometry
}

export type { Bat }

import { color } from 'three/tsl'
import { CylinderGeometry, Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu'

/** One contact of a skipping stone with the lake, `at` seconds after the throw. */
export type Touchdown = Readonly<{ x: number; z: number; at: number; energy: number }>

export const SKIP = {
  /** Slowest flick across the water, in metres per second, that throws a stone. */
  minSpeed: 5,
  /** First hop per metre-per-second of flick, bounded. */
  hopPerSpeed: 0.45,
  minFirstHop: 2,
  maxFirstHop: 11,
  /** Each hop keeps this share of the previous one, as the stone loses speed. */
  decay: 0.7,
  /** Below this a hop is a slide: the stone sinks instead. */
  minHop: 0.5,
  maxTouchdowns: 10,
  /** Seconds from the hand to the first touchdown. */
  throwTime: 0.32,
} as const

/** A screen position of the dragging pointer and its event time, in milliseconds. */
export type FlickSample = Readonly<{ x: number; y: number; time: number }>

/** Shortest span a flick's speed is measured over, in milliseconds. */
const FLICK_SPAN = 40

/**
 * The sample a flick's speed is measured from: the newest one at least 40 ms before the
 * release, else the oldest (the press). Moves that arrive coalesced on a busy frame often land
 * on the release point itself, which would read as no motion at all.
 */
export function flickOrigin(samples: readonly FlickSample[], releaseTime: number) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i]
    if (sample && releaseTime - sample.time >= FLICK_SPAN) return sample
  }
  return samples[0]
}

/** Seconds in the air for a hop of `length` metres: short hops are quicker but not instant. */
export const hopDuration = (length: number) => 0.12 + 0.1 * Math.sqrt(Math.max(0, length))

/**
 * The stone lands where the flick ended and skips on in its direction, each hop shorter than
 * the last, until a hop is too short (it sinks there) or the next landing is not open water
 * (it sinks before the bank). The last touchdown is where it sinks; every earlier one is a skip.
 */
export function planSkips(
  landing: Readonly<{ x: number; z: number }>,
  direction: Readonly<{ x: number; z: number }>,
  speed: number,
  isWater: (x: number, z: number) => boolean,
): Touchdown[] {
  const length = Math.hypot(direction.x, direction.z)
  if (!(length > 0) || !(speed > 0)) return [{ ...landing, at: SKIP.throwTime, energy: 1 }]
  const dx = direction.x / length,
    dz = direction.z / length
  const firstHop = Math.max(SKIP.minFirstHop, Math.min(SKIP.maxFirstHop, speed * SKIP.hopPerSpeed))
  const touchdowns: Touchdown[] = [{ x: landing.x, z: landing.z, at: SKIP.throwTime, energy: 1 }]
  let hop = firstHop,
    x = landing.x,
    z = landing.z,
    at = SKIP.throwTime
  while (touchdowns.length < SKIP.maxTouchdowns && hop >= SKIP.minHop) {
    const nx = x + dx * hop,
      nz = z + dz * hop
    if (!isWater(nx, nz)) break
    at += hopDuration(hop)
    x = nx
    z = nz
    touchdowns.push({ x, z, at, energy: 0.35 + 0.65 * Math.sqrt(hop / firstHop) })
    hop *= SKIP.decay
  }
  return touchdowns
}

/**
 * A flat stone following a plan: a lob from the thrower's hand to the first touchdown, then
 * parabolic hops whose height scales with their length, spinning flat as a skimmer does.
 * Touchdowns are reported once each, in order, as the clock passes them.
 */
export class SkippingStone {
  readonly mesh: Mesh<CylinderGeometry, MeshStandardNodeMaterial>
  private plan: readonly Touchdown[] = []
  private readonly hand = new Vector3()
  private startedAt = 0
  private next = 0
  private readonly waterLevel: number

  constructor(waterLevel: number) {
    this.waterLevel = waterLevel
    const material = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 })
    material.colorNode = color(0x55524c)
    this.mesh = new Mesh(new CylinderGeometry(0.075, 0.085, 0.028, 14), material)
    this.mesh.visible = false
    this.mesh.frustumCulled = false
  }

  get active() {
    return this.mesh.visible
  }

  throw(hand: Vector3, plan: readonly Touchdown[], now: number) {
    if (plan.length === 0) return
    this.hand.copy(hand)
    this.plan = plan
    this.startedAt = now
    this.next = 0
    this.mesh.visible = true
  }

  cancel() {
    this.plan = []
    this.mesh.visible = false
  }

  /** Moves the stone to `now` and reports each touchdown passed since the last update. */
  update(now: number, onTouchdown: (touchdown: Touchdown, index: number, last: boolean) => void) {
    if (!this.mesh.visible) return
    const t = now - this.startedAt
    while (this.next < this.plan.length) {
      const touchdown = this.plan[this.next]
      if (!touchdown || touchdown.at > t) break
      const index = this.next++
      onTouchdown(touchdown, index, this.next === this.plan.length)
    }
    const last = this.plan[this.plan.length - 1]
    if (!last || t >= last.at) {
      this.cancel()
      return
    }
    let segment = 0
    while ((this.plan[segment]?.at ?? Infinity) <= t) segment++
    const to = this.plan[segment]
    if (!to) return
    const from = segment === 0 ? null : this.plan[segment - 1]
    const fromX = from ? from.x : this.hand.x,
      fromY = from ? this.waterLevel : this.hand.y,
      fromZ = from ? from.z : this.hand.z,
      fromAt = from ? from.at : 0
    const s = (t - fromAt) / Math.max(0.001, to.at - fromAt)
    const length = Math.hypot(to.x - fromX, to.z - fromZ)
    const lift = from ? 0.08 * length : 0.25
    this.mesh.position.set(
      fromX + (to.x - fromX) * s,
      fromY + (this.waterLevel - fromY) * s + 4 * lift * s * (1 - s),
      fromZ + (to.z - fromZ) * s,
    )
    this.mesh.rotation.set(0.12, t * 28, 0.08)
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

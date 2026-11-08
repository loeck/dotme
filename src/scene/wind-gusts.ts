import { exp, uniform, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { Vector2 } from 'three/webgpu'

export const GUST = {
  /** Radius of the cursor's soft wind patch, metres. */
  radius: 9,
  /** Screen speed for the full push, CSS pixels per second. Slower moves stay proportional. */
  fullSweep: 1600,
  /** Critically damped response rates, per second, for the push and its position. */
  response: 10,
  follow: 14,
  /** Added bend under a full sweep; the sward takes a smaller share. */
  lean: 0.6,
} as const

type CursorWind = Readonly<{
  x: number
  z: number
  dx: number
  dz: number
  pixelsPerSecond: number
}>

/** Exact critically damped response: preserve velocity through starts, stops and reversals. */
function follow(value: Vector2, velocity: Vector2, x: number, z: number, rate: number, dt: number) {
  const decay = Math.exp(-rate * dt)
  for (let axis = 0; axis < 2; axis++) {
    const target = axis === 0 ? x : z
    const offset = value.getComponent(axis) - target
    const change = velocity.getComponent(axis) + rate * offset
    value.setComponent(axis, target + (offset + change * dt) * decay)
    velocity.setComponent(axis, (velocity.getComponent(axis) - rate * change * dt) * decay)
  }
}

/** Continuous cursor wind shared by the vegetation shader and falling leaves. */
export class WindGusts {
  private readonly centre = uniform(new Vector2())
  private readonly flow = uniform(new Vector2())
  private readonly flowVelocity = new Vector2()
  private readonly centreVelocity = new Vector2()
  private readonly targetCentre = new Vector2()
  private placed = false

  /** Follow the cursor's velocity, or settle smoothly when it stops or leaves the scene. */
  update(contact: CursorWind | null, dt: number) {
    if (!(dt > 0) || !Number.isFinite(dt)) return
    let x = 0,
      z = 0
    if (contact) {
      if (!this.placed || (!this.active() && this.flowVelocity.lengthSq() < 1e-8)) {
        this.centre.value.set(contact.x, contact.z)
        this.placed = true
      }
      this.targetCentre.set(contact.x, contact.z)
      const length = Math.hypot(contact.dx, contact.dz)
      const strength = Math.min(1, Math.max(0, contact.pixelsPerSecond) / GUST.fullSweep)
      if (length > 1e-6) {
        x = (contact.dx / length) * strength
        z = (contact.dz / length) * strength
      }
    }
    follow(
      this.centre.value,
      this.centreVelocity,
      this.targetCentre.x,
      this.targetCentre.y,
      GUST.follow,
      dt,
    )
    follow(this.flow.value, this.flowVelocity, x, z, GUST.response, dt)
  }

  /** The same local horizontal push the shader applies; falling leaves ride this field. */
  pushAt(x: number, z: number, out: [number, number]) {
    const dx = x - this.centre.value.x,
      dz = z - this.centre.value.y
    const envelope = Math.exp(-(dx * dx + dz * dz) / (GUST.radius * GUST.radius))
    out[0] = this.flow.value.x * envelope
    out[1] = this.flow.value.y * envelope
    return Math.hypot(out[0], out[1])
  }

  active() {
    return this.flow.value.lengthSq() > 1e-8
  }

  clear() {
    this.flow.value.set(0, 0)
    this.flowVelocity.set(0, 0)
    this.centreVelocity.set(0, 0)
    this.placed = false
  }

  /** A smooth lean with the stroke: no cursor-driven oscillation or per-card shaking. */
  sway(position: Node<'vec3'>, bend: Node<'float'>, scale = 1) {
    const offset = position.xz.sub(this.centre)
    const envelope = exp(offset.dot(offset).div(-GUST.radius * GUST.radius))
    return vec3(this.flow.x, 0, this.flow.y)
      .mul(envelope)
      .mul(bend)
      .mul(GUST.lean * scale)
  }
}

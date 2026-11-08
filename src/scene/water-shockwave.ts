import { exp, float, smoothstep, uniform, uv, vec3 } from 'three/tsl'
import { DoubleSide, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu'

import { GLOW_BLENDING } from './glow-blending'

export const SHOCK = {
  /** Seconds a still press must last before it starts to charge. */
  hold: 0.45,
  /** Seconds from the start of the charge to full charge. */
  fill: 1.6,
  /** A press that moves this many CSS pixels is a drag, not a charge. */
  slop: 12,
  /** Weakest charge that releases a wave; below it the press is an ordinary tap. */
  minCharge: 0.15,
  /** Ring radius on the water while charging, metres, from empty to full. */
  ringFrom: 0.3,
  ringTo: 1.6,
  /** The released ring runs out to this radius in `burst` seconds and fades. */
  burstRadius: 7,
  burst: 0.7,
} as const

/** Charge of a press held for `held` seconds without moving: 0 until the hold, 1 when full. */
export function shockCharge(held: number) {
  if (!(held > SHOCK.hold)) return 0
  const t = Math.min(1, (held - SHOCK.hold) / SHOCK.fill)
  // Eases in, so the first moments of the charge read as a gathering rather than a jump.
  return t * t * (3 - 2 * t)
}

/** The wave a release sends out: radius and downward velocity of the impulse in the lake. */
export function shockImpulse(charge: number) {
  const c = Math.max(0, Math.min(1, charge))
  return { radius: 1.2 + 1.6 * c, velocity: -(0.2 + 0.45 * c) }
}

type Press = { x: number; z: number; clientX: number; clientY: number; at: number }

/**
 * A long, still press on the water gathers a glowing ring under the finger; letting go sends
 * a wave rolling out to the banks. Moving the press first turns it back into a drag.
 */
export class WaterShockwave {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  private readonly opacity = uniform(0)
  private press: Press | null = null
  private releasedAt = -Infinity
  private releasedCharge = 0

  constructor(waterLevel: number) {
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      ...GLOW_BLENDING,
      depthWrite: false,
      side: DoubleSide,
    })
    const r = uv().sub(0.5).mul(2).length()
    const ring = exp(r.sub(0.88).div(0.045).pow2().negate())
    const glow = exp(r.mul(r).mul(-6)).mul(0.12)
    material.colorNode = vec3(1, 0.9, 0.72)
    material.opacityNode = ring
      .add(glow)
      .mul(float(1).sub(smoothstep(0.95, 1, r)))
      .mul(this.opacity)
    this.mesh = new Mesh(new PlaneGeometry(2, 2), material)
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.position.y = waterLevel + 0.04
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
  }

  /** Starts watching a press on the water at (x, z). */
  start(x: number, z: number, clientX: number, clientY: number, now: number) {
    this.press = { x, z, clientX, clientY, at: now }
  }

  /** A press that wanders off its spot no longer charges. */
  move(clientX: number, clientY: number) {
    const press = this.press
    if (press && Math.hypot(clientX - press.clientX, clientY - press.clientY) > SHOCK.slop)
      this.press = null
  }

  /** The current charge, 0 when no press is charging. */
  charge(now: number) {
    return this.press ? shockCharge(now - this.press.at) : 0
  }

  /** Ends the press; returns where and how strong a wave to release, or null for a tap. */
  release(now: number) {
    const press = this.press
    this.press = null
    if (!press) return null
    const charge = shockCharge(now - press.at)
    if (charge < SHOCK.minCharge) return null
    this.releasedAt = now
    this.releasedCharge = charge
    return { x: press.x, z: press.z, charge }
  }

  /** Forgets a press without releasing it: the pointer left or was cancelled. */
  abort() {
    this.press = null
  }

  /** The charging press's spot on the water, or null. */
  get pressed(): Readonly<{ x: number; z: number }> | null {
    return this.press
  }

  cancel() {
    this.press = null
    this.releasedAt = -Infinity
    this.mesh.visible = false
  }

  /** Places and fades the ring for time `now`, in seconds. */
  update(now: number) {
    const press = this.press
    const charge = this.charge(now)
    if (press && charge > 0) {
      // A slow breath while charging, brighter as it fills.
      const breath = 1 + 0.06 * Math.sin((now - press.at) * 9)
      this.place(
        press.x,
        press.z,
        (SHOCK.ringFrom + (SHOCK.ringTo - SHOCK.ringFrom) * charge) * breath,
      )
      this.opacity.value = 0.12 + 0.43 * charge
      return
    }
    const age = (now - this.releasedAt) / SHOCK.burst
    if (age >= 0 && age < 1) {
      const radius = SHOCK.ringTo + (SHOCK.burstRadius - SHOCK.ringTo) * (1 - (1 - age) ** 3)
      this.mesh.scale.setScalar(radius)
      this.opacity.value = (1 - age) ** 2 * (0.2 + 0.3 * this.releasedCharge)
      this.mesh.visible = true
      return
    }
    this.mesh.visible = false
  }

  private place(x: number, z: number, radius: number) {
    this.mesh.position.x = x
    this.mesh.position.z = z
    this.mesh.scale.setScalar(radius)
    this.mesh.visible = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

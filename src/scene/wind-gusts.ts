import { exp, float, max, sin, uniform, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { Vector4 } from 'three/webgpu'

export const GUST = {
  /** Gusts in flight at once; a new one replaces the oldest. */
  slots: 3,
  /**
   * Metres per second the front travels along the sweep: it follows the pointer's own pace on
   * the ground, within these bounds, so the trees the sweep crosses are the ones that lean.
   */
  minSpeed: 8,
  maxSpeed: 30,
  /** Half-thickness of the front along its travel, and half-width across it, metres. */
  length: 4.5,
  width: 9,
  /** Seconds a gust lasts, fading as it goes. */
  life: 3.2,
  /** Shortest time between two gusts from one sweep, seconds. */
  spacing: 0.1,
  /**
   * Lean added at full strength, in the vegetation's own bend units (a strong breeze leans ~0.7):
   * a light nudge, so a sweep stirs the crown rather than bending the whole tree over.
   */
  lean: 0.6,
  /**
   * Rustle at full strength, as a multiple of each card's or blade's own flutter (a few
   * centimetres on a card): the foliage the sweep crosses shakes, piece by piece, on its twigs.
   */
  rustle: 6,
  /**
   * Screen speed of the pointer, CSS px/s, from which a sweep raises a gust, and full strength.
   * An ordinary brisk swipe is 600–1500 px/s; a gust that needed 1400 px/s rarely happened.
   */
  minSweep: 450,
  fullSweep: 2200,
} as const

/** Strength of a gust for a pointer sweeping `pixelsPerSecond` across the screen, 0 below it. */
export function sweepStrength(pixelsPerSecond: number) {
  if (!(pixelsPerSecond >= GUST.minSweep)) return 0
  return Math.min(
    1,
    0.45 + (0.55 * (pixelsPerSecond - GUST.minSweep)) / (GUST.fullSweep - GUST.minSweep),
  )
}

/**
 * How strongly a gust pushes a point `along` metres down its path and `across` metres to its
 * side, `age` seconds after it started: a band moving at `speed` m/s, fading to nothing over
 * its life. The shader computes the same envelope.
 */
export function gustEnvelope(along: number, across: number, age: number, speed: number) {
  if (!(age >= 0) || age >= GUST.life) return 0
  const front = (along - age * speed) / GUST.length
  const side = across / GUST.width
  return Math.exp(-front * front - side * side) * (1 - age / GUST.life) ** 2
}

/**
 * Gusts the visitor raises by sweeping the pointer: each is a band of wind that runs across the
 * grass and through the trees in the sweep's direction, leaning everything it passes and
 * fading out within a few seconds. Kept in a few uniforms, read by the vegetation's sway.
 */
export class WindGusts {
  /** Per slot: origin x, z and unit direction x, z. */
  private readonly paths = Array.from({ length: GUST.slots }, () => uniform(new Vector4()))
  /** Per slot: start time, strength (0 is an empty slot) and front speed. */
  private readonly states = Array.from({ length: GUST.slots }, () =>
    uniform(new Vector4(-1000, 0, 0, 0)),
  )
  private next = 0
  private lastAt = -Infinity

  /**
   * Raises a gust at (x, z) blowing along (dx, dz) at `pace` m/s (clamped to the gust speeds),
   * at time `now`. Returns false when too soon after the last.
   */
  raise(
    x: number,
    z: number,
    dx: number,
    dz: number,
    strength: number,
    now: number,
    pace: number = GUST.minSpeed,
  ) {
    const length = Math.hypot(dx, dz)
    if (!(length > 0) || !(strength > 0) || !Number.isFinite(x + z + now)) return false
    if (now - this.lastAt < GUST.spacing) return false
    this.lastAt = now
    const slot = this.next
    this.next = (this.next + 1) % GUST.slots
    this.paths[slot]?.value.set(x, z, dx / length, dz / length)
    const speed = Math.min(GUST.maxSpeed, Math.max(GUST.minSpeed, Number.isFinite(pace) ? pace : 0))
    this.states[slot]?.value.set(now, Math.min(1, strength), speed, 0)
    return true
  }

  /** The gust push at a point, as the shader computes it; for tests. */
  at(x: number, z: number, now: number) {
    let sum = 0
    for (let i = 0; i < GUST.slots; i++) {
      const path = this.paths[i]?.value,
        state = this.states[i]?.value
      if (!path || !state || state.y <= 0) continue
      const ox = x - path.x,
        oz = z - path.y
      sum +=
        state.y *
        gustEnvelope(ox * path.z + oz * path.w, ox * path.w - oz * path.z, now - state.x, state.z)
    }
    return sum
  }

  /**
   * Horizontal push (strength × envelope along each gust's direction) at a point, summed over the
   * gusts in flight, written into `out` as [x, z]; returns its magnitude. Falling leaves ride it.
   */
  pushAt(x: number, z: number, now: number, out: [number, number]) {
    out[0] = 0
    out[1] = 0
    for (let i = 0; i < GUST.slots; i++) {
      const path = this.paths[i]?.value,
        state = this.states[i]?.value
      if (!path || !state || state.y <= 0) continue
      const ox = x - path.x,
        oz = z - path.y
      const push =
        state.y *
        gustEnvelope(ox * path.z + oz * path.w, ox * path.w - oz * path.z, now - state.x, state.z)
      out[0] += path.z * push
      out[1] += path.w * push
    }
    return Math.hypot(out[0], out[1])
  }

  /** Whether any gust may still be blowing at `now`. */
  active(now: number) {
    return this.states.some(({ value }) => value.y > 0 && now - value.x < GUST.life)
  }

  clear() {
    for (const state of this.states) state.value.set(-1000, 0, 0, 0)
  }

  /**
   * World offset for a vertex at `position` (world XZ) with the sway attribute's `bend`, `phase`
   * and `flutter`, at shader time `time`: a light lean along the gusts' paths, and a quick rustle
   * of each card and blade (wood has no flutter, so trunks and limbs barely move).
   */
  sway(
    position: Node<'vec3'>,
    bend: Node<'float'>,
    phase: Node<'float'>,
    flutter: Node<'float'>,
    time: Node<'float'>,
    /** Share of the lean a draw takes: the sward is short and would lie flat under a full one. */
    scale = 1,
  ) {
    let push: Node<'vec3'> = vec3(0)
    let stir: Node<'float'> = float(0)
    for (let i = 0; i < GUST.slots; i++) {
      const path = this.paths[i],
        state = this.states[i]
      if (!path || !state) continue
      const ox = position.x.sub(path.x),
        oz = position.z.sub(path.y)
      const along = ox.mul(path.z).add(oz.mul(path.w))
      const across = ox.mul(path.w).sub(oz.mul(path.z))
      const age = time.sub(state.x)
      const front = along.sub(age.mul(state.z)).div(GUST.length)
      const side = across.div(GUST.width)
      const fade = max(float(0), float(1).sub(age.div(GUST.life))).pow2()
      const alive = age.greaterThanEqual(0).select(float(1), float(0))
      const envelope = exp(front.mul(front).add(side.mul(side)).negate())
        .mul(fade)
        .mul(alive)
        .mul(state.y)
      push = push.add(vec3(path.z, float(0), path.w).mul(envelope))
      stir = stir.add(envelope)
    }
    // Each piece shakes on its own phase, a little over 2 Hz, in all three directions.
    const rustle = vec3(
      sin(time.mul(13).add(phase.mul(5.3))),
      sin(time.mul(10.7).add(phase.mul(7.9))).mul(0.6),
      sin(time.mul(15.1).add(phase.mul(3.7))),
    ).mul(stir.min(1.5).mul(flutter).mul(GUST.rustle))
    return push.mul(bend.mul(GUST.lean * scale)).add(rustle)
  }
}

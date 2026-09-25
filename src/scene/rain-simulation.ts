import { required } from '../invariant'

export type RainState = Readonly<{ intensity: number; wind: Readonly<{ x: number; z: number }> }>
export const DEFAULT_RAIN: RainState = { intensity: 0.55, wind: { x: 2, z: 0.5 } }
export const RAIN_STEP = 1 / 120
export const WATER_Y = -0.035
export const IMPACT_LIFETIME = 1.1
// Conservative bounds for the lake's small wind-driven displacement. Avoid
// evaluating its spectrum while drops are still metres above the surface.
const WATER_MAX_Y = 0.5
export type RainSurfaceSampler = (x: number, z: number, time: number) => number
const bounded = (n: number, fallback: number, min: number, max: number) =>
  Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback

export function normalizeRainState(state: RainState): RainState {
  return {
    intensity: bounded(state.intensity, DEFAULT_RAIN.intensity, 0, 1),
    wind: {
      x: bounded(state.wind.x, DEFAULT_RAIN.wind.x, -20, 20),
      z: bounded(state.wind.z, DEFAULT_RAIN.wind.z, -20, 20),
    },
  }
}

export type RainPoint = { x: number; y: number; z: number }
export type SegmentTrace = (a: RainPoint, b: RainPoint) => number
export type RainDrop = RainPoint & {
  vx: number
  vy: number
  vz: number
  size: number
  seed: number
  alive: boolean
}
export type RainImpact = RainPoint & {
  vx: number
  vy: number
  vz: number
  size: number
  seed: number
  born: number
}

/** World-space metres and seconds. Fixed steps decouple emission and wind from display FPS. */
export class RainSimulation {
  readonly drops: RainDrop[]
  readonly impacts: RainImpact[]
  state: RainState = DEFAULT_RAIN
  time = 0
  private remainder = 0
  private emission = 0
  private cursor = 0
  private impactCursor = 0
  private randomState: number
  private waterSurface: RainSurfaceSampler | undefined
  private readonly previous: RainPoint = { x: 0, y: 0, z: 0 }
  readonly rate: number

  private readonly trace: SegmentTrace

  constructor(trace: SegmentTrace, mobile: boolean, seed: number) {
    this.trace = trace
    this.randomState = (seed ^ 0x9e3779b9) >>> 0
    this.rate = mobile ? 1400 : 4200
    this.drops = Array.from({ length: mobile ? 4000 : 12000 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      size: 0,
      seed: 0,
      alive: false,
    }))
    this.impacts = Array.from({ length: mobile ? 2400 : 7000 }, () => ({
      x: 0,
      y: WATER_Y,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      size: 0,
      seed: 0,
      born: -Infinity,
    }))
  }

  setRainState(state: RainState) {
    this.state = normalizeRainState(state)
    if (this.state.intensity === 0) {
      for (const drop of this.drops) drop.alive = false
      for (const impact of this.impacts) impact.born = -Infinity
      this.emission = 0
      this.remainder = 0
    }
  }

  /** The callback returns world-space height at simulation time, in seconds. */
  setWaterSurface(sampler?: RainSurfaceSampler) {
    this.waterSurface = sampler
  }

  /** Accepted frame time, including the fraction awaiting the next fixed step. */
  get elapsedTime() {
    return this.time + this.remainder
  }

  private waterHeight(x: number, z: number, time: number) {
    return this.waterSurface?.(x, z, time) ?? WATER_Y
  }

  private waterHit(a: RainPoint, b: RainPoint) {
    if (Math.min(a.y, b.y) > WATER_MAX_Y) return Infinity
    if (!this.waterSurface) {
      if (a.y <= WATER_Y) return 0
      return b.y <= WATER_Y ? (WATER_Y - a.y) / (b.y - a.y) : Infinity
    }
    const endGap = b.y - this.waterHeight(b.x, b.z, this.time)
    if (endGap > 0) return Infinity
    const startTime = this.time - RAIN_STEP
    let lowGap = a.y - this.waterHeight(a.x, a.z, startTime)
    if (lowGap <= 0) return 0
    let highGap = endGap
    let low = 0
    let high = 1
    for (let i = 0; i < 6; i++) {
      const fraction = (low + high) * 0.5
      const x = a.x + (b.x - a.x) * fraction
      const z = a.z + (b.z - a.z) * fraction
      const y = a.y + (b.y - a.y) * fraction
      const gap = y - this.waterHeight(x, z, startTime + RAIN_STEP * fraction)
      if (gap > 0) {
        low = fraction
        lowGap = gap
      } else {
        high = fraction
        highGap = gap
      }
    }
    // Interpolate the final narrow bracket to retain sub-millimetre contact
    // timing without more expensive spectrum samples.
    return low + ((high - low) * lowGap) / (lowGap - highGap)
  }

  private random() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 0x100000000
  }

  private spawn(drop: RainDrop) {
    // Small drops dominate; size is diameter in metres. Intensity changes frequency.
    drop.size = 0.0006 + this.random() ** 2.4 * 0.0038
    // Calibrated for this landscape: visible drops fall decisively even at the small end.
    drop.vy = -(6.2 + 5.3 * Math.sqrt((drop.size - 0.0006) / 0.0038))
    drop.vx = this.state.wind.x
    drop.vz = this.state.wind.z
    const flight = 22 / -drop.vy
    const landingZ = 18 - this.random() * 110
    // Spend the near-field budget in view, retaining a margin for camera parallax.
    // Existing drops stay in world space when the camera moves.
    const width = Math.min(104, Math.max(28, (16 - landingZ) * 1.25 + 18))
    drop.x = (this.random() - 0.5) * width - drop.vx * flight
    drop.z = landingZ - drop.vz * flight
    drop.y = 22
    drop.seed = this.random()
    drop.alive = true
  }

  /** Seed a steady shower without generating fictional impacts under roofs. */
  prime() {
    const count = Math.min(this.drops.length, Math.round(this.rate * this.state.intensity * 2.75))
    for (let i = 0; i < count; i++) {
      const drop = required(this.drops[i])
      this.spawn(drop)
      this.previous.x = drop.x
      this.previous.y = drop.y
      this.previous.z = drop.z
      const age = (this.random() * 22) / -drop.vy
      drop.x += drop.vx * age
      drop.y += drop.vy * age
      drop.z += drop.vz * age
      drop.alive =
        this.trace(this.previous, drop) === Infinity &&
        (drop.y > WATER_MAX_Y || drop.y > this.waterHeight(drop.x, drop.z, this.time))
    }
    this.cursor = count % this.drops.length
  }

  update(delta: number) {
    if (this.state.intensity === 0 || !Number.isFinite(delta)) return
    this.remainder += Math.max(0, Math.min(delta, 0.1))
    while (this.remainder + 1e-9 >= RAIN_STEP) {
      this.remainder = Math.max(0, this.remainder - RAIN_STEP)
      this.step()
    }
  }

  private step() {
    this.time += RAIN_STEP
    this.emission += this.state.intensity * this.rate * RAIN_STEP
    let searched = 0
    while (this.emission >= 1 && searched < this.drops.length) {
      const drop = required(this.drops[this.cursor])
      this.cursor = (this.cursor + 1) % this.drops.length
      searched++
      if (drop.alive) continue
      this.spawn(drop)
      this.emission--
    }
    // Search the pool once at most, then discard births only if every slot is occupied.
    this.emission %= 1
    for (const drop of this.drops) {
      if (!drop.alive) continue
      const { x, y, z } = drop
      this.previous.x = x
      this.previous.y = y
      this.previous.z = z
      // Most drops already match steady wind. The skipped contribution is exactly zero.
      if (drop.vx !== this.state.wind.x || drop.vz !== this.state.wind.z) {
        const response = 1 - Math.exp(-RAIN_STEP / (0.09 + drop.size * 150))
        drop.vx += (this.state.wind.x - drop.vx) * response
        drop.vz += (this.state.wind.z - drop.vz) * response
      }
      drop.x += drop.vx * RAIN_STEP
      drop.y += drop.vy * RAIN_STEP
      drop.z += drop.vz * RAIN_STEP
      const solid = this.trace(this.previous, drop)
      const water = this.waterHit(this.previous, drop)
      if (solid <= 1 && solid <= water) drop.alive = false
      else if (water <= 1) {
        drop.alive = false
        const impact = required(this.impacts[this.impactCursor])
        const hitX = x + (drop.x - x) * water
        const hitZ = z + (drop.z - z) * water
        const born = this.time - RAIN_STEP * (1 - water)
        // Every tracked water collision creates exactly one event shared by waves and splash.
        Object.assign(impact, {
          x: hitX,
          y: this.waterHeight(hitX, hitZ, born),
          z: hitZ,
          vx: drop.vx,
          vy: drop.vy,
          vz: drop.vz,
          size: drop.size,
          seed: drop.seed,
          born,
        })
        this.impactCursor = (this.impactCursor + 1) % this.impacts.length
      }
    }
  }
}

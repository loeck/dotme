import type { Voxel } from './voxel-world'

export type RainState = Readonly<{ intensity: number; wind: Readonly<{ x: number; z: number }> }>
export const DEFAULT_RAIN: RainState = { intensity: 0.55, wind: { x: 2, z: 0.5 } }
export const RAIN_STEP = 1 / 120
export const WATER_Y = -0.035
export const IMPACT_LIFETIME = 1.6
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

/** Temporary bootstrap controls; weather can replace this state at any time. */
export function queryRainState(search: string): RainState {
  const params = new URLSearchParams(search)
  const number = (key: string, fallback: number) => {
    const value = params.get(key)?.trim()
    return value ? Number(value) : fallback
  }
  const presets: Record<string, number> = { off: 0, light: 0.25, moderate: 0.55, heavy: 1 }
  const preset = params.get('rain') ?? ''
  return normalizeRainState({
    intensity: Object.hasOwn(presets, preset)
      ? presets[preset]!
      : number('rain', DEFAULT_RAIN.intensity),
    wind: { x: number('windX', DEFAULT_RAIN.wind.x), z: number('windZ', DEFAULT_RAIN.wind.z) },
  })
}

type Point = { x: number; y: number; z: number }
export type RainDrop = Point & {
  vx: number
  vy: number
  vz: number
  size: number
  seed: number
  alive: boolean
}
export type RainImpact = Point & {
  vx: number
  vz: number
  size: number
  seed: number
  born: number
}

/** Exact segment/slab intersection, including starts inside a voxel. */
function voxelHit(a: Point, b: Point, voxel: Voxel): number {
  let enter = 0
  let exit = 1
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis]
    const low = voxel[axis] - voxel.size / 2
    const high = voxel[axis] + voxel.size / 2
    if (Math.abs(delta) < 1e-12) {
      if (a[axis] < low || a[axis] > high) return Infinity
    } else {
      const t0 = (low - a[axis]) / delta
      const t1 = (high - a[axis]) / delta
      enter = Math.max(enter, Math.min(t0, t1))
      exit = Math.min(exit, Math.max(t0, t1))
      if (enter > exit) return Infinity
    }
  }
  return enter
}

// 2 m spatial buckets keep per-drop collision work local, including tree canopies.
const cell = (n: number) => Math.floor(n / 2)
const key = (x: number, y: number, z: number) => (x + 512) * 1048576 + (y + 512) * 1024 + z + 512
export class RainCollider {
  private readonly cells = new Map<number, Voxel[]>()

  constructor(voxels: readonly Voxel[]) {
    for (const voxel of voxels) {
      const half = voxel.size / 2
      if (voxel.y + half < WATER_Y) continue
      for (let x = cell(voxel.x - half); x <= cell(voxel.x + half); x++) {
        for (let y = cell(voxel.y - half); y <= cell(voxel.y + half); y++) {
          for (let z = cell(voxel.z - half); z <= cell(voxel.z + half); z++) {
            const id = key(x, y, z)
            const bucket = this.cells.get(id)
            if (bucket) bucket.push(voxel)
            else this.cells.set(id, [voxel])
          }
        }
      }
    }
  }

  /** Returns the first solid hit fraction, or Infinity. Water is checked separately. */
  trace(a: Point, b: Point): number {
    let nearest = Infinity
    for (let x = cell(Math.min(a.x, b.x)); x <= cell(Math.max(a.x, b.x)); x++) {
      for (let y = cell(Math.min(a.y, b.y)); y <= cell(Math.max(a.y, b.y)); y++) {
        for (let z = cell(Math.min(a.z, b.z)); z <= cell(Math.max(a.z, b.z)); z++) {
          const bucket = this.cells.get(key(x, y, z))
          if (bucket) for (const voxel of bucket) nearest = Math.min(nearest, voxelHit(a, b, voxel))
        }
      }
    }
    return nearest
  }
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
  private readonly previous: Point = { x: 0, y: 0, z: 0 }
  readonly rate: number

  constructor(
    readonly collider: RainCollider,
    mobile: boolean,
    seed: number,
  ) {
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
      const drop = this.drops[i]!
      this.spawn(drop)
      this.previous.x = drop.x
      this.previous.y = drop.y
      this.previous.z = drop.z
      const age = (this.random() * 22) / -drop.vy
      drop.x += drop.vx * age
      drop.y += drop.vy * age
      drop.z += drop.vz * age
      drop.alive = this.collider.trace(this.previous, drop) === Infinity
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
      const drop = this.drops[this.cursor]!
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
      const response = 1 - Math.exp(-RAIN_STEP / (0.09 + drop.size * 150))
      drop.vx += (this.state.wind.x - drop.vx) * response
      drop.vz += (this.state.wind.z - drop.vz) * response
      drop.x += drop.vx * RAIN_STEP
      drop.y += drop.vy * RAIN_STEP
      drop.z += drop.vz * RAIN_STEP
      const solid = this.collider.trace(this.previous, drop)
      const water = drop.y <= WATER_Y ? (WATER_Y - y) / (drop.y - y) : Infinity
      if (solid <= 1 && solid <= water) drop.alive = false
      else if (water <= 1) {
        drop.alive = false
        const impact = this.impacts[this.impactCursor]!
        // Every tracked water collision creates exactly one event shared by waves and splash.
        Object.assign(impact, {
          x: x + (drop.x - x) * water,
          y: WATER_Y,
          z: z + (drop.z - z) * water,
          vx: drop.vx,
          vz: drop.vz,
          size: drop.size,
          seed: drop.seed,
          born: this.time - RAIN_STEP * (1 - water),
        })
        this.impactCursor = (this.impactCursor + 1) % this.impacts.length
      }
    }
  }
}

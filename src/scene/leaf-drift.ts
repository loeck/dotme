import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { WindState } from './wind'

export function leafRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

export type Leaf = {
  x: number
  z: number
  homeX: number
  homeZ: number
  vx: number
  vz: number
  angle: number
  spin: number
  size: number
  variant: number
  phase: number
}

/** Bilinear signed shore distance; includes every emergent terrain/rock footprint. */
export function leafClearance(bed: LakeBed, x: number, z: number) {
  const n = Math.sqrt(bed.shore.length)
  const u = ((x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size) * n - 0.5
  const v = ((z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size) * n - 0.5
  if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return -1
  const ix = Math.floor(u),
    iz = Math.floor(v),
    fx = u - ix,
    fz = v - iz
  const a = bed.shore[iz * n + ix]! * (1 - fx) + bed.shore[iz * n + ix + 1]! * fx
  const b = bed.shore[(iz + 1) * n + ix]! * (1 - fx) + bed.shore[(iz + 1) * n + ix + 1]! * fx
  return a * (1 - fz) + b * fz
}

function visible(bed: LakeBed, x: number, z: number) {
  const steps = Math.ceil(Math.hypot(x, z - 16) / 0.25)
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const index = lakeIndex(bed, x * t, 16 + (z - 16) * t)
    if (index >= 0 && bed.obstacle[index]! > 2.3 * (1 - t) + WATER_LEVEL * t) return false
  }
  return true
}

export class LeafDrift {
  readonly leaves: Leaf[] = []
  private remainder = 0
  private time = 0
  constructor(
    private readonly bed: LakeBed,
    seed: number,
    mobile: boolean,
    private readonly frozen = false,
  ) {
    const random = leafRandom(seed ^ 0x1eaf)
    const candidates: Array<{ x: number; z: number; score: number }> = []
    for (let z = -24; z <= 4; z += 0.65)
      for (let x = -20; x <= 20; x += 0.65) {
        if (Math.abs(x) + 0.7 > (16 - z) * (mobile ? 0.19 : 0.65)) continue
        const clearance = leafClearance(bed, x, z)
        if (clearance < 0.65 || !visible(bed, x, z)) continue
        candidates.push({ x, z, score: clearance * 0.6 + Math.abs(z + 1) * 0.025 + random() * 1.8 })
      }
    candidates.sort((a, b) => a.score - b.score)
    for (const { x, z } of candidates) {
      if (this.leaves.length === (mobile ? 6 : 12)) break
      if (this.leaves.some((l) => Math.hypot(l.x - x, l.z - z) < 1.1)) continue
      this.leaves.push({
        x,
        z,
        homeX: x,
        homeZ: z,
        vx: 0,
        vz: 0,
        angle: random() * Math.PI * 2,
        spin: 0,
        size: 0.24 + random() * 0.09,
        variant: this.leaves.length % 3,
        phase: random() * Math.PI * 2,
      })
    }
  }

  /** Only validated moving water segments enter here; no force from a resting pointer. */
  push(ax: number, az: number, bx: number, bz: number, strength: number) {
    if (this.frozen) return
    const dx = bx - ax,
      dz = bz - az,
      length2 = dx * dx + dz * dz
    if (length2 < 1e-10) return
    for (const leaf of this.leaves) {
      const t = Math.max(0, Math.min(1, ((leaf.x - ax) * dx + (leaf.z - az) * dz) / length2))
      const rx = leaf.x - ax - dx * t,
        rz = leaf.z - az - dz * t
      const distance = Math.hypot(rx, rz)
      if (distance >= 1.25) continue
      const force = Math.min(0.22, Math.max(0, strength)) * (1 - distance / 1.25)
      const nx = distance > 0.001 ? rx / distance : -dz / Math.sqrt(length2)
      const nz = distance > 0.001 ? rz / distance : dx / Math.sqrt(length2)
      leaf.vx += nx * force
      leaf.vz += nz * force
      const speed = Math.hypot(leaf.vx, leaf.vz)
      if (speed > 0.45) {
        leaf.vx *= 0.45 / speed
        leaf.vz *= 0.45 / speed
      }
      leaf.spin = Math.max(-0.4, Math.min(0.4, leaf.spin + (nx * dz - nz * dx) * force))
    }
  }

  advance(delta: number, wind: Pick<WindState, 'direction' | 'speed'>) {
    if (this.frozen) return
    const step = 1 / 60
    this.remainder += Math.max(0, Math.min(delta, 4 * step))
    while (this.remainder + 1e-9 >= step) {
      this.remainder -= step
      this.time += step
      for (const leaf of this.leaves) {
        // Broad recirculation keeps the fixed population near its visible shore.
        const phase = this.time * 0.13 + leaf.phase
        let vx =
          wind.direction[0] * Math.min(wind.speed, 12) * 0.006 +
          Math.cos(phase) * 0.024 -
          (leaf.x - leaf.homeX) * 0.026
        let vz =
          wind.direction[1] * Math.min(wind.speed, 12) * 0.006 +
          Math.sin(phase) * 0.024 -
          (leaf.z - leaf.homeZ) * 0.026
        leaf.vx *= Math.exp(-step * 1.5)
        leaf.vz *= Math.exp(-step * 1.5)
        vx += leaf.vx
        vz += leaf.vz
        const d = leafClearance(this.bed, leaf.x, leaf.z)
        const margin = leaf.size + 0.15
        if (d < margin + 0.7) {
          const gx =
            leafClearance(this.bed, leaf.x + 0.12, leaf.z) -
            leafClearance(this.bed, leaf.x - 0.12, leaf.z)
          const gz =
            leafClearance(this.bed, leaf.x, leaf.z + 0.12) -
            leafClearance(this.bed, leaf.x, leaf.z - 0.12)
          const length = Math.hypot(gx, gz)
          if (length > 1e-5) {
            const nx = gx / length,
              nz = gz / length,
              inward = Math.min(0, vx * nx + vz * nz)
            const fade = Math.max(0, Math.min(1, (margin + 0.7 - d) / 0.7))
            vx -= inward * nx * fade
            vz -= inward * nz * fade
            vx += nx * fade * 0.018
            vz += nz * fade * 0.018
          }
        }
        const x = leaf.x + vx * step,
          z = leaf.z + vz * step
        if (leafClearance(this.bed, x, z) >= margin) {
          leaf.x = x
          leaf.z = z
        }
        leaf.spin *= Math.exp(-step * 1.8)
        leaf.angle += (Math.sin(phase * 0.7) * 0.025 + leaf.spin) * step
      }
    }
  }
}

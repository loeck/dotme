import { WATER_LEVEL, lakeIndex, sampleShore } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { sampleWindField } from './water-surface'
import type { WindState } from './wind'

type Disturbance = { x: number; z: number; radius: number; velocity: number; born: number }

const boundedSample = (height: number, dx: number, dz: number, speed: number) =>
  [
    WATER_LEVEL + Math.max(-0.22, Math.min(0.22, height)),
    Math.max(-1, Math.min(1, dx)),
    Math.max(-1, Math.min(1, dz)),
    Math.max(-1.5, Math.min(1.5, speed)),
  ] as const

/** A bounded CPU companion to the GPU field for contacts and buoyancy. */
export class WaterContact {
  private readonly disturbances: Disturbance[] = []
  private readonly bed: LakeBed

  constructor(bed: LakeBed) {
    this.bed = bed
  }

  addImpulse(x: number, z: number, radius: number, velocity: number, time: number) {
    if (!Number.isFinite(x + z + radius + velocity + time)) return
    const index = lakeIndex(this.bed, x, z)
    if (index < 0 || !this.bed.water[index]) return
    this.disturbances.push({
      x,
      z,
      radius: Math.max(0.15, Math.min(3, radius)),
      velocity: Math.max(-0.65, Math.min(0.65, velocity)),
      born: time,
    })
    if (this.disturbances.length > 32) this.disturbances.shift()
  }

  sample(x: number, z: number, time: number, wind?: WindState, footprint = 0.08) {
    const index = lakeIndex(this.bed, x, z)
    if (index < 0 || !this.bed.water[index]) return [WATER_LEVEL, 0, 0, 0] as const
    let [height, dx, dz, speed] = sampleWindField(x, z, time, wind, footprint)
    const latest = this.disturbances.at(-1)
    if (!latest || time - latest.born > 2.5) return boundedSample(height, dx, dz, speed)
    let shoreFade: number | undefined
    for (const disturbance of this.disturbances) {
      const age = time - disturbance.born
      if (age < 0 || age > 2.5) continue
      const ox = x - disturbance.x,
        oz = z - disturbance.z
      const front = age * 2.4
      const width = disturbance.radius + age * 0.28
      const reach = front + width * 3
      if (Math.abs(ox) > reach || Math.abs(oz) > reach) continue
      const distance = Math.hypot(ox, oz)
      const offset = distance - front
      if (Math.abs(offset) > width * 3) continue
      shoreFade ??= Math.min(1, Math.max(0, sampleShore(this.bed, x, z)) / 0.6)
      const packet = Math.exp((-offset * offset) / (width * width))
      const amplitude = disturbance.velocity * 0.035 * Math.exp(-age * 1.4) * shoreFade
      const contribution = amplitude * packet
      height += contribution
      const radial = (-2 * offset * contribution) / (width * width * Math.max(distance, 0.001))
      dx += radial * ox
      dz += radial * oz
      speed += contribution * ((4.8 * offset) / (width * width) - 1.4)
    }
    return boundedSample(height, dx, dz, speed)
  }

  clear() {
    this.disturbances.length = 0
  }
}

import { WATER_LEVEL, lakeIndex, LAKE_BOUNDS } from './lake-bed'
import type { LakeBed } from './lake-bed'

export type FishSchool = Readonly<{
  x: number
  z: number
  radiusX: number
  radiusZ: number
  phase: number
  period: number
}>

function clearPatch(bed: LakeBed, x: number, z: number) {
  // Formation, individual avoidance and the small body all fit this envelope.
  // 1.05 formation + 0.035 sway + 0.2 avoidance + 0.5 body radius.
  const margin = 1.8
  const first = lakeIndex(bed, x - margin, z - margin)
  const last = lakeIndex(bed, x + margin, z + margin)
  if (first < 0 || last < 0) return false
  for (
    let row = Math.floor(first / bed.resolution);
    row <= Math.floor(last / bed.resolution);
    row++
  ) {
    for (let column = first % bed.resolution; column <= last % bed.resolution; column++) {
      const i = row * bed.resolution + column
      if (!bed.water[i] || bed.depth[i]! < 1.65 || bed.obstacle[i]! > WATER_LEVEL - 0.65)
        return false
    }
  }
  return true
}

/** Validate a whole cruising corridor, not just a spawning point. Long routes
 * let shoals recede into the reflective distance rather than pop into existence. */
export function createFishSchools(
  bed: LakeBed,
  anchors: readonly Readonly<{ x: number; z: number }>[],
  seed: number,
  count: number,
) {
  const schools: FishSchool[] = []
  for (const anchor of anchors) {
    if (schools.length >= count) break
    if (
      schools.some(
        (school) => Math.hypot(school.x - anchor.x, school.z + school.radiusZ - anchor.z) < 4.5,
      )
    )
      continue
    for (const radiusZ of [9, 6, 4, 2, 1, 0.5, 0.2]) {
      const radiusX = Math.min(1.6, radiusZ * 0.4)
      const z = anchor.z - radiusZ
      let safe = true
      const steps = Math.ceil((2 * Math.PI * radiusZ) / ((LAKE_BOUNDS.size / bed.resolution) * 0.5))
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2
        if (!clearPatch(bed, anchor.x + Math.sin(angle) * radiusX, z + Math.cos(angle) * radiusZ)) {
          safe = false
          break
        }
      }
      if (!safe) continue
      schools.push({
        x: anchor.x,
        z,
        radiusX,
        radiusZ,
        phase: (schools.length / count) * Math.PI * 2,
        period: 46 + ((seed >>> 0) % 13),
      })
      break
    }
  }
  return schools
}

/** Shared travel with staggered turns and a loose, non-grid formation. */
export function sampleSchoolFish(
  school: FishSchool,
  index: number,
  time: number,
  target: { x: number; z: number; heading: number },
) {
  const golden = index * 2.39996323
  const radius = Math.sqrt(((index % 9) + 0.5) / 9) * 1.05
  const lag = (0.5 + 0.5 * Math.sin(golden)) * 1.3
  const angle = ((time - lag) / school.period) * Math.PI * 2 + school.phase
  const dx = school.radiusX * Math.cos(angle)
  const dz = -school.radiusZ * Math.sin(angle)
  const length = Math.hypot(dx, dz)
  const side = Math.cos(golden) * radius + Math.sin(time * 0.7 + golden) * 0.035
  const along = Math.sin(golden) * radius
  target.x = school.x + Math.sin(angle) * school.radiusX + (dz * side + dx * along) / length
  target.z = school.z + Math.cos(angle) * school.radiusZ + (-dx * side + dz * along) / length
  target.heading = Math.atan2(dx, dz) + Math.sin(time * 0.9 + golden) * 0.045
  return target
}

import { WATER_LEVEL, lakeIndex, LAKE_BOUNDS } from './lake-bed'
import type { LakeBed } from './lake-bed'

export type FishSchool = Readonly<{
  x: number
  z: number
  radiusX: number
  radiusZ: number
  phase: number
  period: number
  direction: 1 | -1
}>

function clearPatch(bed: LakeBed, x: number, z: number) {
  // Formation, individual avoidance and the small body all fit this envelope.
  // 0.8 formation + 0.035 sway + 0.2 avoidance + 0.5 body radius.
  const margin = 1.6
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
        // Independent cadences let arrivals overlap and drift apart. The first
        // group opens in the foreground; the others begin along their routes.
        phase: schools.length === 0 ? 0 : schools.length * 1.7 + ((seed >>> 0) % 7) * 0.08,
        period: 38 + (((seed >>> 0) + schools.length * 17) % 25),
        direction: schools.length % 2 === 0 ? 1 : -1,
      })
      break
    }
  }
  return schools
}

/** Long, overlapping passages with a smooth disappearance on the distant half. */
export function schoolVisibility(school: FishSchool, time: number) {
  const angle = (time / school.period) * Math.PI * 2 * school.direction + school.phase
  const amount = Math.max(0, Math.min(1, (Math.cos(angle) + 0.25) / 0.9))
  return amount * amount * (3 - 2 * amount)
}

/** Shared travel with staggered turns and a loose, non-grid formation. */
export function sampleSchoolFish(
  school: FishSchool,
  index: number,
  time: number,
  target: { x: number; z: number; heading: number },
) {
  const golden = index * 2.39996323
  const radius = Math.sqrt(((index % 9) + 0.5) / 9) * 0.8
  const lag = (0.5 + 0.5 * Math.sin(golden)) * 1.3
  const angle = ((time - lag) / school.period) * Math.PI * 2 * school.direction + school.phase
  const dx = school.radiusX * Math.cos(angle) * school.direction
  const dz = -school.radiusZ * Math.sin(angle) * school.direction
  const length = Math.hypot(dx, dz)
  // Individuals loosen/tighten the formation on independent slow cadences,
  // remaining inside the validated swimming corridor throughout the passage.
  const spread = 0.88 + Math.sin(time * 0.43 + golden * 1.3) * 0.12
  const angleOffset = Math.sin(time * 0.31 + golden) * 0.16
  const side = Math.cos(golden + angleOffset) * radius * spread
  const along = Math.sin(golden + angleOffset) * radius * spread
  target.x = school.x + Math.sin(angle) * school.radiusX + (dz * side + dx * along) / length
  target.z = school.z + Math.cos(angle) * school.radiusZ + (-dx * side + dz * along) / length
  target.heading = Math.atan2(dx, dz) + Math.sin(time * 0.9 + golden) * 0.045
  return target
}

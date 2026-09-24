import { describe, expect, it } from 'vitest'

import { createFishSchools, sampleSchoolFish, schoolVisibility } from './fish-school'
import type { LakeBed } from './lake-bed'

const bed: LakeBed = {
  resolution: 64,
  water: new Uint8Array(64 * 64).fill(255),
  depth: new Float32Array(64 * 64).fill(3),
  obstacle: new Float32Array(64 * 64).fill(-3),
  shore: new Float32Array(128 * 128).fill(10),
  stones: [],
}

describe('small fish shoals', () => {
  it('varies the number of overlapping schools with smooth arrivals and departures', () => {
    const schools = createFishSchools(
      bed,
      [-12, -4, 4, 12].map((x) => ({ x, z: 2 })),
      42,
      4,
    )
    expect(schools).toHaveLength(4)
    expect(new Set(schools.map((school) => school.period)).size).toBe(4)
    expect(new Set(schools.map((school) => school.direction)).size).toBe(2)
    const counts = new Set<number>()
    const ranges = schools.map(() => ({ min: 1, max: 0 }))
    for (let time = 0; time <= 180; time += 0.25) {
      counts.add(schools.filter((school) => schoolVisibility(school, time) > 0.35).length)
      for (const [index, school] of schools.entries()) {
        const visible = schoolVisibility(school, time)
        ranges[index]!.min = Math.min(ranges[index]!.min, visible)
        ranges[index]!.max = Math.max(ranges[index]!.max, visible)
        expect(Math.abs(visible - schoolVisibility(school, time + 1 / 30))).toBeLessThan(0.01)
      }
    }
    expect(counts.has(1)).toBe(true)
    expect(counts.has(2)).toBe(true)
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(3)
    expect(ranges.every(({ min, max }) => min === 0 && max === 1)).toBe(true)
  })

  it('builds repeatable long paths and rejects dry corridors', () => {
    const anchors = [
      { x: -4, z: 2 },
      { x: 4, z: 1 },
    ]
    const schools = createFishSchools(bed, anchors, 42, 2)
    expect(schools).toHaveLength(2)
    expect(schools.every((school) => school.radiusZ === 9)).toBe(true)
    expect(schools).toEqual(createFishSchools(bed, anchors, 42, 2))
    expect(createFishSchools({ ...bed, water: new Uint8Array(4096) }, anchors, 42, 2)).toEqual([])
    expect(
      createFishSchools({ ...bed, depth: new Float32Array(4096).fill(1.5) }, anchors, 42, 2),
    ).toEqual([])
  })

  it('keeps the group cohesive, with staggered positions and aligned headings', () => {
    const school = createFishSchools(bed, [{ x: 0, z: 2 }], 0, 1)[0]!
    for (let time = 0; time < school.period * 2; time += 0.5) {
      const poses = Array.from({ length: 9 }, (_, i) =>
        sampleSchoolFish(school, i, time, { x: 0, z: 0, heading: 0 }),
      )
      for (const pose of poses) {
        expect(Math.hypot(pose.x - poses[0]!.x, pose.z - poses[0]!.z)).toBeLessThan(3.5)
        expect(Math.cos(pose.heading - poses[0]!.heading)).toBeGreaterThan(0.5)
      }
      expect(new Set(poses.map((pose) => `${pose.x},${pose.z}`)).size).toBe(9)
    }
    const start = sampleSchoolFish(school, 0, 0, { x: 0, z: 0, heading: 0 })
    const far = sampleSchoolFish(school, 0, school.period / 2, { x: 0, z: 0, heading: 0 })
    expect(start.z - far.z).toBeGreaterThan(15)
  })
})

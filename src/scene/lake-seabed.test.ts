import { describe, expect, it } from 'vitest'

import { WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import {
  HERO_ROCK_COUNT,
  meadowField,
  placeHeroRocks,
  placeSeabedRocks,
  placeSeagrass,
  SEABED_CAPTURE,
  SEAGRASS_DEPTH,
} from './lake-seabed'

function sampleBed(): LakeBed {
  const resolution = 8
  return {
    resolution,
    water: new Uint8Array(resolution ** 2).fill(255),
    depth: new Float32Array(resolution ** 2).fill(1.5),
    obstacle: new Float32Array(resolution ** 2),
    shore: new Float32Array((resolution * 2) ** 2),
    stones: [
      { x: 0, y: WATER_LEVEL - 1, z: -10, size: 0.2, color: 0x566166 },
      { x: 5, y: WATER_LEVEL - 1.2, z: 0, size: 0.3, color: 0x566166 },
      { x: 60, y: WATER_LEVEL - 1, z: -10, size: 0.2, color: 0x566166 },
    ],
  }
}

describe('seabed placement', () => {
  it('keeps capture-box rocks deterministic, capped and below the surface', () => {
    const bed = sampleBed()
    const rocks = placeSeabedRocks(bed, 12)
    expect(rocks).toEqual(placeSeabedRocks(bed, 12))
    expect(rocks).toHaveLength(2)
    expect(placeSeabedRocks(bed, 12, 1)).toHaveLength(1)
    for (const rock of rocks) {
      expect(rock.x).toBeGreaterThanOrEqual(SEABED_CAPTURE.minX)
      expect(rock.x).toBeLessThanOrEqual(SEABED_CAPTURE.maxX)
      expect(rock.z).toBeGreaterThanOrEqual(SEABED_CAPTURE.minZ)
      expect(rock.z).toBeLessThanOrEqual(SEABED_CAPTURE.maxZ)
      expect(rock.y + rock.scale * 0.5).toBeLessThan(WATER_LEVEL)
      expect(rock.rotY).toBeGreaterThanOrEqual(0)
      expect(rock.rotY).toBeLessThan(Math.PI * 2)
      expect(rock.squash).toBeGreaterThanOrEqual(0.55)
      expect(rock.squash).toBeLessThanOrEqual(0.9)
    }
    expect(placeSeabedRocks(bed, 13)).not.toEqual(rocks)
  })

  it('grows seagrass tufts in the depth band with submerged tips', () => {
    const bed = sampleBed()
    const blades = placeSeagrass(bed, 12)
    expect(blades.length).toBeGreaterThan(0)
    expect(blades).toEqual(placeSeagrass(bed, 12))
    expect(placeSeagrass(bed, 12, 3)).toHaveLength(3)
    for (const blade of blades) {
      expect(blade.x).toBeGreaterThanOrEqual(SEABED_CAPTURE.minX - 0.5)
      expect(blade.x).toBeLessThanOrEqual(SEABED_CAPTURE.maxX + 0.5)
      const depth = WATER_LEVEL - blade.y
      expect(depth).toBeGreaterThanOrEqual(SEAGRASS_DEPTH.min)
      expect(depth).toBeLessThanOrEqual(SEAGRASS_DEPTH.max)
      expect(blade.y + blade.height).toBeLessThan(WATER_LEVEL)
      expect(blade.height).toBeGreaterThanOrEqual(0.3)
      expect(blade.height).toBeLessThanOrEqual(0.6)
    }
    expect(placeSeagrass(bed, 13)).not.toEqual(blades)
  })

  it('grows blades on the visible meadow field', () => {
    for (const blade of placeSeagrass(sampleBed(), 12))
      expect(meadowField(blade.x, blade.z, 12)).toBeGreaterThan(0.3)
  })

  it('scatters separated hero rocks inside the depth band', () => {
    const bed = sampleBed()
    const heroes = placeHeroRocks(bed, 12)
    expect(heroes).toEqual(placeHeroRocks(bed, 12))
    expect(heroes.length).toBeGreaterThan(0)
    expect(heroes.length).toBeLessThanOrEqual(HERO_ROCK_COUNT)
    for (const [i, hero] of heroes.entries()) {
      expect(hero.scale).toBeGreaterThanOrEqual(0.5)
      expect(hero.scale).toBeLessThanOrEqual(1.4)
      expect(hero.y + hero.scale * 0.6).toBeLessThan(WATER_LEVEL)
      for (const other of heroes.slice(i + 1))
        expect(Math.hypot(hero.x - other.x, hero.z - other.z)).toBeGreaterThanOrEqual(4)
    }
  })
})

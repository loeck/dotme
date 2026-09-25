import { required } from '../invariant'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'

export const SEABED_CAPTURE = { minX: -29, maxX: 29, minZ: -52, maxZ: 24 } as const
export const SEAGRASS_DEPTH = { min: 0.8, max: 2.6 } as const
export const MAX_SEABED_ROCKS = 320
export const MAX_SEAGRASS_BLADES = 1200
export const HERO_ROCK_COUNT = 22
export const HERO_ROCK_DEPTH = { min: 1.2, max: 3.2 } as const

export type SeabedRock = Readonly<{
  x: number
  y: number
  z: number
  scale: number
  rotY: number
  squash: number
}>

export type SeagrassBlade = Readonly<{
  x: number
  y: number
  z: number
  height: number
  rotY: number
  tilt: number
  phase: number
}>

export function seabedHash(value: number) {
  let n = Math.imul(value | 0, 0x85ebca6b)
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35)
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000
}

export function meadowOffset(seed: number): readonly [number, number] {
  return [((seed % 1024) * 0.173) % 64, ((seed % 1024) * 0.311) % 64]
}

const latticeHash = (cx: number, cz: number) => {
  const s = Math.sin(cx * 127.1 + cz * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** CPU mirror of the shader value noise so blades grow on the visible meadows. */
export function meadowField(x: number, z: number, seed: number) {
  const [ox, oz] = meadowOffset(seed)
  const px = x * 0.15 + ox,
    pz = z * 0.15 + oz
  const ix = Math.floor(px),
    iz = Math.floor(pz)
  const fx = px - ix,
    fz = pz - iz
  const sx = fx * fx * (3 - 2 * fx),
    sz = fz * fz * (3 - 2 * fz)
  const a = latticeHash(ix, iz),
    b = latticeHash(ix + 1, iz),
    c = latticeHash(ix, iz + 1),
    d = latticeHash(ix + 1, iz + 1)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}

export function placeSeabedRocks(
  bed: LakeBed,
  seed: number,
  maxCount = MAX_SEABED_ROCKS,
): SeabedRock[] {
  const candidates: { order: number; rock: SeabedRock }[] = []
  for (const [index, stone] of bed.stones.entries()) {
    if (
      stone.x < SEABED_CAPTURE.minX ||
      stone.x > SEABED_CAPTURE.maxX ||
      stone.z < SEABED_CAPTURE.minZ ||
      stone.z > SEABED_CAPTURE.maxZ
    )
      continue
    const key = Math.imul(index + 1, 0x9e3779b9) ^ seed
    candidates.push({
      order: seabedHash(key ^ 0x2f6b),
      rock: {
        x: stone.x,
        y: stone.y,
        z: stone.z,
        scale: stone.size,
        rotY: seabedHash(key) * Math.PI * 2,
        squash: 0.55 + seabedHash(key ^ 0x51ed) * 0.35,
      },
    })
  }
  candidates.sort((a, b) => a.order - b.order)
  return candidates.slice(0, maxCount).map((candidate) => candidate.rock)
}

export function placeHeroRocks(bed: LakeBed, seed: number, count = HERO_ROCK_COUNT): SeabedRock[] {
  const candidates: { order: number; x: number; z: number; depth: number }[] = []
  const n = bed.resolution
  const cell = LAKE_BOUNDS.size / n
  const stride = Math.max(1, Math.round(2 / cell))
  for (let gz = 0; gz < n; gz += stride) {
    for (let gx = 0; gx < n; gx += stride) {
      const x = LAKE_BOUNDS.minX + (gx + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (gz + 0.5) * cell
      if (
        x < SEABED_CAPTURE.minX + 2 ||
        x > SEABED_CAPTURE.maxX - 2 ||
        z < SEABED_CAPTURE.minZ + 2 ||
        z > SEABED_CAPTURE.maxZ - 2
      )
        continue
      const at = lakeIndex(bed, x, z)
      if (at < 0 || !required(bed.water[at])) continue
      const depth = required(bed.depth[at])
      if (depth < HERO_ROCK_DEPTH.min || depth > HERO_ROCK_DEPTH.max) continue
      candidates.push({
        order: seabedHash(Math.imul(gz * n + gx + 1, 0x9e3779b9) ^ seed),
        x,
        z,
        depth,
      })
    }
  }
  candidates.sort((a, b) => a.order - b.order)
  const heroes: SeabedRock[] = []
  for (const candidate of candidates) {
    if (heroes.length >= count) break
    if (heroes.some((hero) => Math.hypot(hero.x - candidate.x, hero.z - candidate.z) < 4)) continue
    const key = Math.imul(heroes.length * 131 + 7, 0xc2b2ae35) ^ seed
    const scale = 0.5 + seabedHash(key) * 0.9
    heroes.push({
      x: candidate.x,
      y: WATER_LEVEL - candidate.depth + scale * 0.15,
      z: candidate.z,
      scale,
      rotY: seabedHash(key ^ 0x51ed) * Math.PI * 2,
      squash: 0.55 + seabedHash(key ^ 0x2f6b) * 0.35,
    })
  }
  return heroes
}

export function placeSeagrass(
  bed: LakeBed,
  seed: number,
  maxBlades = MAX_SEAGRASS_BLADES,
): SeagrassBlade[] {
  const candidates: { order: number; blade: SeagrassBlade }[] = []
  const n = bed.resolution
  const cell = LAKE_BOUNDS.size / n
  const stride = Math.max(1, Math.round(0.95 / cell))
  let tuft = 0
  for (let gz = 0; gz < n; gz += stride) {
    for (let gx = 0; gx < n; gx += stride) {
      const x = LAKE_BOUNDS.minX + (gx + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (gz + 0.5) * cell
      if (
        x < SEABED_CAPTURE.minX ||
        x > SEABED_CAPTURE.maxX ||
        z < SEABED_CAPTURE.minZ ||
        z > SEABED_CAPTURE.maxZ
      )
        continue
      tuft++
      if (meadowField(x, z, seed) < 0.38 || seabedHash(Math.imul(tuft, 0x9e3779b9) ^ seed) > 0.5)
        continue
      const count = 5 + Math.floor(seabedHash(Math.imul(tuft, 0x85ebca6b) ^ seed) * 4)
      for (let b = 0; b < count; b++) {
        const key = Math.imul(tuft * 8 + b + 1, 0xc2b2ae35) ^ seed
        const angle = seabedHash(key) * Math.PI * 2
        const radius = seabedHash(key ^ 0x27d4) * 0.3
        const bx = x + Math.cos(angle) * radius
        const bz = z + Math.sin(angle) * radius
        const at = lakeIndex(bed, bx, bz)
        if (at < 0 || !required(bed.water[at])) continue
        const depth = required(bed.depth[at])
        if (depth < SEAGRASS_DEPTH.min || depth > SEAGRASS_DEPTH.max) continue
        candidates.push({
          order: seabedHash(key ^ 0x3d1b),
          blade: {
            x: bx,
            y: WATER_LEVEL - depth,
            z: bz,
            height: 0.3 + seabedHash(key ^ 0x165667) * 0.3,
            rotY: seabedHash(key ^ 0x85eb) * Math.PI * 2,
            tilt: (seabedHash(key ^ 0xb529) - 0.5) * 0.35,
            phase: seabedHash(key ^ 0x9e37) * Math.PI * 2,
          },
        })
      }
    }
  }
  candidates.sort((a, b) => a.order - b.order)
  return candidates.slice(0, maxBlades).map((candidate) => candidate.blade)
}

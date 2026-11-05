import { required } from '../invariant'
import type { Voxel } from './voxel-spatial'

export const LAKE_BOUNDS = { minX: -80, minZ: -112, size: 160 } as const
export const WATER_LEVEL = -0.035

/** Cells per side of the lake's rasters. */
export const lakeResolution = (mobile: boolean) => (mobile ? 256 : 512)

export type LakeBed = Readonly<{
  resolution: number
  water: Uint8Array
  depth: Float32Array
  /** Highest solid surface, including trees, for conservative visibility tests. */
  obstacle: Float32Array
  /** Signed distance to actual terrain footprints, at twice the bed resolution. */
  shore: Float32Array
  stones: readonly Voxel[]
}>

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function lakeIndex(bed: Pick<LakeBed, 'resolution'>, x: number, z: number) {
  const u = (x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size
  const v = (z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1
  return Math.floor(v * bed.resolution) * bed.resolution + Math.floor(u * bed.resolution)
}

/** Bilinear signed distance to terrain footprints; positive over open water. */
export function sampleShore(bed: LakeBed, x: number, z: number) {
  const n = Math.round(Math.sqrt(bed.shore.length))
  const cell = LAKE_BOUNDS.size / n
  const u = (x - LAKE_BOUNDS.minX) / cell - 0.5
  const v = (z - LAKE_BOUNDS.minZ) / cell - 0.5
  const col = Math.max(0, Math.min(n - 2, Math.floor(u))),
    row = Math.max(0, Math.min(n - 2, Math.floor(v)))
  const fx = Math.max(0, Math.min(1, u - col)),
    fz = Math.max(0, Math.min(1, v - row))
  const i = row * n + col,
    field = bed.shore
  return (
    (required(field[i]) * (1 - fx) + required(field[i + 1]) * fx) * (1 - fz) +
    (required(field[i + n]) * (1 - fx) + required(field[i + n + 1]) * fx) * fz
  )
}

/** Footprint raster of box solids only: the water mask and obstacle tops. */
export type LakeFootprint = Pick<LakeBed, 'resolution' | 'water' | 'obstacle'>

/** Terrain columns continue down to the bed; trees raise obstacles but do not become barriers. */
export function createLakeFootprint(
  voxels: readonly Voxel[],
  mobile: boolean,
  terrainCount = voxels.length,
): LakeFootprint {
  const resolution = lakeResolution(mobile)
  const count = resolution * resolution
  const cell = LAKE_BOUNDS.size / resolution
  const water = new Uint8Array(count).fill(255)
  const obstacle = new Float32Array(count).fill(-100)
  for (let voxelIndex = 0; voxelIndex < voxels.length; voxelIndex++) {
    const voxel = required(voxels[voxelIndex])
    const half = voxel.size / 2
    const top = voxel.y + half
    const terrain = voxelIndex < terrainCount
    const x0 = Math.max(0, Math.floor((voxel.x - half - LAKE_BOUNDS.minX) / cell))
    const x1 = Math.min(resolution - 1, Math.floor((voxel.x + half - LAKE_BOUNDS.minX) / cell))
    const z0 = Math.max(0, Math.floor((voxel.z - half - LAKE_BOUNDS.minZ) / cell))
    const z1 = Math.min(resolution - 1, Math.floor((voxel.z + half - LAKE_BOUNDS.minZ) / cell))
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const i = z * resolution + x
        obstacle[i] = Math.max(obstacle[i] ?? -100, top)
        if (terrain) water[i] = 0
      }
  }
  return { resolution, water, obstacle }
}

/**
 * Signed distance to terrain footprints above the water line. Exact rectangle
 * distances keep the contact attached to voxel faces; the coarser conservative
 * picking raster would leave a visible gap. Each cell keeps the minimum over all
 * footprints, so the result is independent of voxel order.
 */
function rasterizeShore(
  voxels: readonly Voxel[],
  terrainCount: number,
  shoreResolution: number,
  shoreCell: number,
) {
  const shore = new Float32Array(shoreResolution ** 2).fill(2)
  const centerX = new Float64Array(shoreResolution)
  const centerZ = new Float64Array(shoreResolution)
  for (let n = 0; n < shoreResolution; n++) {
    centerX[n] = LAKE_BOUNDS.minX + (n + 0.5) * shoreCell
    centerZ[n] = LAKE_BOUNDS.minZ + (n + 0.5) * shoreCell
  }
  for (let voxelIndex = 0; voxelIndex < terrainCount && voxelIndex < voxels.length; voxelIndex++) {
    const voxel = required(voxels[voxelIndex])
    if (voxel.y + voxel.size / 2 < WATER_LEVEL) continue
    const half = voxel.size / 2
    const reach = half + 1.2
    const sx0 = Math.max(0, Math.floor((voxel.x - reach - LAKE_BOUNDS.minX) / shoreCell))
    const sx1 = Math.min(
      shoreResolution - 1,
      Math.ceil((voxel.x + reach - LAKE_BOUNDS.minX) / shoreCell),
    )
    const sz0 = Math.max(0, Math.floor((voxel.z - reach - LAKE_BOUNDS.minZ) / shoreCell))
    const sz1 = Math.min(
      shoreResolution - 1,
      Math.ceil((voxel.z + reach - LAKE_BOUNDS.minZ) / shoreCell),
    )
    for (let z = sz0; z <= sz1; z++) {
      const dz = Math.abs((centerZ[z] ?? 0) - voxel.z) - half
      const row = z * shoreResolution
      for (let x = sx0; x <= sx1; x++) {
        const dx = Math.abs((centerX[x] ?? 0) - voxel.x) - half
        const i = row + x
        const bound = Math.max(dx, dz)
        const stored = shore[i] ?? 2
        // A rectangle's signed distance is at least max(dx, dz). A closer
        // footprint already stored here makes the square root unnecessary.
        if (stored <= bound) continue
        // hypot(max(dx, 0), max(dz, 0)) + min(max(dx, dz), 0), without the
        // square root when the cell lies beside or inside the footprint.
        const signed = dx > 0 ? (dz > 0 ? Math.hypot(dx, dz) : dx) : dz > 0 ? dz : bound
        if (signed < stored) shore[i] = signed
      }
    }
  }
  return shore
}

/** Chamfer distance to the rendered shore, in world units (two linear sweeps). */
function chamferDistance(water: Uint8Array, resolution: number, cell: number) {
  const count = resolution * resolution
  const distance = new Float32Array(count)
  for (let i = 0; i < count; i++) distance[i] = water[i] === 0 ? 0 : LAKE_BOUNDS.size
  const diagonal = cell * Math.SQRT2
  const last = resolution - 1
  // Each cell takes the minimum over already swept neighbours; storing that
  // minimum once rounds exactly as storing it after every neighbour.
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const i = z * resolution + x
      let d = distance[i] ?? 0
      if (x > 0) d = Math.min(d, (distance[i - 1] ?? 0) + cell)
      if (z > 0) {
        const above = i - resolution
        d = Math.min(d, (distance[above] ?? 0) + cell)
        if (x > 0) d = Math.min(d, (distance[above - 1] ?? 0) + diagonal)
        if (x < last) d = Math.min(d, (distance[above + 1] ?? 0) + diagonal)
      }
      distance[i] = d
    }
  for (let z = last; z >= 0; z--)
    for (let x = last; x >= 0; x--) {
      const i = z * resolution + x
      let d = distance[i] ?? 0
      if (x < last) d = Math.min(d, (distance[i + 1] ?? 0) + cell)
      if (z < last) {
        const below = i + resolution
        d = Math.min(d, (distance[below] ?? 0) + cell)
        if (x < last) d = Math.min(d, (distance[below + 1] ?? 0) + diagonal)
        if (x > 0) d = Math.min(d, (distance[below - 1] ?? 0) + diagonal)
      }
      distance[i] = d
    }
  return distance
}

/**
 * A lake around box solids (simple scenes and fixtures): rasterize their footprints, then
 * connect submerged relief to those shores. The generated world uses `createLakeBedFromTerrain`.
 */
export function createLakeBed(
  voxels: readonly Voxel[],
  seed: number,
  mobile: boolean,
  terrainCount = voxels.length,
): LakeBed {
  const { resolution, water, obstacle } = createLakeFootprint(voxels, mobile, terrainCount)
  const count = resolution * resolution
  const cell = LAKE_BOUNDS.size / resolution
  const shore = rasterizeShore(voxels, terrainCount, resolution * 2, cell / 2)
  const distance = chamferDistance(water, resolution, cell)
  const depth = new Float32Array(count)
  const stones: Voxel[] = []
  const noise = (i: number) => {
    let n = Math.imul(i ^ seed, 0x45d9f3b)
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
    return ((n ^ (n >>> 16)) >>> 0) / 0x100000000
  }
  for (let i = 0; i < count; i++) {
    const x = LAKE_BOUNDS.minX + ((i % resolution) + 0.5) * cell
    const z = LAKE_BOUNDS.minZ + (Math.floor(i / resolution) + 0.5) * cell
    const relief = 0.85 + 0.15 * Math.sin(x * 0.8 + (seed % 17)) * Math.cos(z * 0.65)
    const base = water[i] ? Math.min(7.5, 0.12 + required(distance[i]) * 0.42 * relief) : 0
    const duneBand = smooth01(0.6, 1.3, base) * (1 - smooth01(3.8, 5.2, base))
    const dunePhase = x * 2.2 + z * 1.4 + 1.6 * Math.sin(x * 0.5 - z * 0.7 + (seed % 32) * 0.61)
    depth[i] = water[i] ? base + 0.18 * Math.sin(dunePhase) * duneBand : 0
    if (water[i] && required(depth[i]) < 2.8 && noise(i) > 0.985) {
      const size = 0.09 + noise(i + count) * Math.min(0.3, required(depth[i]))
      stones.push({
        x,
        z,
        y: WATER_LEVEL - required(depth[i]) + size * 0.25,
        size,
        color: 0x566166,
      })
    }
  }
  return { resolution, water, depth, obstacle, shore, stones }
}

/** Ground height and boulder solids, enough to derive the lake from a smooth terrain. */
export type LakeTerrain = Readonly<{
  height: (x: number, z: number) => number
  /**
   * Boulders: `radius` is their waterline circle (zero when they do not cross the water),
   * `footprint` their widest horizontal extent and `top` their highest point.
   */
  boulders: readonly Readonly<{
    x: number
    z: number
    radius: number
    footprint: number
    top: number
  }>[]
}>

/**
 * The lake from a continuous terrain: water wherever the ground lies under the water line, a
 * signed shore distance refined to the actual contour (linear crossing between samples, then
 * propagated by chamfer sweeps), and the same shelving bed, dunes and stones as `createLakeBed`.
 */
export function createLakeBedFromTerrain(
  terrain: LakeTerrain,
  seed: number,
  mobile: boolean,
): LakeBed {
  const resolution = lakeResolution(mobile)
  const count = resolution * resolution
  const cell = LAKE_BOUNDS.size / resolution
  const shoreResolution = resolution * 2
  const shoreCell = cell / 2
  // Signed height above the water line, boulders included, at shore resolution.
  const level = new Float32Array(shoreResolution ** 2)
  for (let row = 0; row < shoreResolution; row++)
    for (let column = 0; column < shoreResolution; column++) {
      const x = LAKE_BOUNDS.minX + (column + 0.5) * shoreCell
      const z = LAKE_BOUNDS.minZ + (row + 0.5) * shoreCell
      level[row * shoreResolution + column] = terrain.height(x, z) - WATER_LEVEL
    }
  // The highest solid per sample: the ground, or a boulder's top over its footprint.
  const solid = new Float32Array(level.length)
  for (let i = 0; i < level.length; i++) solid[i] = (level[i] ?? 0) + WATER_LEVEL
  for (const boulder of terrain.boulders) {
    const reach = boulder.footprint
    const c0 = Math.max(0, Math.floor((boulder.x - reach - LAKE_BOUNDS.minX) / shoreCell))
    const c1 = Math.min(
      shoreResolution - 1,
      Math.ceil((boulder.x + reach - LAKE_BOUNDS.minX) / shoreCell),
    )
    const r0 = Math.max(0, Math.floor((boulder.z - reach - LAKE_BOUNDS.minZ) / shoreCell))
    const r1 = Math.min(
      shoreResolution - 1,
      Math.ceil((boulder.z + reach - LAKE_BOUNDS.minZ) / shoreCell),
    )
    for (let row = r0; row <= r1; row++)
      for (let column = c0; column <= c1; column++) {
        const x = LAKE_BOUNDS.minX + (column + 0.5) * shoreCell
        const z = LAKE_BOUNDS.minZ + (row + 0.5) * shoreCell
        if (Math.hypot(x - boulder.x, z - boulder.z) > reach) continue
        const i = row * shoreResolution + column
        solid[i] = Math.max(solid[i] ?? -100, boulder.top)
      }
  }
  for (const boulder of terrain.boulders) {
    if (boulder.top <= WATER_LEVEL || boulder.radius <= 0) continue
    const reach = boulder.radius + shoreCell
    const c0 = Math.max(0, Math.floor((boulder.x - reach - LAKE_BOUNDS.minX) / shoreCell))
    const c1 = Math.min(
      shoreResolution - 1,
      Math.ceil((boulder.x + reach - LAKE_BOUNDS.minX) / shoreCell),
    )
    const r0 = Math.max(0, Math.floor((boulder.z - reach - LAKE_BOUNDS.minZ) / shoreCell))
    const r1 = Math.min(
      shoreResolution - 1,
      Math.ceil((boulder.z + reach - LAKE_BOUNDS.minZ) / shoreCell),
    )
    for (let row = r0; row <= r1; row++)
      for (let column = c0; column <= c1; column++) {
        const x = LAKE_BOUNDS.minX + (column + 0.5) * shoreCell
        const z = LAKE_BOUNDS.minZ + (row + 0.5) * shoreCell
        // A cone-shaped proxy: zero on the boulder's waterline circle.
        const inside = boulder.radius - Math.hypot(x - boulder.x, z - boulder.z)
        const i = row * shoreResolution + column
        level[i] = Math.max(level[i] ?? -1, inside)
      }
  }
  // Distance seeds at the contour: a sample next to a sign change gets its linear distance.
  const n = shoreResolution
  const shoreDistance = new Float32Array(n * n).fill(LAKE_BOUNDS.size)
  for (let row = 0; row < n; row++)
    for (let column = 0; column < n; column++) {
      const i = row * n + column
      const here = level[i] ?? -1
      let best: number = LAKE_BOUNDS.size
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const r = row + dr,
          c = column + dc
        if (r < 0 || c < 0 || r >= n || c >= n) continue
        const there = level[r * n + c] ?? -1
        if (here > 0 === there > 0) continue
        best = Math.min(best, (Math.abs(here) / Math.max(Math.abs(here - there), 1e-6)) * shoreCell)
      }
      shoreDistance[i] = best
    }
  // Propagate from the seeds (two chamfer sweeps, as `chamferDistance`).
  const diagonal = shoreCell * Math.SQRT2
  for (let pass = 0; pass < 2; pass++) {
    const forward = pass === 0
    for (let k = 0; k < n; k++) {
      const row = forward ? k : n - 1 - k
      for (let j = 0; j < n; j++) {
        const column = forward ? j : n - 1 - j
        const i = row * n + column
        let d = shoreDistance[i] ?? 0
        const s = forward ? -1 : 1
        const c = column + s,
          r = row + s
        if (c >= 0 && c < n) d = Math.min(d, (shoreDistance[i + s] ?? 0) + shoreCell)
        if (r >= 0 && r < n) {
          const vertical = i + s * n
          d = Math.min(d, (shoreDistance[vertical] ?? 0) + shoreCell)
          if (column > 0) d = Math.min(d, (shoreDistance[vertical - 1] ?? 0) + diagonal)
          if (column < n - 1) d = Math.min(d, (shoreDistance[vertical + 1] ?? 0) + diagonal)
        }
        shoreDistance[i] = d
      }
    }
  }
  const shore = new Float32Array(n * n)
  for (let i = 0; i < shore.length; i++) {
    const d = Math.min(2, shoreDistance[i] ?? 2)
    shore[i] = (level[i] ?? -1) > 0 ? -d : d
  }
  // Bed rasters at bed resolution: water where every overlapping shore sample is water.
  const water = new Uint8Array(count)
  const obstacle = new Float32Array(count).fill(-100)
  for (let row = 0; row < resolution; row++)
    for (let column = 0; column < resolution; column++) {
      const i = row * resolution + column
      let open = true
      let top = -100
      for (let dr = 0; dr < 2; dr++)
        for (let dc = 0; dc < 2; dc++) {
          const j = (row * 2 + dr) * n + column * 2 + dc
          if ((level[j] ?? -1) > 0) open = false
          top = Math.max(top, solid[j] ?? -100)
        }
      water[i] = open ? 255 : 0
      obstacle[i] = top
    }
  const distance = chamferDistance(water, resolution, cell)
  const depth = new Float32Array(count)
  const stones: Voxel[] = []
  const noise = (i: number) => {
    let h = Math.imul(i ^ seed, 0x45d9f3b)
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
    return ((h ^ (h >>> 16)) >>> 0) / 0x100000000
  }
  for (let i = 0; i < count; i++) {
    const x = LAKE_BOUNDS.minX + ((i % resolution) + 0.5) * cell
    const z = LAKE_BOUNDS.minZ + (Math.floor(i / resolution) + 0.5) * cell
    const relief = 0.85 + 0.15 * Math.sin(x * 0.8 + (seed % 17)) * Math.cos(z * 0.65)
    const base = water[i] ? Math.min(7.5, 0.12 + required(distance[i]) * 0.42 * relief) : 0
    const duneBand = smooth01(0.6, 1.3, base) * (1 - smooth01(3.8, 5.2, base))
    const dunePhase = x * 2.2 + z * 1.4 + 1.6 * Math.sin(x * 0.5 - z * 0.7 + (seed % 32) * 0.61)
    depth[i] = water[i] ? base + 0.18 * Math.sin(dunePhase) * duneBand : 0
    if (water[i] && required(depth[i]) < 2.8 && noise(i) > 0.985) {
      const size = 0.09 + noise(i + count) * Math.min(0.3, required(depth[i]))
      stones.push({
        x,
        z,
        y: WATER_LEVEL - required(depth[i]) + size * 0.25,
        size,
        color: 0x566166,
      })
    }
  }
  return { resolution, water, depth, obstacle, shore, stones }
}

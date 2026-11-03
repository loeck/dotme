import { required } from '../invariant'
import type { Voxel } from './voxel-world'

export const LAKE_BOUNDS = { minX: -80, minZ: -112, size: 160 } as const
export const WATER_LEVEL = -0.035

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

/** Footprint raster only: enough to place the waterfall before the final bed exists. */
export type LakeFootprint = Pick<LakeBed, 'resolution' | 'water' | 'obstacle'>

/** Terrain columns continue down to the bed; trees raise obstacles but do not become barriers. */
export function createLakeFootprint(
  voxels: readonly Voxel[],
  mobile: boolean,
  terrainCount = voxels.length,
): LakeFootprint {
  const resolution = mobile ? 256 : 512
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

/** Rasterize actual voxel footprints, then connect submerged relief to those shores. */
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

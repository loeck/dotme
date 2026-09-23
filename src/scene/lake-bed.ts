import type { Voxel } from './voxel-world'

export const LAKE_BOUNDS = { minX: -80, minZ: -112, size: 160 } as const
export const WATER_LEVEL = -0.035

export type LakeBed = Readonly<{
  resolution: number
  water: Uint8Array
  depth: Float32Array
  /** Highest solid surface, including trees, for conservative visibility tests. */
  obstacle: Float32Array
  stones: readonly Voxel[]
}>

export function lakeIndex(bed: LakeBed, x: number, z: number) {
  const u = (x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size
  const v = (z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1
  return Math.floor(v * bed.resolution) * bed.resolution + Math.floor(u * bed.resolution)
}

/** Rasterize actual voxel footprints, then connect submerged relief to those shores. */
export function createLakeBed(
  voxels: readonly Voxel[],
  seed: number,
  mobile: boolean,
  terrainCount = voxels.length,
): LakeBed {
  const resolution = mobile ? 256 : 512
  const count = resolution * resolution
  const cell = LAKE_BOUNDS.size / resolution
  const water = new Uint8Array(count).fill(255)
  const obstacle = new Float32Array(count).fill(-100)
  const distance = new Float32Array(count).fill(LAKE_BOUNDS.size)
  for (const [voxelIndex, voxel] of voxels.entries()) {
    const x0 = Math.max(0, Math.floor((voxel.x - voxel.size / 2 - LAKE_BOUNDS.minX) / cell))
    const x1 = Math.min(
      resolution - 1,
      Math.floor((voxel.x + voxel.size / 2 - LAKE_BOUNDS.minX) / cell),
    )
    const z0 = Math.max(0, Math.floor((voxel.z - voxel.size / 2 - LAKE_BOUNDS.minZ) / cell))
    const z1 = Math.min(
      resolution - 1,
      Math.floor((voxel.z + voxel.size / 2 - LAKE_BOUNDS.minZ) / cell),
    )
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const i = z * resolution + x
        obstacle[i] = Math.max(obstacle[i]!, voxel.y + voxel.size / 2)
        // Terrain columns continue down to the bed; trees do not become water barriers.
        if (voxelIndex < terrainCount) {
          water[i] = 0
          distance[i] = 0
        }
      }
  }
  // Chamfer distance to the rendered shore, in world units (two linear sweeps).
  for (const direction of [1, -1]) {
    for (let n = 0; n < count; n++) {
      const i = direction === 1 ? n : count - n - 1
      const x = i % resolution
      const z = Math.floor(i / resolution)
      for (const [dx, dz] of [
        [-direction, 0],
        [0, -direction],
        [-direction, -direction],
        [direction, -direction],
      ]) {
        const nx = x + dx!,
          nz = z + dz!
        if (nx < 0 || nx >= resolution || nz < 0 || nz >= resolution) continue
        distance[i] = Math.min(
          distance[i]!,
          distance[nz * resolution + nx]! + cell * (dx && dz ? Math.SQRT2 : 1),
        )
      }
    }
  }
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
    depth[i] = water[i] ? Math.min(7.5, 0.12 + distance[i]! * 0.42 * relief) : 0
    if (water[i] && depth[i]! < 2.8 && noise(i) > 0.985) {
      const size = 0.09 + noise(i + count) * Math.min(0.3, depth[i]!)
      stones.push({ x, z, y: WATER_LEVEL - depth[i]! + size * 0.25, size, color: 0x566166 })
    }
  }
  return { resolution, water, depth, obstacle, stones }
}

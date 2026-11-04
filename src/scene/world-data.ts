import { createCloudNoiseData } from './cloud-noise'
import {
  prepareSubmergedSurface,
  prepareWaterSurface,
  prepareWaterMask,
} from './lake-geometry-data'
import { mergeStaticBoxes } from './static-boxes'
import { prepareVegetation } from './vegetation-placement'
import { prepareTerrain } from './voxel-mesh'
import { voxelBoxes } from './voxel-spatial'
import { createVoxelWorld } from './voxel-world'
import type { VoxelWorld } from './voxel-world'

/** Terrain meshing and its BVH, the longest half of world preparation. */
function terrainPart(world: VoxelWorld) {
  const terrain = prepareTerrain(world)
  // The renderer needs typed mesh/BVH buffers, not 60k structured-cloned objects.
  const { voxels: _voxels, ...data } = world
  return { world: data, terrain }
}

/** Lake surfaces, cloud noise and merged collision boxes from the same seeded world. */
function surfacePart(world: VoxelWorld, seed: number, mobile: boolean) {
  return {
    noise: createCloudNoiseData(seed),
    surfaces: {
      submerged: prepareSubmergedSurface(world.lakeBed),
      water: prepareWaterSurface(mobile),
      mask: prepareWaterMask(world.lakeBed),
    },
    /** `mergeStaticBoxes` of the terrain index boxes, ready for Rapier colliders. */
    staticBoxes: mergeStaticBoxes(voxelBoxes(world.voxels)),
  }
}

export type TerrainPart = ReturnType<typeof terrainPart>
export type SurfacePart = ReturnType<typeof surfacePart>
export type VegetationPart = ReturnType<typeof prepareVegetation>
/**
 * Everything the first frame needs, plus the forest, which follows on its own: the engine
 * presents the scene first and dissolves the vegetation in once it is compiled.
 */
export type PreparedWorld = TerrainPart & SurfacePart & { vegetation: Promise<VegetationPart> }
/** Worker requests; the `surfaces` worker also grows the forest afterwards. */
export const WORLD_PARTS = ['terrain', 'surfaces'] as const
export type WorldPart = (typeof WORLD_PARTS)[number]
export type WorldPartMessage =
  | { part: 'terrain'; data: TerrainPart }
  | { part: 'surfaces'; data: SurfacePart }
  | { part: 'vegetation'; data: VegetationPart }

export function prepareWorld(seed: number, mobile: boolean): PreparedWorld {
  const world = createVoxelWorld(seed, mobile)
  return {
    ...terrainPart(world),
    ...surfacePart(world, seed, mobile),
    vegetation: Promise.resolve(prepareVegetation(world, seed >>> 0, mobile)),
  }
}

/**
 * Generation is deterministic in (seed, mobile), so two workers each rebuild
 * the voxel world and derive disjoint halves of the prepared data in parallel.
 */
export function* prepareWorldParts(
  seed: number,
  mobile: boolean,
  part: WorldPart,
): Generator<WorldPartMessage> {
  const world = createVoxelWorld(seed, mobile)
  if (part === 'terrain') {
    yield { part, data: terrainPart(world) }
    return
  }
  yield { part, data: surfacePart(world, seed, mobile) }
  // The shorter half then grows the forest, after the first frame's data is on its way.
  yield { part: 'vegetation', data: prepareVegetation(world, seed >>> 0, mobile) }
}

/** Transfer ownership of every typed buffer, including bathymetry and BVH data. */
export function worldTransfers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  const visit = (child: unknown) => {
    if (ArrayBuffer.isView(child) && child.buffer instanceof ArrayBuffer) buffers.add(child.buffer)
    else if (Array.isArray(child)) for (const item of child) visit(item)
    else if (child && typeof child === 'object')
      for (const item of Object.values(child)) visit(item)
  }
  visit(value)
  return [...buffers]
}

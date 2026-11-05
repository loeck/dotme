import { createCloudNoiseData } from './cloud-noise'
import {
  prepareSubmergedSurface,
  prepareWaterSurface,
  prepareWaterMask,
} from './lake-geometry-data'
import { createLakeWorld } from './lake-world'
import type { LakeWorld } from './lake-world'
import { prepareBoulders } from './terrain-boulders'
import { prepareTerrainColliders, prepareTerrainSurface } from './terrain-surface'
import { prepareVegetation } from './vegetation-placement'

/** The smooth ground and its boulders, the longest half of world preparation. */
function terrainPart(world: LakeWorld, mobile: boolean) {
  const terrain = {
    surface: prepareTerrainSurface(world.field, world.trees, mobile),
    boulders: prepareBoulders(world.boulders, world.seed),
  }
  // The renderer needs typed mesh buffers, not the generation field.
  const { field: _field, boulders: _boulders, ...data } = world
  return { world: data, terrain }
}

/** Lake surfaces, cloud noise and the static colliders from the same seeded world. */
function surfacePart(world: LakeWorld, seed: number, mobile: boolean) {
  return {
    noise: createCloudNoiseData(seed),
    surfaces: {
      submerged: prepareSubmergedSurface(world.lakeBed),
      water: prepareWaterSurface(mobile),
      mask: prepareWaterMask(world.lakeBed),
    },
    /** Rapier heightfield and boulder hulls, ready for colliders. */
    colliders: prepareTerrainColliders(world.field, prepareBoulders(world.boulders, world.seed)),
  }
}

export type TerrainPart = ReturnType<typeof terrainPart>
export type SurfacePart = ReturnType<typeof surfacePart>
export type VegetationPart = ReturnType<typeof prepareVegetation>
/**
 * Everything the scene needs, with the forest as its own message: physics and scene
 * construction start without it, and the engine adds it before the scene compiles.
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
  const world = createLakeWorld(seed, mobile)
  return {
    ...terrainPart(world, mobile),
    ...surfacePart(world, seed, mobile),
    vegetation: Promise.resolve(prepareVegetation(world, seed >>> 0, mobile)),
  }
}

/**
 * Generation is deterministic in (seed, mobile), so two workers each rebuild
 * the lake world and derive disjoint halves of the prepared data in parallel.
 */
export function* prepareWorldParts(
  seed: number,
  mobile: boolean,
  part: WorldPart,
): Generator<WorldPartMessage> {
  const world = createLakeWorld(seed, mobile)
  if (part === 'terrain') {
    yield { part, data: terrainPart(world, mobile) }
    return
  }
  yield { part, data: surfacePart(world, seed, mobile) }
  // The shorter half then grows the forest, once the world data is on its way.
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

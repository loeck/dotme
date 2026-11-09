import { CAMERA_REST } from './camera-rig'
import { createCloudNoiseData } from './cloud-noise'
import {
  prepareSubmergedSurface,
  prepareWaterSurface,
  prepareWaterMask,
} from './lake-geometry-data'
import { createLakeWorld } from './lake-world'
import type { LakeWorld } from './lake-world'
import { prepareBoulders } from './terrain-boulders'
import type { Boulder } from './terrain-boulders'
import { prepareGorge, withGorge } from './terrain-gorge'
import { prepareTerrainColliders, prepareTerrainSurface } from './terrain-surface'
import { prepareVegetation } from './vegetation-placement'

/**
 * Boulders big enough on screen for their outline to show joints and weathering: half-width
 * over 1.3% of their distance from the camera, some 20 pixels across on a desktop frame (2.2%
 * on phones, whose budget is tighter).
 */
const bigOnScreen = (mobile: boolean) => (boulder: Boulder) =>
  Math.max(...boulder.size) /
    Math.hypot(boulder.x - CAMERA_REST.x, boulder.y - CAMERA_REST.y, boulder.z - CAMERA_REST.z) >
  (mobile ? 0.022 : 0.013)

/** The smooth ground and its boulders, the longest half of world preparation. */
function terrainPart(world: LakeWorld, mobile: boolean) {
  const terrain = {
    surface: prepareTerrainSurface(world.field, world.trees, mobile),
    // The boulders and the jointed rock face behind the waterfall share one mesh.
    boulders: withGorge(
      prepareBoulders(world.boulders, world.seed, bigOnScreen(mobile)),
      prepareGorge(world.field, world.waterfall),
    ),
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
export type PreparedWorld = TerrainPart &
  SurfacePart & {
    vegetation: Promise<VegetationPart>
    /** Settles with the forest: whether every part came from the world cache. */
    fromCache: Promise<boolean>
  }
/** Worker requests, one worker each; the forest is the longest and runs alongside the others. */
const WORLD_PARTS = ['terrain', 'surfaces', 'vegetation'] as const
export type WorldPart = (typeof WORLD_PARTS)[number]
export type WorldRequest = Readonly<{
  seed: number
  mobile: boolean
  /** A part to deliver, or `store` to prepare every part and keep it for a later visit. */
  part: WorldPart | 'store'
  /** Whether the world cache may be read. */
  cache: boolean
}>
export type WorldPartMessage =
  | { part: 'terrain'; data: TerrainPart; cached: boolean }
  | { part: 'surfaces'; data: SurfacePart; cached: boolean }
  | { part: 'vegetation'; data: VegetationPart; cached: boolean }

export function prepareWorld(seed: number, mobile: boolean): PreparedWorld {
  const world = createLakeWorld(seed, mobile)
  return {
    ...terrainPart(world, mobile),
    ...surfacePart(world, seed, mobile),
    vegetation: Promise.resolve(prepareVegetation(world, seed >>> 0, mobile)),
    fromCache: Promise.resolve(false),
  }
}

/**
 * Generation is deterministic in (seed, mobile), so each worker rebuilds the lake world and
 * derives one disjoint part of the prepared data in parallel with the others.
 */
export function prepareWorldPart(seed: number, mobile: boolean, part: WorldPart): WorldPartMessage {
  const world = createLakeWorld(seed, mobile)
  if (part === 'terrain') return { part, data: terrainPart(world, mobile), cached: false }
  if (part === 'surfaces') return { part, data: surfacePart(world, seed, mobile), cached: false }
  return { part, data: prepareVegetation(world, seed >>> 0, mobile), cached: false }
}

/** Every part from one world, for the background preparation of a later visit. */
export function prepareAllWorldParts(seed: number, mobile: boolean) {
  const world = createLakeWorld(seed, mobile)
  return {
    terrain: terrainPart(world, mobile),
    surfaces: surfacePart(world, seed, mobile),
    vegetation: prepareVegetation(world, seed >>> 0, mobile),
  }
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

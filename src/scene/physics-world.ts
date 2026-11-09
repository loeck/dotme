import type { World } from '@dimforge/rapier3d-compat'

import { required } from '../invariant'
import type { BoxIndex } from './box-index'
import { mergeStaticBoxes } from './static-boxes'
import type { TerrainColliders } from './terrain-surface'

export { mergeStaticBoxes } from './static-boxes'

export type RapierModule = typeof import('@dimforge/rapier3d-compat')

let loading: Promise<RapierModule> | undefined

async function load(): Promise<RapierModule> {
  try {
    performance.clearMarks('physics-start')
    performance.clearMarks('physics-ready')
    performance.mark('physics-start')
    const rapier = await import('@dimforge/rapier3d-compat')
    await rapier.init()
    performance.mark('physics-ready')
    return rapier
  } catch (error) {
    loading = undefined
    throw error
  }
}

/** Dynamically imported so the WASM payload stays in the deferred landscape chunk. */
export function loadPhysics(): Promise<RapierModule> {
  loading ??= load()
  return loading
}

type TracerPoint = {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Terrain membership; queries address statics only, never droplets or fish. */
const STATIC_GROUPS = (0x0001 << 16) | 0xffff
const STATIC_QUERY_GROUPS = (0x0001 << 16) | 0x0001
const GRID_NUDGE = 7.3e-5

export type PhysicsWorld = {
  readonly rapier: RapierModule
  readonly world: World
  readonly staticCount: number
  /** First solid hit fraction along a→b, or Infinity. Narrow phase by Rapier. */
  trace(a: TracerPoint, b: TracerPoint): number
  /** Ray distance in world units, or null. Replaces camera picking BVH walks. */
  castDistance(origin: TracerPoint, direction: TracerPoint, maxDistance: number): number | null
  dispose(): void
}

/**
 * One shared world: fixed terrain colliders, queries plus stepped dynamics. The scene passes
 * its smooth terrain (a heightfield and boulder hulls); box solids remain for compact fixtures,
 * with `merged` = `mergeStaticBoxes(index.boxes)`.
 */
export function createPhysicsWorld(
  rapier: RapierModule,
  statics: BoxIndex | TerrainColliders,
  merged?: Float64Array,
): PhysicsWorld {
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 })
  let staticCount = 0
  const fixed = (desc: InstanceType<RapierModule['ColliderDesc']>) => {
    world.createCollider(
      desc.setRestitution(0.05).setFriction(0.9).setCollisionGroups(STATIC_GROUPS),
    )
    staticCount++
  }
  if ('heights' in statics) {
    const [cx, cy, cz] = statics.center
    const [sx, sy, sz] = statics.scale
    fixed(
      rapier.ColliderDesc.heightfield(statics.rows - 1, statics.columns - 1, statics.heights, {
        x: sx,
        y: sy,
        z: sz,
      })
        // Rapier misses an exactly vertical ray lying on a heightfield grid line. Grid lines sit
        // on round coordinates; a sub-millimetre irrational shift keeps queries off them.
        .setTranslation(cx + GRID_NUDGE * Math.SQRT2, cy, cz + GRID_NUDGE * Math.SQRT1_2),
    )
    if (statics.cliffIndices.length)
      fixed(rapier.ColliderDesc.trimesh(statics.cliffPositions, statics.cliffIndices))
    const starts = statics.boulderStarts
    for (let b = 0; b + 1 < starts.length; b++) {
      const hull = rapier.ColliderDesc.convexHull(
        statics.boulderPoints.subarray((starts[b] ?? 0) * 3, (starts[b + 1] ?? 0) * 3),
      )
      if (hull) fixed(hull)
    }
  } else {
    const boxes = merged ?? mergeStaticBoxes(statics.boxes)
    for (let i = 0; i + 5 < boxes.length; i += 6) {
      const x0 = required(boxes[i]),
        y0 = required(boxes[i + 1]),
        z0 = required(boxes[i + 2])
      const x1 = required(boxes[i + 3]),
        y1 = required(boxes[i + 4]),
        z1 = required(boxes[i + 5])
      fixed(
        rapier.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2).setTranslation(
          (x0 + x1) / 2,
          (y0 + y1) / 2,
          (z0 + z1) / 2,
        ),
      )
    }
  }
  // Populate the query pipeline once; statics never move afterwards.
  world.step()
  const columns = 'heights' in statics ? statics.columnsTop : statics.columns
  const ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  const broadphaseHit = (a: TracerPoint, b: TracerPoint) => {
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) / 2) - columns.x)
    const z0 = Math.max(0, Math.floor(Math.min(a.z, b.z) / 2) - columns.z)
    const x1 = Math.min(columns.width - 1, Math.floor(Math.max(a.x, b.x) / 2) - columns.x)
    const z1 = Math.min(columns.height - 1, Math.floor(Math.max(a.z, b.z) / 2) - columns.z)
    const low = Math.min(a.y, b.y)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (low <= required(columns.tops[z * columns.width + x])) return true
    return false
  }
  const aim = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => {
    ray.origin.x = ox
    ray.origin.y = oy
    ray.origin.z = oz
    ray.dir.x = dx
    ray.dir.y = dy
    ray.dir.z = dz
  }
  return {
    rapier,
    world,
    staticCount,
    trace(a, b) {
      if (!broadphaseHit(a, b)) return Infinity
      aim(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z)
      const hit = world.castRay(ray, 1, true, undefined, STATIC_QUERY_GROUPS)
      return hit ? hit.timeOfImpact : Infinity
    },
    castDistance(origin, direction, maxDistance) {
      aim(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z)
      const hit = world.castRay(ray, maxDistance, false, undefined, STATIC_QUERY_GROUPS)
      return hit ? hit.timeOfImpact : null
    },
    dispose() {
      world.free()
    },
  }
}

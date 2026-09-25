import type { World } from '@dimforge/rapier3d-compat'

import { required } from '../invariant'
import type { VoxelIndex } from './voxel-spatial'

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

export type TracerPoint = {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Terrain membership; queries address statics only, never droplets or fish. */
const STATIC_GROUPS = (0x0001 << 16) | 0xffff
const STATIC_QUERY_GROUPS = (0x0001 << 16) | 0x0001

type MergedBox = {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

const MERGE_EPS = 1e-4
// Normalize -0 so both sides of the origin share merge keys.
const quantize = (value: number) => Math.round(value / MERGE_EPS) + 0

function spans(box: MergedBox, axis: 0 | 1 | 2) {
  const cross =
    axis === 0
      ? [box.y0, box.y1, box.z0, box.z1]
      : axis === 1
        ? [box.x0, box.x1, box.z0, box.z1]
        : [box.x0, box.x1, box.y0, box.y1]
  return {
    key: cross.map(quantize).join(','),
    start: axis === 0 ? box.x0 : axis === 1 ? box.y0 : box.z0,
    end: axis === 0 ? box.x1 : axis === 1 ? box.y1 : box.z1,
  }
}

function mergeAlong(entries: MergedBox[], axis: 0 | 1 | 2): MergedBox[] {
  // String order only needs equal keys adjacent; starts order within each run.
  const keyed = entries
    .map((box) => ({ box, ...spans(box, axis) }))
    .toSorted((a, b) => (a.key === b.key ? a.start - b.start : a.key < b.key ? -1 : 1))
  const merged: MergedBox[] = []
  let key = ''
  let end = 0
  for (const entry of keyed) {
    const current = merged[merged.length - 1]
    if (current && entry.key === key && entry.start <= end + MERGE_EPS) {
      end = Math.max(end, entry.end)
      if (axis === 0) current.x1 = end
      else if (axis === 1) current.y1 = end
      else current.z1 = end
    } else {
      key = entry.key
      end = entry.end
      merged.push({ ...entry.box })
    }
  }
  return merged
}

/** Greedy exact merge of axis-aligned voxel boxes into few solid cuboids. */
export function mergeStaticBoxes(boxes: Float64Array): Float64Array {
  let entries: MergedBox[] = []
  for (let i = 0; i + 5 < boxes.length; i += 6) {
    entries.push({
      x0: required(boxes[i]),
      y0: required(boxes[i + 1]),
      z0: required(boxes[i + 2]),
      x1: required(boxes[i + 3]),
      y1: required(boxes[i + 4]),
      z1: required(boxes[i + 5]),
    })
  }
  for (const axis of [0, 2, 1] as const) entries = mergeAlong(entries, axis)
  const merged = new Float64Array(entries.length * 6)
  entries.forEach((box, i) => {
    merged.set([box.x0, box.y0, box.z0, box.x1, box.y1, box.z1], i * 6)
  })
  return merged
}

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

/** One shared world: fixed terrain colliders, queries plus stepped dynamics. */
export function createPhysicsWorld(rapier: RapierModule, index: VoxelIndex): PhysicsWorld {
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 })
  const merged = mergeStaticBoxes(index.boxes)
  for (let i = 0; i + 5 < merged.length; i += 6) {
    const x0 = required(merged[i]),
      y0 = required(merged[i + 1]),
      z0 = required(merged[i + 2])
    const x1 = required(merged[i + 3]),
      y1 = required(merged[i + 4]),
      z1 = required(merged[i + 5])
    world.createCollider(
      rapier.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)
        .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        .setRestitution(0.05)
        .setFriction(0.9)
        .setCollisionGroups(STATIC_GROUPS),
    )
  }
  // Populate the query pipeline once; statics never move afterwards.
  world.step()
  const columns = index.columns
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
    staticCount: merged.length / 6,
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

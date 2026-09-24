import { required } from '../invariant'
import type { Voxel } from './voxel-world'

export type VoxelIndex = {
  boxes: Float64Array
  columns: { x: number; z: number; width: number; height: number; tops: Float64Array }
  bounds: Float64Array
  nodes: Int32Array
  order: Uint32Array
}

/** A static BVH shared by conservative face removal and nearest solid picking. */
export function createVoxelIndex(voxels: readonly Voxel[]): VoxelIndex {
  const boxes = new Float64Array(voxels.length * 6)
  voxels.forEach((voxel, i) => {
    const half = Math.fround(voxel.size) / 2
    const center = [voxel.x, voxel.y, voxel.z].map(Math.fround)
    for (let axis = 0; axis < 3; axis++) {
      boxes[i * 6 + axis] = required(center[axis]) - half
      boxes[i * 6 + axis + 3] = required(center[axis]) + half
    }
  })
  const order = Uint32Array.from(voxels, (_, i) => i)
  const bounds: number[] = []
  const nodes: number[] = []
  const build = (start: number, end: number): number => {
    const node = nodes.length / 4
    nodes.push(-1, -1, start, end)
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = start; i < end; i++)
      for (let a = 0; a < 3; a++) {
        box[a] = Math.min(required(box[a]), required(boxes[required(order[i]) * 6 + a]))
        box[a + 3] = Math.max(required(box[a + 3]), required(boxes[required(order[i]) * 6 + a + 3]))
      }
    bounds.push(...box)
    if (end - start > 8) {
      let axis = 0
      for (let a = 1; a < 3; a++)
        if (required(box[a + 3]) - required(box[a]) > required(box[axis + 3]) - required(box[axis]))
          axis = a
      order
        .subarray(start, end)
        .sort(
          (a, b) =>
            required(boxes[a * 6 + axis]) +
            required(boxes[a * 6 + axis + 3]) -
            required(boxes[b * 6 + axis]) -
            required(boxes[b * 6 + axis + 3]),
        )
      const middle = (start + end) >>> 1
      nodes[node * 4] = build(start, middle)
      nodes[node * 4 + 1] = build(middle, end)
    }
    return node
  }
  if (voxels.length) build(0, voxels.length)
  // Conservative two-metre columns reject airborne segments without walking the BVH.
  // Float64 retains the exact tops used by narrow-phase tests, including grid boundaries.
  const x = Math.floor((bounds[0] ?? 0) / 2)
  const z = Math.floor((bounds[2] ?? 0) / 2)
  const width = voxels.length ? Math.floor(required(bounds[3]) / 2) - x + 1 : 0
  const height = voxels.length ? Math.floor(required(bounds[5]) / 2) - z + 1 : 0
  const tops = new Float64Array(width * height).fill(-Infinity)
  for (let i = 0; i < boxes.length; i += 6) {
    const x0 = Math.floor(required(boxes[i]) / 2) - x,
      x1 = Math.floor(required(boxes[i + 3]) / 2) - x
    const z0 = Math.floor(required(boxes[i + 2]) / 2) - z,
      z1 = Math.floor(required(boxes[i + 5]) / 2) - z
    for (let row = z0; row <= z1; row++)
      for (let column = x0; column <= x1; column++) {
        const at = row * width + column
        tops[at] = Math.max(required(tops[at]), required(boxes[i + 4]))
      }
  }
  return {
    boxes,
    bounds: new Float64Array(bounds),
    nodes: new Int32Array(nodes),
    order,
    columns: { x, z, width, height, tops },
  }
}

export function overlappingVoxels(
  index: VoxelIndex,
  box: readonly number[],
  visit: (id: number) => void,
) {
  const { bounds, boxes, nodes, order } = index
  const overlaps = (data: Float64Array, offset: number) => {
    for (let a = 0; a < 3; a++)
      if (
        required(data[offset + a]) > required(box[a + 3]) ||
        required(data[offset + a + 3]) < required(box[a])
      )
        return false
    return true
  }
  const walk = (node: number) => {
    if (!overlaps(bounds, node * 6)) return
    if (required(nodes[node * 4]) >= 0) {
      walk(required(nodes[node * 4]))
      walk(required(nodes[node * 4 + 1]))
    } else {
      for (let i = required(nodes[node * 4 + 2]); i < required(nodes[node * 4 + 3]); i++) {
        const id = required(order[i])
        if (overlaps(boxes, id * 6)) visit(id)
      }
    }
  }
  if (nodes.length) walk(0)
}

/** Matches front-facing cube picking, including rays that start inside a solid. */
export function firstVoxelHit(
  index: VoxelIndex,
  origin: readonly number[],
  direction: readonly number[],
  far = 130,
  includeInside = false,
  accept?: (id: number) => boolean,
) {
  const { bounds, boxes, nodes, order } = index
  let nearest = far
  let hit = -1
  const entry = (data: Float64Array, offset: number, solid = false) => {
    let near = -Infinity,
      end = nearest
    for (let a = 0; a < 3; a++) {
      const d = required(direction[a]),
        o = required(origin[a])
      if (d === 0) {
        if (o < required(data[offset + a]) || o > required(data[offset + a + 3])) return Infinity
      } else {
        const t1 = (required(data[offset + a]) - o) / d
        const t2 = (required(data[offset + a + 3]) - o) / d
        near = Math.max(near, Math.min(t1, t2))
        end = Math.min(end, Math.max(t1, t2))
      }
    }
    return end < Math.max(0, near) || (solid && !includeInside && near < 0)
      ? Infinity
      : Math.max(0, near)
  }
  const walk = (node: number) => {
    if (entry(bounds, node * 6) > nearest) return
    const left = required(nodes[node * 4]),
      right = required(nodes[node * 4 + 1])
    if (left >= 0) {
      if (entry(bounds, left * 6) < entry(bounds, right * 6)) {
        walk(left)
        walk(right)
      } else {
        walk(right)
        walk(left)
      }
    } else {
      for (let i = required(nodes[node * 4 + 2]); i < required(nodes[node * 4 + 3]); i++) {
        const id = required(order[i])
        if (accept && !accept(id)) continue
        const distance = entry(boxes, id * 6, true)
        if (distance <= nearest) {
          nearest = distance
          hit = id
        }
      }
    }
  }
  if (nodes.length) walk(0)
  return hit < 0 ? null : { id: hit, distance: nearest }
}

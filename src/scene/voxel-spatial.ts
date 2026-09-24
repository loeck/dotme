import type { Voxel } from './voxel-world'

export type VoxelIndex = {
  boxes: Float64Array
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
      boxes[i * 6 + axis] = center[axis]! - half
      boxes[i * 6 + axis + 3] = center[axis]! + half
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
        box[a] = Math.min(box[a]!, boxes[order[i]! * 6 + a]!)
        box[a + 3] = Math.max(box[a + 3]!, boxes[order[i]! * 6 + a + 3]!)
      }
    bounds.push(...box)
    if (end - start > 8) {
      let axis = 0
      for (let a = 1; a < 3; a++) if (box[a + 3]! - box[a]! > box[axis + 3]! - box[axis]!) axis = a
      order
        .subarray(start, end)
        .sort(
          (a, b) =>
            boxes[a * 6 + axis]! +
            boxes[a * 6 + axis + 3]! -
            boxes[b * 6 + axis]! -
            boxes[b * 6 + axis + 3]!,
        )
      const middle = (start + end) >>> 1
      nodes[node * 4] = build(start, middle)
      nodes[node * 4 + 1] = build(middle, end)
    }
    return node
  }
  if (voxels.length) build(0, voxels.length)
  return { boxes, bounds: new Float64Array(bounds), nodes: new Int32Array(nodes), order }
}

export function overlappingVoxels(
  index: VoxelIndex,
  box: readonly number[],
  visit: (id: number) => void,
) {
  const { bounds, boxes, nodes, order } = index
  const overlaps = (data: Float64Array, offset: number) => {
    for (let a = 0; a < 3; a++)
      if (data[offset + a]! > box[a + 3]! || data[offset + a + 3]! < box[a]!) return false
    return true
  }
  const walk = (node: number) => {
    if (!overlaps(bounds, node * 6)) return
    if (nodes[node * 4]! >= 0) {
      walk(nodes[node * 4]!)
      walk(nodes[node * 4 + 1]!)
    } else {
      for (let i = nodes[node * 4 + 2]!; i < nodes[node * 4 + 3]!; i++) {
        const id = order[i]!
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
) {
  const { bounds, boxes, nodes, order } = index
  let nearest = far
  let hit = -1
  const entry = (data: Float64Array, offset: number, solid = false) => {
    let near = -Infinity,
      end = nearest
    for (let a = 0; a < 3; a++) {
      const d = direction[a]!,
        o = origin[a]!
      if (d === 0) {
        if (o < data[offset + a]! || o > data[offset + a + 3]!) return Infinity
      } else {
        const t1 = (data[offset + a]! - o) / d
        const t2 = (data[offset + a + 3]! - o) / d
        near = Math.max(near, Math.min(t1, t2))
        end = Math.min(end, Math.max(t1, t2))
      }
    }
    return end < Math.max(0, near) || (solid && near < 0) ? Infinity : Math.max(0, near)
  }
  const walk = (node: number) => {
    if (entry(bounds, node * 6) > nearest) return
    const left = nodes[node * 4]!,
      right = nodes[node * 4 + 1]!
    if (left >= 0) {
      if (entry(bounds, left * 6) < entry(bounds, right * 6)) {
        walk(left)
        walk(right)
      } else {
        walk(right)
        walk(left)
      }
    } else {
      for (let i = nodes[node * 4 + 2]!; i < nodes[node * 4 + 3]!; i++) {
        const id = order[i]!,
          distance = entry(boxes, id * 6, true)
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

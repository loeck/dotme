import { required } from '../invariant'

/** An axis-aligned cube: the box primitive of simple fixtures and of the spatial index. */
export type Box = Readonly<{ x: number; y: number; z: number; size: number; color: number }>

export type BoxIndex = {
  boxes: Float64Array
  columns: { x: number; z: number; width: number; height: number; tops: Float64Array }
  bounds: Float64Array
  nodes: Int32Array
  order: Uint32Array
}

/** Float32-snapped solid bounds, six values per cube: min xyz then max xyz. */
function boxBounds(cubes: readonly Box[]): Float64Array {
  const boxes = new Float64Array(cubes.length * 6)
  for (let i = 0; i < cubes.length; i++) {
    const cube = required(cubes[i])
    const half = Math.fround(cube.size) / 2
    const x = Math.fround(cube.x),
      y = Math.fround(cube.y),
      z = Math.fround(cube.z)
    boxes[i * 6] = x - half
    boxes[i * 6 + 1] = y - half
    boxes[i * 6 + 2] = z - half
    boxes[i * 6 + 3] = x + half
    boxes[i * 6 + 4] = y + half
    boxes[i * 6 + 5] = z + half
  }
  return boxes
}

/** A static BVH shared by conservative face removal and nearest solid picking. */
export function createBoxIndex(cubes: readonly Box[]): BoxIndex {
  const boxes = boxBounds(cubes)
  const order = Uint32Array.from(cubes, (_, i) => i)
  const bounds: number[] = []
  const nodes: number[] = []
  const at = (offset: number) => boxes[offset] ?? 0
  const build = (start: number, end: number): number => {
    const node = nodes.length / 4
    nodes.push(-1, -1, start, end)
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity
    for (let i = start; i < end; i++) {
      const offset = (order[i] ?? 0) * 6
      minX = Math.min(minX, at(offset))
      minY = Math.min(minY, at(offset + 1))
      minZ = Math.min(minZ, at(offset + 2))
      maxX = Math.max(maxX, at(offset + 3))
      maxY = Math.max(maxY, at(offset + 4))
      maxZ = Math.max(maxZ, at(offset + 5))
    }
    box[0] = minX
    box[1] = minY
    box[2] = minZ
    box[3] = maxX
    box[4] = maxY
    box[5] = maxZ
    bounds.push(...box)
    if (end - start > 8) {
      const extent = [maxX - minX, maxY - minY, maxZ - minZ]
      let axis = 0
      for (let a = 1; a < 3; a++) if (required(extent[a]) > required(extent[axis])) axis = a
      order
        .subarray(start, end)
        .sort(
          (a, b) =>
            at(a * 6 + axis) + at(a * 6 + axis + 3) - at(b * 6 + axis) - at(b * 6 + axis + 3),
        )
      const middle = (start + end) >>> 1
      nodes[node * 4] = build(start, middle)
      nodes[node * 4 + 1] = build(middle, end)
    }
    return node
  }
  if (cubes.length) build(0, cubes.length)
  // Conservative two-metre columns reject airborne segments without walking the BVH.
  // Float64 retains the exact tops used by narrow-phase tests, including grid boundaries.
  const x = Math.floor((bounds[0] ?? 0) / 2)
  const z = Math.floor((bounds[2] ?? 0) / 2)
  const width = cubes.length ? Math.floor(required(bounds[3]) / 2) - x + 1 : 0
  const height = cubes.length ? Math.floor(required(bounds[5]) / 2) - z + 1 : 0
  const tops = new Float64Array(width * height).fill(-Infinity)
  for (let i = 0; i < boxes.length; i += 6) {
    const x0 = Math.floor(required(boxes[i]) / 2) - x,
      x1 = Math.floor(required(boxes[i + 3]) / 2) - x
    const z0 = Math.floor(required(boxes[i + 2]) / 2) - z,
      z1 = Math.floor(required(boxes[i + 5]) / 2) - z
    for (let row = z0; row <= z1; row++)
      for (let column = x0; column <= x1; column++) {
        const cell = row * width + column
        tops[cell] = Math.max(required(tops[cell]), required(boxes[i + 4]))
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

/** Matches front-facing cube picking, including rays that start inside a solid. */
export function firstBoxHit(
  index: BoxIndex,
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

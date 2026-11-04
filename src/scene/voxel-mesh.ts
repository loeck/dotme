import { BoxGeometry, Color } from 'three/webgpu'

import { required } from '../invariant'
import { terrainEyes } from './camera-rig'
import { prepareGeometryBounds } from './geometry-bounds'
import type { PreparedBounds } from './geometry-bounds'
import { WATER_LEVEL } from './lake-bed'
import { createVoxelIndex, overlappingVoxels } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import type { VoxelMaterial, VoxelWorld } from './voxel-world'

export type TerrainBatch = {
  material: VoxelMaterial
  /** BoxGeometry face order: +x, -x, +y, -y, +z, -z. */
  face: number
  bounds: PreparedBounds
  positions: Float32Array
  normals: Int8Array
  colors: Float32Array
  indices: Uint16Array | Uint32Array
}
export type PreparedTerrain = {
  batches: TerrainBatch[]
  shadowMatrices: Float32Array[]
  index: VoxelIndex
  totalFaces: number
  exposedFaces: number
}

/** Only discard a whole face if the union of neighboring solid rectangles covers it.
 * Partial faces remain intact: no new seams, interpolated colors or changed normals. */
export function exposedVoxelFaces(index: VoxelIndex, id: number): boolean[] {
  const boxes = index.boxes
  const box = Array.from(boxes.subarray(id * 6, id * 6 + 6))
  // Float32 instance translations can leave sub-ULP gaps at nominal grid contacts.
  const epsilon = 1e-5
  const nearby: number[] = []
  overlappingVoxels(
    index,
    box.map((v, a) => v + (a < 3 ? -epsilon : epsilon)),
    (other) => {
      if (other !== id) nearby.push(other)
    },
  )
  const at = (offset: number) => boxes[offset] ?? 0
  // Uncovered rectangles as flat [x0, y0, x1, y1] runs, split in the same order
  // as before (left, right, below, above) so coverage decisions are unchanged.
  let uncovered: number[] = []
  let next: number[] = []
  const visible: boolean[] = []
  for (let face = 0; face < 6; face++) {
    const axis = face >>> 1,
      positive = face % 2 === 0
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3
    const plane = required(box[axis + (positive ? 3 : 0)])
    uncovered.length = 0
    uncovered.push(required(box[u]), required(box[v]), required(box[u + 3]), required(box[v + 3]))
    let exposed = true
    for (const other of nearby) {
      const b = other * 6
      if (
        positive
          ? at(b + axis) > plane + epsilon || at(b + axis + 3) <= plane + epsilon
          : at(b + axis + 3) < plane - epsilon || at(b + axis) >= plane - epsilon
      )
        continue
      const bu0 = at(b + u),
        bv0 = at(b + v),
        bu1 = at(b + u + 3),
        bv1 = at(b + v + 3)
      next.length = 0
      for (let r = 0; r < uncovered.length; r += 4) {
        const x0 = uncovered[r] ?? 0,
          y0 = uncovered[r + 1] ?? 0,
          x1 = uncovered[r + 2] ?? 0,
          y1 = uncovered[r + 3] ?? 0
        const loX = Math.max(x0, bu0),
          loY = Math.max(y0, bv0)
        const hiX = Math.min(x1, bu1),
          hiY = Math.min(y1, bv1)
        if (hiX <= loX || hiY <= loY) {
          next.push(x0, y0, x1, y1)
          continue
        }
        if (loX - x0 > epsilon) next.push(x0, y0, loX, y1)
        if (x1 - hiX > epsilon) next.push(hiX, y0, x1, y1)
        if (loY - y0 > epsilon) next.push(loX, y0, hiX, loY)
        if (y1 - hiY > epsilon) next.push(loX, hiY, hiX, y1)
      }
      const swap = uncovered
      uncovered = next
      next = swap
      if (!uncovered.length) {
        exposed = false
        break
      }
    }
    visible.push(exposed)
  }
  return visible
}

export function prepareTerrain(world: VoxelWorld, eyes = terrainEyes()): PreparedTerrain {
  const nearest = [0, 1, 2].map((axis) => Math.min(...eyes.map((eye) => required(eye[axis]))))
  const farthest = [0, 1, 2].map((axis) => Math.max(...eyes.map((eye) => required(eye[axis]))))
  const index = createVoxelIndex(world.voxels)
  const cube = new BoxGeometry(1, 1, 1)
  const positions = cube.getAttribute('position'),
    normals = cube.getAttribute('normal')
  const batches: TerrainBatch[] = []
  let offset = 0,
    exposedFaces = 0
  const color = new Color()
  const moss = new Color(0x4f5d40)
  const topColor = new Color()
  // Forest soil under the turf (Last Signal's peat and dirt), independent of the voxel's
  // framing dim so risers keep a readable earth tone.
  const soil = new Color(0x6e5c44)
  // Wet stone for shore and rock risers, also independent of the framing dim.
  const stone = new Color(0x5c5b55)
  const lipColor = new Color()
  const footColor = new Color()
  const mossFoot = new Color()
  const mossPatch = (id: number) => {
    let n = Math.imul(id + 1, 0x85ebca6b)
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35)
    return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000
  }
  for (const material of ['ground', 'shore', 'rock'] as const) {
    const chunks = new Map<string, number[]>()
    for (let i = offset; i < offset + world.groups[material].count; i++) {
      const voxel = required(world.voxels[i])
      const key = `${Math.floor(voxel.x / 12)}:${Math.floor(voxel.z / 12)}`
      const chunk = chunks.get(key) ?? []
      if (!chunks.has(key)) chunks.set(key, chunk)
      chunk.push(i)
    }
    offset += world.groups[material].count
    for (const ids of chunks.values()) {
      const faces = Array.from(
        { length: 6 },
        (): { p: number[]; n: number[]; c: number[]; triangles: number[] } => ({
          p: [],
          n: [],
          c: [],
          triangles: [],
        }),
      )
      for (const id of ids) {
        const voxel = required(world.voxels[id])
        color.setHex(voxel.color)
        const mossy =
          material === 'ground' && voxel.y + voxel.size / 2 > WATER_LEVEL + 0.05
            ? 0.78 + 0.17 * mossPatch(id)
            : 0
        topColor.copy(color).lerp(moss, mossy)
        // Mossy risers grade from a moss lip under the turf to darker soil at the foot, rather
        // than one flat dark face. Past the foreground the moss climbs over the whole riser: seen
        // from afar, brown risers under green tops stack into a staircase of dark stripes, while
        // mossy ones read as one continuous slope.
        if (mossy) {
          const distant = Math.min(1, Math.max(0, (2 - voxel.z) / 8))
          lipColor.copy(soil).lerp(topColor, 0.55 + 0.45 * distant)
          footColor
            .copy(soil)
            .multiplyScalar(0.55)
            .lerp(mossFoot.copy(soil).lerp(topColor, 0.45).multiplyScalar(0.8), distant)
        } else {
          lipColor.copy(color).lerp(stone, 0.5)
          footColor.copy(lipColor).multiplyScalar(0.7)
        }
        const visible = exposedVoxelFaces(index, id)
        for (let face = 0; face < 6; face++) {
          if (!visible[face]) continue
          exposedFaces++
          const axis = face >>> 1
          const plane =
            Math.fround(required([voxel.x, voxel.y, voxel.z][axis])) +
            (face % 2 === 0 ? 0.5 : -0.5) * Math.fround(voxel.size)
          // Axis-aligned faces are front-facing to some eye iff one eye lies beyond their plane.
          if (face % 2 === 0 ? required(farthest[axis]) <= plane : required(nearest[axis]) >= plane)
            continue
          const { p, n, c, triangles } = required(faces[face])
          const base = p.length / 3
          const side = face !== 2 && face !== 3
          for (let vertex = face * 4; vertex < face * 4 + 4; vertex++) {
            const faceColor =
              face === 2
                ? topColor
                : side
                  ? positions.getY(vertex) > 0
                    ? lipColor
                    : footColor
                  : color
            p.push(
              Math.fround(voxel.x) + positions.getX(vertex) * Math.fround(voxel.size),
              Math.fround(voxel.y) + positions.getY(vertex) * Math.fround(voxel.size),
              Math.fround(voxel.z) + positions.getZ(vertex) * Math.fround(voxel.size),
            )
            n.push(
              normals.getX(vertex) * 127,
              normals.getY(vertex) * 127,
              normals.getZ(vertex) * 127,
            )
            c.push(faceColor.r, faceColor.g, faceColor.b)
          }
          triangles.push(base, base + 2, base + 1, base + 2, base + 3, base + 1)
        }
      }
      faces.forEach(({ p, n, c, triangles }, face) => {
        if (!p.length) return
        const batchPositions = new Float32Array(p)
        batches.push({
          material,
          face,
          positions: batchPositions,
          bounds: prepareGeometryBounds(batchPositions),
          normals: new Int8Array(n),
          colors: new Float32Array(c),
          indices: p.length / 3 <= 65535 ? new Uint16Array(triangles) : new Uint32Array(triangles),
        })
      })
    }
  }
  cube.dispose()
  const shadowMatrices = prepareShadowMatrices(world)
  return {
    batches,
    shadowMatrices,
    index,
    totalFaces: world.voxels.length * 6,
    exposedFaces,
  }
}

/** Original cube transforms, prepared off-thread in tighter shadow-only batches. */
function prepareShadowMatrices(world: VoxelWorld) {
  const matrices: Float32Array[] = []
  let offset = 0
  for (const kind of ['ground', 'shore', 'rock'] as const) {
    const chunks = new Map<string, number[]>()
    for (let i = offset; i < offset + world.groups[kind].count; i++) {
      const voxel = required(world.voxels[i])
      const key = `${Math.floor(voxel.x / 6)}:${Math.floor(voxel.z / 6)}`
      const chunk = chunks.get(key) ?? []
      if (!chunks.has(key)) chunks.set(key, chunk)
      chunk.push(i)
    }
    offset += world.groups[kind].count
    for (const ids of chunks.values()) {
      const batch = new Float32Array(ids.length * 16)
      ids.forEach((id, i) => {
        const voxel = required(world.voxels[id]),
          start = i * 16
        batch[start] = batch[start + 5] = batch[start + 10] = voxel.size
        batch[start + 12] = voxel.x
        batch[start + 13] = voxel.y
        batch[start + 14] = voxel.z
        batch[start + 15] = 1
      })
      matrices.push(batch)
    }
  }
  return matrices
}

import { BoxGeometry, Color } from 'three'

import { createVoxelIndex, overlappingVoxels } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import type { VoxelMaterial, VoxelWorld } from './voxel-world'

export type TerrainBatch = {
  material: VoxelMaterial
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
  const box = Array.from(index.boxes.subarray(id * 6, id * 6 + 6))
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
  return [0, 1, 2, 3, 4, 5].map((face) => {
    const axis = face >>> 1,
      positive = face % 2 === 0
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3
    const plane = box[axis + (positive ? 3 : 0)]!
    let uncovered = [[box[u]!, box[v]!, box[u + 3]!, box[v + 3]!]]
    for (const other of nearby) {
      const b = index.boxes.subarray(other * 6, other * 6 + 6)
      if (
        positive
          ? b[axis]! > plane + epsilon || b[axis + 3]! <= plane + epsilon
          : b[axis + 3]! < plane - epsilon || b[axis]! >= plane - epsilon
      )
        continue
      const next: number[][] = []
      for (const [x0, y0, x1, y1] of uncovered as [number, number, number, number][]) {
        const loX = Math.max(x0, b[u]!),
          loY = Math.max(y0, b[v]!)
        const hiX = Math.min(x1, b[u + 3]!),
          hiY = Math.min(y1, b[v + 3]!)
        if (hiX <= loX || hiY <= loY) {
          next.push([x0, y0, x1, y1])
          continue
        }
        if (loX - x0 > epsilon) next.push([x0, y0, loX, y1])
        if (x1 - hiX > epsilon) next.push([hiX, y0, x1, y1])
        if (loY - y0 > epsilon) next.push([loX, y0, hiX, loY])
        if (y1 - hiY > epsilon) next.push([loX, hiY, hiX, y1])
      }
      uncovered = next
      if (!uncovered.length) return false
    }
    return true
  })
}

export function prepareTerrain(world: VoxelWorld): PreparedTerrain {
  const index = createVoxelIndex(world.voxels)
  const cube = new BoxGeometry(1, 1, 1)
  const positions = cube.getAttribute('position'),
    normals = cube.getAttribute('normal')
  const batches: TerrainBatch[] = []
  let offset = 0,
    exposedFaces = 0
  const color = new Color()
  for (const material of Object.keys(world.groups) as VoxelMaterial[]) {
    const chunks = new Map<string, number[]>()
    for (let i = offset; i < offset + world.groups[material].count; i++) {
      const voxel = world.voxels[i]!
      const key = `${Math.floor(voxel.x / 12)}:${Math.floor(voxel.z / 12)}`
      const chunk = chunks.get(key) ?? []
      if (!chunks.has(key)) chunks.set(key, chunk)
      chunk.push(i)
    }
    offset += world.groups[material].count
    for (const ids of chunks.values()) {
      const p: number[] = [],
        n: number[] = [],
        c: number[] = [],
        triangles: number[] = []
      for (const id of ids) {
        const voxel = world.voxels[id]!
        color.setHex(voxel.color)
        const visible = exposedVoxelFaces(index, id)
        for (let face = 0; face < 6; face++) {
          if (!visible[face]) continue
          exposedFaces++
          const base = p.length / 3
          for (let vertex = face * 4; vertex < face * 4 + 4; vertex++) {
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
            c.push(color.r, color.g, color.b)
          }
          triangles.push(base, base + 2, base + 1, base + 2, base + 3, base + 1)
        }
      }
      if (p.length)
        batches.push({
          material,
          positions: new Float32Array(p),
          normals: new Int8Array(n),
          colors: new Float32Array(c),
          indices: p.length / 3 <= 65535 ? new Uint16Array(triangles) : new Uint32Array(triangles),
        })
    }
  }
  cube.dispose()
  return {
    batches,
    shadowMatrices: prepareShadowMatrices(world),
    index,
    totalFaces: world.voxels.length * 6,
    exposedFaces,
  }
}

/** Original cube transforms, prepared off-thread in tighter shadow-only batches. */
function prepareShadowMatrices(world: VoxelWorld) {
  const matrices: Float32Array[] = []
  let offset = 0
  for (const kind of Object.keys(world.groups) as VoxelMaterial[]) {
    const chunks = new Map<string, number[]>()
    for (let i = offset; i < offset + world.groups[kind].count; i++) {
      const voxel = world.voxels[i]!
      const key = `${Math.floor(voxel.x / 6)}:${Math.floor(voxel.z / 6)}`
      const chunk = chunks.get(key) ?? []
      if (!chunks.has(key)) chunks.set(key, chunk)
      chunk.push(i)
    }
    offset += world.groups[kind].count
    for (const ids of chunks.values()) {
      const batch = new Float32Array(ids.length * 16)
      ids.forEach((id, i) => {
        const voxel = world.voxels[id]!,
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

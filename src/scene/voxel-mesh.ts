import { BoxGeometry, Color } from 'three/webgpu'

import { required } from '../invariant'
import { CAMERA_REST, terrainEyes } from './camera-rig'
import { prepareGeometryBounds } from './geometry-bounds'
import type { PreparedBounds } from './geometry-bounds'
import { WATER_LEVEL } from './lake-bed'
import { awaySides, erodeTop, erosionDensity, riserDrop, slotTaken } from './terrain-erosion'
import type { Erosion } from './terrain-erosion'
import { lipCells } from './terrain-lips'
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
  /** Render-only micro-voxels at step lips and feet (see terrain-lips.ts). */
  lipCells: number
  /** Render-only micro-columns chipped out of step edges (see terrain-erosion.ts). */
  chips: number
  /** Render-only micro-columns heaped at riser feet (see terrain-erosion.ts). */
  fills: number
}

/** Overlap between pieces of an eroded voxel, hidden inside the solid, that seals T-junctions. */
const SEAM = 1e-3
/** Grid neighbours of a chip: offset, the face of the wall toward the chip and its parent side
 * (SIDES index in terrain-erosion.ts) when the neighbour lies outside the grid. */
const NEIGHBOURS = [
  [1, 0, 1, 0],
  [-1, 0, 0, 1],
  [0, 1, 5, 2],
  [0, -1, 4, 3],
] as const

/** Only discard a whole face if the union of neighboring solid rectangles covers it.
 * Partial faces remain intact: no new seams, interpolated colors or changed normals. */
export function exposedVoxelFaces(
  index: VoxelIndex,
  id: number,
  /** Receives every other solid touching the voxel, for callers that probe around it. */
  nearby: number[] = [],
): boolean[] {
  const boxes = index.boxes
  const box = Array.from(boxes.subarray(id * 6, id * 6 + 6))
  // Float32 instance translations can leave sub-ULP gaps at nominal grid contacts.
  const epsilon = 1e-5
  nearby.length = 0
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

/** BoxGeometry's unit cube: four corners per face, in its face order and winding. */
const CUBE = (() => {
  const cube = new BoxGeometry(1, 1, 1)
  const position = cube.getAttribute('position'),
    normal = cube.getAttribute('normal')
  const corners = new Float32Array(72),
    normals = new Int8Array(18)
  for (let vertex = 0; vertex < 24; vertex++)
    for (let a = 0; a < 3; a++) corners[vertex * 3 + a] = position.getComponent(vertex, a)
  for (let face = 0; face < 6; face++)
    for (let a = 0; a < 3; a++) normals[face * 3 + a] = normal.getComponent(face * 4, a) * 127
  cube.dispose()
  return { corners, normals }
})()

/** A copy of `array` at twice its length. */
function grown<T extends Float32Array | Int8Array | Uint32Array>(array: T, make: (n: number) => T) {
  const next = make(array.length * 2)
  next.set(array)
  return next
}

/** One face orientation's vertices for a chunk, in typed arrays that grow by doubling. */
class FaceBuffer {
  positions = new Float32Array(3 * 1024)
  normals = new Int8Array(3 * 1024)
  colors = new Float32Array(3 * 1024)
  indices = new Uint32Array(6 * 256)
  vertices = 0
  reset() {
    this.vertices = 0
  }
  private grow() {
    this.positions = grown(this.positions, (n) => new Float32Array(n))
    this.normals = grown(this.normals, (n) => new Int8Array(n))
    this.colors = grown(this.colors, (n) => new Float32Array(n))
    this.indices = grown(this.indices, (n) => new Uint32Array(n))
  }
  quad(
    face: number,
    cx: number,
    cy: number,
    cz: number,
    ex: number,
    ey: number,
    ez: number,
    base: Color,
    lip: Color | null,
    gradient: { bottom: number; size: number },
  ) {
    if ((this.vertices + 4) * 3 > this.positions.length) this.grow()
    const { positions, normals, colors, indices } = this
    const first = this.vertices
    for (let corner = 0; corner < 4; corner++) {
      const c = (face * 4 + corner) * 3
      const v = (first + corner) * 3
      const y = cy + required(CUBE.corners[c + 1]) * ey
      positions[v] = cx + required(CUBE.corners[c]) * ex
      positions[v + 1] = y
      positions[v + 2] = cz + required(CUBE.corners[c + 2]) * ez
      normals[v] = required(CUBE.normals[face * 3])
      normals[v + 1] = required(CUBE.normals[face * 3 + 1])
      normals[v + 2] = required(CUBE.normals[face * 3 + 2])
      const t = lip ? Math.min(1, Math.max(0, (y - gradient.bottom) / gradient.size)) : 0
      colors[v] = lip ? base.r + (lip.r - base.r) * t : base.r
      colors[v + 1] = lip ? base.g + (lip.g - base.g) * t : base.g
      colors[v + 2] = lip ? base.b + (lip.b - base.b) * t : base.b
    }
    const i = (first / 4) * 6
    indices[i] = first
    indices[i + 1] = first + 2
    indices[i + 2] = first + 1
    indices[i + 3] = first + 2
    indices[i + 4] = first + 3
    indices[i + 5] = first + 1
    this.vertices += 4
  }
  finish() {
    const count = this.vertices
    const triangles = this.indices.subarray(0, (count / 4) * 6)
    return {
      positions: this.positions.slice(0, count * 3),
      normals: this.normals.slice(0, count * 3),
      colors: this.colors.slice(0, count * 3),
      indices: count <= 65535 ? Uint16Array.from(triangles) : triangles.slice(),
    }
  }
}

export function prepareTerrain(world: VoxelWorld, eyes = terrainEyes()): PreparedTerrain {
  const nearest = [0, 1, 2].map((axis) => Math.min(...eyes.map((eye) => required(eye[axis]))))
  const farthest = [0, 1, 2].map((axis) => Math.max(...eyes.map((eye) => required(eye[axis]))))
  // The main camera's own range, without its mirror image or the environment probe.
  const camera = terrainEyes().filter(([, y, z]) => y > WATER_LEVEL && z > CAMERA_REST.z - 1)
  const cameraNearest = [0, 1, 2].map((a) => Math.min(...camera.map((eye) => required(eye[a]))))
  const cameraFarthest = [0, 1, 2].map((a) => Math.max(...camera.map((eye) => required(eye[a]))))
  const index = createVoxelIndex(world.voxels)
  const faces = Array.from({ length: 6 }, () => new FaceBuffer())
  const gradient = { bottom: 0, size: 1 }
  const batches: TerrainBatch[] = []
  let offset = 0,
    exposedFaces = 0,
    lipCount = 0,
    chipCount = 0,
    fillCount = 0
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
  const pebble = new Color().copy(stone).lerp(soil, 0.35)
  const cellTop = new Color()
  const cellSide = new Color()
  const cellUnder = new Color()
  const chipFloor = new Color()
  const used = new Uint8Array(64)
  const nearby: number[] = []
  const mossPatch = (id: number) => {
    let n = Math.imul(id + 1, 0x85ebca6b)
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35)
    return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000
  }
  const desktop = world.variant === 'desktop'
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
      for (const buffer of faces) buffer.reset()
      /** Emits one BoxGeometry face of an axis-aligned box (a zero extent makes a flat rect),
       * unless it can only face away from every eye. With `lip`, vertices grade from `base` at
       * the current voxel's foot to `lip` at its top; otherwise they all take `base`. */
      const emit = (
        face: number,
        cx: number,
        cy: number,
        cz: number,
        ex: number,
        ey: number,
        ez: number,
        base: Color,
        lip: Color | null = null,
      ) => {
        const axis = face >>> 1
        const plane =
          (axis === 0 ? cx : axis === 1 ? cy : cz) +
          (face % 2 === 0 ? 0.5 : -0.5) * (axis === 0 ? ex : axis === 1 ? ey : ez)
        // Axis-aligned faces are front-facing to some eye iff one eye lies beyond their plane.
        if (face % 2 === 0 ? required(farthest[axis]) <= plane : required(nearest[axis]) >= plane)
          return
        required(faces[face]).quad(face, cx, cy, cz, ex, ey, ez, base, lip, gradient)
      }
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
        // A chip's floor is the same turf or stone one cell lower, darkened as if occluded.
        chipFloor.copy(topColor).multiplyScalar(0.8)
        const visible = exposedVoxelFaces(index, id, nearby)
        const erosion = erodeTop(
          index,
          nearby,
          voxel,
          visible,
          erosionDensity(voxel.size, voxel.z, desktop, !mossy),
          desktop,
          awaySides(voxel, cameraNearest, cameraFarthest),
          required(cameraFarthest[1]),
        )
        if (erosion) {
          chipCount += erosion.chips
          fillCount += erosion.fills.length
          for (const fill of erosion.fills) {
            // Scree shows cut earth, like a lip cell's sides; a loose block is the stone it sits on.
            cellTop.copy(topColor).multiplyScalar(fill.shade)
            if (fill.kind === 'rubble') cellSide.copy(topColor).multiplyScalar(0.85 * fill.shade)
            else cellSide.copy(lipColor).lerp(footColor, 0.5).multiplyScalar(fill.shade)
            for (let face = 0; face < 6; face++) {
              if (fill.hidden.includes(face)) continue
              const faceColor = face === 2 ? cellTop : cellSide
              emit(face, ...fill.center, ...fill.extent, faceColor)
            }
          }
        }
        const dropped = erosion
          ? (side: number, slot: number) => slotTaken(erosion, side, slot)
          : undefined
        if (mossy) {
          for (const cell of lipCells(index, id, voxel, visible, desktop, dropped)) {
            lipCount++
            if (cell.kind === 'turf') {
              cellTop.copy(topColor).multiplyScalar(cell.shade)
              cellSide.copy(lipColor).lerp(footColor, 0.5).multiplyScalar(cell.shade)
              cellUnder.copy(lipColor).multiplyScalar(0.7 * cell.shade)
            } else {
              cellTop.copy(pebble).multiplyScalar(1.1 * cell.shade)
              cellSide.copy(pebble).multiplyScalar(cell.shade)
              cellUnder.copy(cellSide)
            }
            for (let face = 0; face < 6; face++) {
              if (cell.hidden.includes(face)) continue
              const faceColor = face === 2 ? cellTop : face === 3 ? cellUnder : cellSide
              emit(face, ...cell.center, ...cell.extent, faceColor)
            }
          }
        }
        const size = Math.fround(voxel.size)
        const vx = Math.fround(voxel.x),
          vy = Math.fround(voxel.y),
          vz = Math.fround(voxel.z)
        const bottom = vy - size / 2
        gradient.bottom = bottom
        gradient.size = size
        for (let face = 0; face < 6; face++) {
          if (!visible[face]) continue
          exposedFaces++
          if (erosion?.chips && (face === 2 || (face !== 3 && emitErodedRiser(face)))) continue
          emit(
            face,
            vx,
            vy,
            vz,
            size,
            size,
            size,
            face === 2 ? topColor : face === 3 ? color : footColor,
            face === 2 || face === 3 ? null : lipColor,
          )
        }
        if (erosion?.chips) emitErodedTop(erosion)

        /** Risers with chips: a full-length face below the deepest drop, then a short face
         * per run of equal drop above it. Returns false when this side has no chip. */
        function emitErodedRiser(face: number) {
          if (!erosion) return false
          const side = face === 0 ? 0 : face === 1 ? 1 : face === 4 ? 2 : 3
          const { n, cell } = erosion
          let deepest = 0
          for (let k = 0; k < n; k++) deepest = Math.max(deepest, riserDrop(erosion, side, k))
          if (!deepest) return false
          const axis = face >>> 1
          const sign = face % 2 === 0 ? 1 : -1
          const plane = (axis === 0 ? vx : vz) + (sign * size) / 2
          const start = (axis === 0 ? vz : vx) - size / 2
          const top = vy + size / 2
          const rect = (along0: number, along1: number, y0: number, y1: number) =>
            axis === 0
              ? emit(
                  face,
                  plane,
                  (y0 + y1) / 2,
                  (along0 + along1) / 2,
                  0,
                  y1 - y0,
                  along1 - along0,
                  footColor,
                  lipColor,
                )
              : emit(
                  face,
                  (along0 + along1) / 2,
                  (y0 + y1) / 2,
                  plane,
                  along1 - along0,
                  y1 - y0,
                  0,
                  footColor,
                  lipColor,
                )
          rect(start, start + size, bottom, top - deepest)
          for (let k = 0; k < n;) {
            const drop = riserDrop(erosion, side, k)
            let end = k + 1
            while (end < n && riserDrop(erosion, side, end) === drop) end++
            // Each upper face overlaps the one below by a hair, so no crack opens between them.
            if (drop < deepest)
              rect(start + k * cell, start + end * cell, top - deepest - SEAM, top - drop)
            k = end
          }
          return true
        }

        /** The eroded top: intact columns merged into rectangles, then each chip's floor and
         * the walls around it. Floors and walls overlap their neighbours by a hair, hidden
         * inside the solid, so the T-junctions they form never open a crack. */
        function emitErodedTop(eroded: Erosion) {
          const { n, cell, depth, through } = eroded
          const x0 = vx - size / 2,
            z0 = vz - size / 2,
            top = vy + size / 2
          const at = (i: number, j: number) =>
            i < 0 || j < 0 || i >= n || j >= n ? -1 : required(depth[i + j * n])
          used.fill(0, 0, n * n)
          for (let j = 0; j < n; j++)
            for (let i = 0; i < n; i++) {
              if (at(i, j) !== 0 || used[i + j * n]) continue
              let w = 1
              while (at(i + w, j) === 0 && !used[i + w + j * n]) w++
              let h = 1
              for (; j + h < n; h++) {
                let row = true
                for (let a = i; a < i + w; a++)
                  if (at(a, j + h) !== 0 || used[a + (j + h) * n]) row = false
                if (!row) break
              }
              for (let b = j; b < j + h; b++) for (let a = i; a < i + w; a++) used[a + b * n] = 1
              // Grow into intact neighbours only: a coplanar overlap of the same colour is
              // invisible, while one over a chip would show as a sliver.
              const intact = (a0: number, a1: number, b0: number, b1: number) => {
                for (let b = b0; b <= b1; b++)
                  for (let a = a0; a <= a1; a++) if (at(a, b) !== 0) return false
                return true
              }
              const left = i > 0 && intact(i - 1, i - 1, j, j + h - 1) ? SEAM : 0
              const right = i + w < n && intact(i + w, i + w, j, j + h - 1) ? SEAM : 0
              const back = j > 0 && intact(i, i + w - 1, j - 1, j - 1) ? SEAM : 0
              const front = j + h < n && intact(i, i + w - 1, j + h, j + h) ? SEAM : 0
              const ax0 = x0 + i * cell - left,
                ax1 = x0 + (i + w) * cell + right
              const az0 = z0 + j * cell - back,
                az1 = z0 + (j + h) * cell + front
              emit(2, (ax0 + ax1) / 2, top, (az0 + az1) / 2, ax1 - ax0, 0, az1 - az0, topColor)
            }
          for (let j = 0; j < n; j++)
            for (let i = 0; i < n; i++) {
              const drop = at(i, j)
              if (drop <= 0) continue
              const floor = top - drop
              const cx0 = x0 + i * cell,
                cz0 = z0 + j * cell
              // The floor slides under higher neighbours, never past the parent's sides.
              const under = (a: number, b: number) => (at(a, b) >= 0 && at(a, b) < drop ? SEAM : 0)
              const fx0 = cx0 - under(i - 1, j),
                fx1 = cx0 + cell + under(i + 1, j)
              const fz0 = cz0 - under(i, j - 1),
                fz1 = cz0 + cell + under(i, j + 1)
              emit(2, (fx0 + fx1) / 2, floor, (fz0 + fz1) / 2, fx1 - fx0, 0, fz1 - fz0, chipFloor)
              const open = required(through[i + j * n])
              for (const [di, dj, face, side] of NEIGHBOURS) {
                const other = at(i + di, j + dj)
                // Inside the grid a wall rises to a higher neighbour; on the parent's boundary
                // it closes a side the chip does not open through.
                const wallTop =
                  other < 0 ? ((open >> side) & 1 ? null : top) : other < drop ? top - other : null
                if (wallTop === null) continue
                const y0 = floor - SEAM
                if (di !== 0) {
                  const x = di > 0 ? cx0 + cell : cx0
                  emit(
                    face,
                    x,
                    (y0 + wallTop) / 2,
                    cz0 + cell / 2,
                    0,
                    wallTop - y0,
                    cell,
                    footColor,
                    lipColor,
                  )
                } else {
                  const z = dj > 0 ? cz0 + cell : cz0
                  emit(
                    face,
                    cx0 + cell / 2,
                    (y0 + wallTop) / 2,
                    z,
                    cell,
                    wallTop - y0,
                    0,
                    footColor,
                    lipColor,
                  )
                }
              }
            }
        }
      }
      faces.forEach((buffer, face) => {
        if (!buffer.vertices) return
        const batch = buffer.finish()
        batches.push({ material, face, ...batch, bounds: prepareGeometryBounds(batch.positions) })
      })
    }
  }
  const shadowMatrices = prepareShadowMatrices(world)
  return {
    batches,
    shadowMatrices,
    index,
    totalFaces: world.voxels.length * 6,
    exposedFaces,
    lipCells: lipCount,
    chips: chipCount,
    fills: fillCount,
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

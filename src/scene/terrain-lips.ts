import { required } from '../invariant'
import { WATER_LEVEL } from './lake-bed'
import { overlappingVoxels } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'

/** A micro-voxel: centre, full extents and the BoxGeometry faces it should not emit. */
export type LipCell = {
  center: [number, number, number]
  extent: [number, number, number]
  kind: 'turf' | 'pebble'
  /** Value multiplier applied to the turf or pebble colour, about 0.8–1.05. */
  shade: number
  /** BoxGeometry face indices hidden against the parent voxel or the ground. */
  hidden: readonly number[]
}

/** Voxels larger than this are distant enough that a micro-cell would be under a pixel. */
const MAX_PARENT = 0.3
/** Past this depth a 6 cm cell spans only a few pixels from the default camera, so lips take
 * cells of half a voxel instead, and far fewer of them: most of the terrain's lips lie out
 * there, and dressing them all at the near density would add half a million triangles. */
const THIN_Z = -12
/** Side faces in BoxGeometry order with their horizontal axis and outward sign. */
const SIDES = [
  { face: 0, axis: 0, sign: 1 },
  { face: 1, axis: 0, sign: -1 },
  { face: 4, axis: 2, sign: 1 },
  { face: 5, axis: 2, sign: -1 },
] as const

/** Unit hash of a micro-cell lattice position and a salt, shared by every micro-voxel layer. */
export const cellHash = (a: number, b: number, c: number) => {
  let n = Math.imul((a | 0) + 0x9e37, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a, 0xc2b2ae35)
  n = Math.imul(n ^ (n >>> 15) ^ Math.imul(c | 0, 0x27d4eb2f), 0x165667b1)
  return ((n ^ (n >>> 13)) >>> 0) / 0x1_0000_0000
}

/** Micro-cell edge: about 6 cm near the camera (half a foreground voxel, a quarter of a
 * mid-ground one), half a voxel past `THIN_Z`. */
export function lipCellSize(parent: number, z: number) {
  return parent > 0.2 && z > THIN_Z ? parent / 4 : parent / 2
}

/**
 * Last Signal's steps never end on a ruled edge: turf spills over the lip in single micro-voxels,
 * a few hang one cell lower, and fallen stones collect at the foot of the next riser. Given a
 * mossy ground voxel whose top is exposed, this returns those cells. They are render-only (no
 * collision, no shadow casting), stay attached to their parent and avoid every other solid.
 */
export function lipCells(
  index: VoxelIndex,
  id: number,
  voxel: Voxel,
  visible: readonly boolean[],
  /** Dress mid-ground lips too; mobile keeps only the foreground's. */
  midground = true,
  /** Slots whose column was chipped away (see terrain-erosion.ts), by side index and slot. */
  dropped?: (side: number, slot: number) => boolean,
): LipCell[] {
  const s = voxel.size
  const top = voxel.y + s / 2
  const far = voxel.z <= THIN_Z
  if (s > MAX_PARENT || (far && !midground) || !visible[2] || top < WATER_LEVEL + 0.05) return []
  const m = lipCellSize(s, voxel.z)
  const slots = Math.round(s / m)
  const centre = [voxel.x, voxel.y, voxel.z]
  // Hashes key on the integer micro-cell lattice so neighbouring voxels never repeat a pattern.
  const gx = Math.round(voxel.x / m),
    gz = Math.round(voxel.z / m)
  const cells: LipCell[] = []
  const query = [0, 0, 0, 0, 0, 0]
  let hit = false
  const visitOther = (other: number) => {
    if (other !== id) hit = true
  }
  /** Adds a cell unless the part beyond `plane` (the overhang) meets another solid. */
  const place = (axis: number, sign: number, plane: number, cell: LipCell, test: boolean) => {
    if (test) {
      for (let a = 0; a < 3; a++) {
        query[a] = required(cell.center[a]) - required(cell.extent[a]) / 2
        query[a + 3] = required(cell.center[a]) + required(cell.extent[a]) / 2
      }
      // Only the overhanging part may meet another solid; the rest sits inside the parent.
      query[sign > 0 ? axis : axis + 3] = plane + sign * 1e-4
      hit = false
      overlappingVoxels(index, query, visitOther)
      if (hit) return false
    }
    cells.push(cell)
    return true
  }
  for (const [side, { face, axis, sign }] of SIDES.entries()) {
    const tangent = axis === 0 ? 2 : 0
    const plane = required(centre[axis]) + (sign * s) / 2
    const start = required(centre[tangent]) - s / 2
    const box = (normal: number, along: number, y: number, d: number, w: number, h: number) => {
      const center: [number, number, number] = [0, y, 0]
      const extent: [number, number, number] = [0, h, 0]
      center[axis] = normal
      center[tangent] = along
      extent[axis] = d
      extent[tangent] = w
      return { center, extent }
    }
    if (visible[face]) {
      // A riser drops away from this edge: turf overhangs it.
      for (let k = 0; k < slots; k++) {
        const salt = face * 8 + k
        if (cellHash(gx, gz, salt) < (far ? 0.78 : 0.4) || dropped?.(side, k)) continue
        const out = m * (0.3 + 0.45 * cellHash(gx, gz, salt + 101))
        const width = m * (0.8 + 0.2 * cellHash(gx, gz, salt + 211))
        const height = m * (0.7 + 0.5 * cellHash(gx, gz, salt + 307))
        // Never flush with the parent top, which would z-fight with it.
        const lift = m * (0.06 + 0.18 * cellHash(gx, gz, salt + 401))
        const along = start + (k + 0.5) * m
        const cy = top + lift - height / 2
        const tuft = {
          ...box(plane + sign * (out - m / 2), along, cy, m, width, height),
          kind: 'turf' as const,
          shade: 0.85 + 0.2 * cellHash(gx, gz, salt + 503),
          hidden: [face ^ 1],
        }
        // Some tufts trail a smaller cell one step lower, so the lip line breaks vertically too.
        if (!place(axis, sign, plane, tuft, true) || cellHash(gx, gz, salt + 601) >= 0.35) continue
        const hang = m * (0.45 + 0.35 * cellHash(gx, gz, salt + 701))
        place(
          axis,
          sign,
          plane,
          {
            ...box(
              plane + sign * (out * 0.7 - m / 2),
              along,
              cy - height / 2 - hang / 2,
              m,
              width * 0.75,
              hang,
            ),
            kind: 'turf',
            shade: 0.75,
            hidden: [face ^ 1],
          },
          true,
        )
      }
      continue
    }
    // Draw the stones before probing: the probe is the costly part, and most edges get none.
    let stones = 0
    for (let k = 0; k < slots; k++)
      if (cellHash(gx, gz, 64 + face * 8 + k) >= (far ? 0.9 : 0.72) && !dropped?.(side, k))
        stones |= 1 << k
    if (!stones) continue
    // Only where the next step rises from this edge does a stone rest against its foot.
    query[axis] = query[axis + 3] = plane + (sign * m) / 2
    query[tangent] = query[tangent + 3] = required(centre[tangent])
    query[1] = query[4] = top + m / 2
    hit = false
    overlappingVoxels(index, query, visitOther)
    if (!hit) continue
    for (let k = 0; k < slots; k++) {
      if (!(stones & (1 << k))) continue
      const salt = 64 + face * 8 + k
      const width = m * (0.55 + 0.4 * cellHash(gx, gz, salt + 101))
      const depth = m * (0.5 + 0.4 * cellHash(gx, gz, salt + 211))
      const height = m * (0.35 + 0.35 * cellHash(gx, gz, salt + 307))
      place(
        axis,
        sign,
        plane,
        {
          ...box(
            plane - (sign * depth) / 2,
            start + (k + 0.5) * m,
            top + height * 0.4,
            depth,
            width,
            height,
          ),
          kind: 'pebble',
          shade: 0.8 + 0.25 * cellHash(gx, gz, salt + 401),
          hidden: [3, face],
        },
        false,
      )
    }
  }
  return cells
}

import { required } from '../invariant'
import { WATER_LEVEL } from './lake-bed'
import { cellHash, lipCellSize } from './terrain-lips'
import { overlappingVoxels } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'

/**
 * Micro-voxel chips cut into the top edges of a terrain voxel. The top splits into an n × n grid
 * of micro columns; a column touching an open side may drop by one or two cells, so the step
 * edge reads as eroded micro-voxels rather than a ruled line. `depth` holds each column's drop in
 * metres, x-major rows (`i + j * n`, i along +x, j along +z), 0 where the column is intact.
 */
export type Erosion = {
  cell: number
  n: number
  depth: Float64Array
  /** Per column, the SIDES (bit k for SIDES[k]) its drop opens through the parent's riser.
   * A dropped column's other boundary sides are closed by a wall of its own. */
  through: Uint8Array
  chips: number
  /** Micro-columns heaped against the foot of a riser that rises from this top. */
  fills: Fill[]
  /** Per column, 1 where a fill stands on it. */
  filled: Uint8Array
}

/** A render-only micro-column: centre, full extents, shade and the faces it hides. */
export type Fill = {
  /** Scree against a riser shows cut earth; a loose block on stone is the stone itself. */
  kind: 'scree' | 'rubble'
  center: [number, number, number]
  extent: [number, number, number]
  shade: number
  /** BoxGeometry faces against the parent top and the riser behind it. */
  hidden: number[]
}

export type ErosionDensity = {
  /** Chance that a column touching an open side drops. */
  chance: number
  /** Share of drops two cells deep where the grid has room for it. */
  deep: number
  /** Chance that a column at the foot of a rising riser gets a fill. */
  fill: number
  /** Chance that any other column of a stone top carries a loose block. */
  rubble: number
}

/** Last Signal's distant hills keep their micro-voxels: a far voxel (50 cm) still splits into
 * 12.5 cm columns, a few pixels each from the default camera, enough to notch the crests. A
 * phone's far voxel splits in two only: fewer, larger notches for the same silhouette. */
export function erosionCellSize(size: number, z: number, desktop = true) {
  return size > 0.3 ? size / (desktop ? 4 : 2) : lipCellSize(size, z)
}

/**
 * Densities by band. Far crests and the mid-ground hills take the most chips and fills: there a
 * step is one or two cells high, and the denser the micro-steps, the less the slope reads as a
 * staircase of whole voxels. Mobile keeps lighter densities and no deep chips.
 */
export function erosionDensity(
  size: number,
  z: number,
  desktop: boolean,
  stone: boolean,
): ErosionDensity {
  const rubble = (chance: number) => (stone ? chance : 0)
  if (z > 2) return { chance: 0.34, deep: 0, fill: 0.3, rubble: rubble(0.06) }
  if (size > 0.3)
    return desktop
      ? { chance: 0.6, deep: 0.4, fill: 0.55, rubble: 0 }
      : { chance: 0.3, deep: 0, fill: 0.2, rubble: 0 }
  if (z > -12)
    return desktop
      ? { chance: 0.45, deep: 0.3, fill: 0.4, rubble: rubble(0.16) }
      : { chance: 0.35, deep: 0, fill: 0.3, rubble: rubble(0.12) }
  return desktop
    ? { chance: 0.6, deep: 0, fill: 0.55, rubble: rubble(0.1) }
    : { chance: 0.2, deep: 0, fill: 0.14, rubble: 0 }
}

/** Lowest chip floor: clear of waves and the lake's contact foam on the shore. */
export const CHIP_FLOOR_MIN = WATER_LEVEL + 0.2

/** Side faces with their axis and outward sign, BoxGeometry order. */
const SIDES = [
  { face: 0, axis: 0, sign: 1 },
  { face: 1, axis: 0, sign: -1 },
  { face: 4, axis: 2, sign: 1 },
  { face: 5, axis: 2, sign: -1 },
] as const

// Scratch for the largest grid (4 × 4); results are copied out only when a voxel erodes.
const scratchDepth = new Float64Array(16)
const scratchThrough = new Uint8Array(16)
const scratchFilled = new Uint8Array(16)
const scratchQuery = [0, 0, 0, 0, 0, 0]
const scratchBox = [0, 0, 0, 0, 0, 0]

/** Sides of the grid a column touches, as SIDES indices. */
function touching(i: number, j: number, n: number) {
  let mask = 0
  if (i === n - 1) mask |= 1
  if (i === 0) mask |= 2
  if (j === n - 1) mask |= 4
  if (j === 0) mask |= 8
  return mask
}

/**
 * Chooses the chips for a voxel whose top is exposed. A column drops only if nothing covers it
 * and at least one of the parent sides it touches is clear over the dropped height, so a chip
 * never opens into another solid; sides it touches that are not clear get a wall of their own
 * when meshed. Chips are render-only: collision, shadows and picking keep the full voxel.
 */
export function erodeTop(
  index: VoxelIndex,
  /** Every other solid touching the voxel, as gathered by `exposedVoxelFaces`. */
  nearby: readonly number[],
  voxel: Voxel,
  visible: readonly boolean[],
  density: ErosionDensity,
  desktop = true,
  /** SIDES (bit k for SIDES[k]) facing away from the main camera, see `awaySides`. */
  away = 0b1111,
  /** Highest eye of the main camera: below it, chips may not open through `away` sides. */
  eyeHeight = -Infinity,
): Erosion | null {
  if (!visible[2]) return null
  const s = Math.fround(voxel.size)
  const m = erosionCellSize(voxel.size, voxel.z, desktop)
  const n = Math.round(s / m)
  const top = Math.fround(voxel.y) + s / 2
  if (n < 2 || top < WATER_LEVEL) return null
  const x0 = Math.fround(voxel.x) - s / 2,
    z0 = Math.fround(voxel.z) - s / 2
  const gx = Math.round(x0 / m),
    gz = Math.round(z0 / m)
  const depth = scratchDepth.fill(0, 0, n * n)
  const through = scratchThrough.fill(0, 0, n * n)
  const filled = scratchFilled.fill(0, 0, n * n)
  let open = 0
  for (let k = 0; k < 4; k++) if (visible[required(SIDES[k]).face]) open |= 1 << k
  // A chip opening through a side that faces away from the camera is never seen as a notch in
  // a riser, only as a slot along the line of sight over the step. Below eye level that slot
  // frames whatever lies beyond the crest, usually the bright lake, and reads as a hole; above
  // it, the slot frames the sky and notches the crest, which is the point.
  if (top < eyeHeight) open &= ~away
  const query = scratchQuery
  const boxes = index.boxes
  // Chip probes stay within a hair of the voxel, so the solids touching it are the only ones
  // they can meet. Fills reach a few cells above the top, where a solid need not touch the
  // voxel (a rock ledge sits lower than the grid), so they gather that space once, on demand.
  let above: number[] | undefined
  const probeAbove = (box: readonly number[]) => {
    if (!above) {
      const found: number[] = (above = [])
      overlappingVoxels(
        index,
        // Starting a hair above the top leaves out the voxel itself.
        [x0 - 2e-3, top + 1e-5, z0 - 2e-3, x0 + s + 2e-3, top + 3 * m, z0 + s + 2e-3],
        (other) => {
          found.push(other)
        },
      )
    }
    return probe(box, above)
  }
  const probe = (box: readonly number[], solids: readonly number[] = nearby) => {
    for (const other of solids) {
      const b = other * 6
      if (
        required(boxes[b]) <= required(box[3]) &&
        required(boxes[b + 3]) >= required(box[0]) &&
        required(boxes[b + 1]) <= required(box[4]) &&
        required(boxes[b + 4]) >= required(box[1]) &&
        required(boxes[b + 2]) <= required(box[5]) &&
        required(boxes[b + 5]) >= required(box[2])
      )
        return true
    }
    return false
  }
  let chips = 0
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const sides = touching(i, j, n)
      if (!sides) continue
      if (!(sides & open) || cellHash(gx + i, gz + j, 911) >= density.chance) continue
      const drop = m * (n >= 4 && cellHash(gx + i, gz + j, 919) < density.deep ? 2 : 1)
      // A floor at the waterline would fill with the lake's contact foam.
      if (top - drop < CHIP_FLOOR_MIN) continue
      const cx0 = x0 + i * m,
        cz0 = z0 + j * m
      // Nothing may rest on, or overlap, the part of the column that drops.
      query[0] = cx0 + 1e-4
      query[2] = cz0 + 1e-4
      query[3] = cx0 + m - 1e-4
      query[5] = cz0 + m - 1e-4
      query[1] = top - drop + 1e-4
      query[4] = top + 1e-3
      if (probe(query)) continue
      // At least one touched side must be clear just outside the parent over the drop.
      let clear = 0
      for (let k = 0; k < 4; k++) {
        if (!(sides & open & (1 << k))) continue
        const { axis, sign } = required(SIDES[k])
        const plane = (axis === 0 ? x0 : z0) + (sign > 0 ? s : 0)
        const box = scratchBox
        box[0] = cx0 + 1e-4
        box[1] = top - drop + 1e-4
        box[2] = cz0 + 1e-4
        box[3] = cx0 + m - 1e-4
        box[4] = top - 1e-4
        box[5] = cz0 + m - 1e-4
        box[axis] = sign > 0 ? plane : plane - 1e-3
        box[axis + 3] = sign > 0 ? plane + 1e-3 : plane
        if (probe(box)) continue
        clear |= 1 << k
      }
      if (!clear) continue
      // Neighbouring chips must open through a common side: two chips opening through
      // opposite sides of a thin voxel would join into a slot that shows the sky through a hill.
      if (
        (i > 0 && depth[i - 1 + j * n] && !(required(through[i - 1 + j * n]) & clear)) ||
        (j > 0 && depth[i + (j - 1) * n] && !(required(through[i + (j - 1) * n]) & clear))
      )
        continue
      depth[i + j * n] = drop
      through[i + j * n] = clear
      chips++
    }
  // Scree: a micro-column heaped against a riser that rises from this top, one or two cells
  // high, so the inner corner of a step fills in as the outer one wears away.
  const fills: Fill[] = []
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      // A side may be exposed lower down and still have a neighbour rising above this top. Only
      // sides facing away from the camera qualify: there the riser behind the fill faces the
      // camera, while a fill against a riser facing away would hide behind its own step.
      const sides = touching(i, j, n) & away
      if (!sides || depth[i + j * n] || cellHash(gx + i, gz + j, 929) >= density.fill) continue
      const h = m * (n >= 4 && cellHash(gx + i, gz + j, 937) < 0.35 ? 2 : 1)
      const cx0 = x0 + i * m,
        cz0 = z0 + j * m
      const hidden = [3]
      for (let k = 0; k < 4; k++) {
        if (!(sides & (1 << k))) continue
        const { face, axis, sign } = required(SIDES[k])
        const plane = (axis === 0 ? x0 : z0) + (sign > 0 ? s : 0)
        // The neighbour across this side must stand at least a cell above the fill's top.
        const y = top + h + m * 0.5
        const box = scratchBox
        box[0] = box[3] = cx0 + m / 2
        box[1] = box[4] = y
        box[2] = box[5] = cz0 + m / 2
        box[axis] = box[axis + 3] = plane + sign * 1e-3
        if (probeAbove(box)) hidden.push(face)
      }
      if (hidden.length === 1) continue
      // The column itself must be free; touching the riser behind it is fine.
      if (probeAbove([cx0 + 1e-4, top + 1e-4, cz0 + 1e-4, cx0 + m - 1e-4, top + h, cz0 + m - 1e-4]))
        continue
      filled[i + j * n] = 1
      fills.push({
        kind: 'scree',
        center: [cx0 + m / 2, top + h / 2, cz0 + m / 2],
        extent: [m, h, m],
        shade: 0.82 + 0.18 * cellHash(gx + i, gz + j, 941),
        hidden,
      })
    }
  // Loose blocks on stone: a single micro-cell, a half to a whole cell high, on any free column.
  if (density.rubble > 0)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (depth[i + j * n] || filled[i + j * n]) continue
        if (cellHash(gx + i, gz + j, 947) >= density.rubble) continue
        const h = m * (0.45 + 0.5 * cellHash(gx + i, gz + j, 953))
        const cx0 = x0 + i * m,
          cz0 = z0 + j * m
        if (
          probeAbove([cx0 + 1e-4, top + 1e-4, cz0 + 1e-4, cx0 + m - 1e-4, top + h, cz0 + m - 1e-4])
        )
          continue
        filled[i + j * n] = 1
        fills.push({
          kind: 'rubble',
          center: [cx0 + m / 2, top + h / 2, cz0 + m / 2],
          extent: [m, h, m],
          shade: 0.9 + 0.2 * cellHash(gx + i, gz + j, 959),
          hidden: [3],
        })
      }
  if (!chips && !fills.length) return null
  return {
    cell: m,
    n,
    depth: depth.slice(0, n * n),
    through: through.slice(0, n * n),
    chips,
    fills,
    filled: filled.slice(0, n * n),
  }
}

/** Sides of a voxel, as a SIDES mask, that face away from every eye within the given bounds. */
export function awaySides(voxel: Voxel, nearest: readonly number[], farthest: readonly number[]) {
  const s = Math.fround(voxel.size)
  let mask = 0
  for (let k = 0; k < 4; k++) {
    const { axis, sign } = required(SIDES[k])
    const plane = Math.fround(axis === 0 ? voxel.x : voxel.z) + (sign * s) / 2
    if (sign > 0 ? required(farthest[axis]) <= plane : required(nearest[axis]) >= plane)
      mask |= 1 << k
  }
  return mask
}

/** How far the riser of SIDES[side] drops at slot `k`, counted from the low tangent end. */
export function riserDrop(erosion: Erosion, side: number, k: number) {
  const { n, depth, through } = erosion
  const i = side === 0 ? n - 1 : side === 1 ? 0 : k
  const j = side === 2 ? n - 1 : side === 3 ? 0 : k
  return (required(through[i + j * n]) >> side) & 1 ? required(depth[i + j * n]) : 0
}

/** Whether the column under slot `k` of SIDES[side] dropped or carries a fill, so no other
 * micro-voxel should sit on it. */
export function slotTaken(erosion: Erosion, side: number, k: number) {
  const { n, depth, filled } = erosion
  const i = side === 0 ? n - 1 : side === 1 ? 0 : k
  const j = side === 2 ? n - 1 : side === 3 ? 0 : k
  return required(depth[i + j * n]) > 0 || required(filled[i + j * n]) > 0
}

export { SIDES as EROSION_SIDES }

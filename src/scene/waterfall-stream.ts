import { latticeHash as hash } from './hash'
import { mix, smoothstep } from './math'
import type { ProtectedArea, TerrainGrid } from './terrain-field'

/**
 * The stream that feeds the waterfall's pool: a spring among rocks on higher ground, a channel
 * cut down to the pool's tail, then the pool spills over the lip. Pure and deterministic, so the
 * world worker carves it into the composed corners and the renderer draws its ribbon.
 */
export type WaterfallStream = Readonly<{
  /** Water surface along the channel, downstream: from the spring to inside the pool. */
  /** `shown` is 0 where the camera would only glimpse the water in slivers over the ground. */
  points: readonly Readonly<{ x: number; y: number; z: number; shown: number }>[]
  /** Width of the flowing water. */
  width: number
}>

type Shape = Readonly<{
  /** Half-width of the channel's level bed. */
  bed: number
  /** The bank wall rises over this distance beyond the bed. */
  wall: number
  /** Water depth over the bed. */
  depth: number
  /** Bank crest above the water. */
  bank: number
  /** The channel's shoulders stand this much above the crest, fading out at `reach`. */
  shoulder: number
  reach: number
  length: number
  rise: number
  /** Highest the spring may sit above the pool, where the ground itself is high. */
  maxRise: number
}>

const streamShape = (mobile: boolean): Shape =>
  mobile
    ? {
        bed: 0.16,
        wall: 0.28,
        depth: 0.08,
        bank: 0.16,
        shoulder: 0.3,
        reach: 1.8,
        length: 4,
        rise: 0.85,
        maxRise: 1.3,
      }
    : {
        bed: 0.2,
        wall: 0.3,
        depth: 0.1,
        bank: 0.2,
        shoulder: 0.35,
        reach: 2.4,
        length: 6,
        rise: 1.15,
        maxRise: 1.7,
      }

type Fall = Readonly<{
  x: number
  z: number
  top: number
  direction: readonly [number, number]
  basin: readonly Readonly<{ x: number; z: number; size: number }>[]
}>

type Ground = Readonly<{ grid: TerrainGrid; heights: Float32Array }>

/** Lowest composed corner within a radius; NaN when any corner there is water or off the grid. */
function cornerMin(ground: Ground, x: number, z: number, radius: number) {
  const { grid, heights } = ground
  const c0 = Math.ceil((x - radius - grid.minX) / grid.cell),
    c1 = Math.floor((x + radius - grid.minX) / grid.cell)
  const r0 = Math.ceil((z - radius - grid.minZ) / grid.cell),
    r1 = Math.floor((z + radius - grid.minZ) / grid.cell)
  let low = Infinity
  for (let row = r0; row <= r1; row++)
    for (let column = c0; column <= c1; column++) {
      if (row < 0 || column < 0 || row >= grid.rows || column >= grid.columns) return Number.NaN
      const h = heights[row * grid.columns + column] ?? Number.NaN
      if (Number.isNaN(h)) return Number.NaN
      if (
        (column * grid.cell + grid.minX - x) ** 2 + (row * grid.cell + grid.minZ - z) ** 2 >
        radius * radius
      )
        continue
      low = Math.min(low, h)
    }
  return Number.isFinite(low) ? low : Number.NaN
}

/** The nearest composed corner; NaN over water or off the grid. */
function cornerAt(ground: Ground, x: number, z: number) {
  const { grid, heights } = ground
  const column = Math.round((x - grid.minX) / grid.cell),
    row = Math.round((z - grid.minZ) / grid.cell)
  if (row < 0 || column < 0 || row >= grid.rows || column >= grid.columns) return Number.NaN
  return heights[row * grid.columns + column] ?? Number.NaN
}

/** How far behind the lip the pool reaches, along the fall's axis. */
function poolDepth(fall: Fall) {
  const [nx, nz] = fall.direction
  let depth = 0
  for (const cell of fall.basin)
    depth = Math.max(depth, -((cell.x - fall.x) * nx + (cell.z - fall.z) * nz))
  return depth
}

/**
 * Trace the stream upstream from the pool. Its first half runs straight away from the camera,
 * so the viewer looks up the channel past the lip; the upper half may curl aside, out of view
 * behind the bank. Each course must stay on land clear of the shore and of lanterns; the one
 * closest to that line wins, shortened where the land runs out. The water climbs steadily
 * upstream, deeper into the ground where it is high, so it always runs downhill to the pool.
 */
export function traceStream(
  ground: Ground,
  fall: Fall,
  seed: number,
  mobile: boolean,
  avoid: readonly Readonly<{ x: number; z: number }>[],
  camera: readonly [number, number, number] = [0, 2.5, 16],
): WaterfallStream {
  const shape = streamShape(mobile)
  const [nx, nz] = fall.direction
  const step = ground.grid.cell
  const inPool = (x: number, z: number) =>
    fall.basin.some(
      (cell) => Math.abs(x - cell.x) <= cell.size / 2 && Math.abs(z - cell.z) <= cell.size / 2,
    )
  let startX = 0,
    startZ = 0
  for (const cell of fall.basin) {
    startX += cell.x / fall.basin.length
    startZ += cell.z / fall.basin.length
  }
  if (fall.basin.length === 0) {
    startX = fall.x - nx * step
    startZ = fall.z - nz * step
  }
  // Upstream is the back of the lip, -n, turned by a heading about the vertical; the heading
  // that points straight away from the camera aligns the channel with the line of sight.
  const viewX = startX - camera[0],
    viewZ = startZ - camera[2]
  const viewLength = Math.hypot(viewX, viewZ) || 1
  const awayX = -viewX / viewLength,
    awayZ = -viewZ / viewLength
  const aligned = Math.atan2(nx * awayZ - nz * awayX, nx * awayX + nz * awayZ)
  const margin = shape.bed + shape.wall + 0.25
  type Course = { points: { x: number; z: number; ground: number }[]; score: number }
  const trace = (bend: number, curl: number, length: number): Course | null => {
    const points: Course['points'] = []
    let x = startX,
      z = startZ
    let s = 0
    const count = Math.max(2, Math.ceil(length / step))
    // March out of the pool first; the course starts at its last point inside.
    for (let guard = 0; guard < 64; guard++) {
      const cos = Math.cos(bend),
        sin = Math.sin(bend)
      const ux = -(nx * cos - nz * sin),
        uz = -(nx * sin + nz * cos)
      if (!inPool(x + ux * step * 0.5, z + uz * step * 0.5)) break
      x += ux * step * 0.5
      z += uz * step * 0.5
    }
    for (let i = 0; i <= count; i++) {
      if (i > 0) {
        s = (i / count) * length
        const heading = bend + curl * Math.max(0, s / length - 0.5) * 2
        const cos = Math.cos(heading),
          sin = Math.sin(heading)
        x -= (nx * cos - nz * sin) * (length / count)
        z -= (nx * sin + nz * cos) * (length / count)
      }
      const h = cornerMin(ground, x, z, margin)
      if (i > 1 && !(h > 0.3)) return null
      if (avoid.some((area) => Math.hypot(area.x - x, area.z - z) < 1.2)) return null
      points.push({ x, z, ground: h })
    }
    // How much of the water the camera would see over the composed ground, the channel's own
    // cut aside, on a rising course.
    let seen = 0
    points.forEach((point, i) => {
      const y = fall.top + (shape.rise * i) / count
      const reach = Math.hypot(point.x - camera[0], point.z - camera[2])
      const samples = Math.ceil(reach / step)
      for (let k = Math.ceil(samples * 0.5); k < samples - 1; k++) {
        const t = k / samples
        const px = mix(camera[0], point.x, t),
          pz = mix(camera[2], point.z, t)
        const h = cornerAt(ground, px, pz)
        if (
          h > mix(camera[1], y, t) &&
          !inPool(px, pz) &&
          !points.some((other) => Math.hypot(other.x - px, other.z - pz) < shape.reach * 0.7)
        )
          return
      }
      seen++
    })
    const score =
      (seen / points.length) * 1.5 -
      Math.abs(bend - aligned) * 0.3 -
      Math.abs(curl) * 0.2 +
      hash(seed, Math.round(curl * 10), Math.round(bend * 10), 991) * 0.1
    return { points, score }
  }
  let best: Course | null = null
  for (const scale of [1, 0.75, 0.5, 0.3]) {
    for (const offset of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9])
      for (const curl of [0.6, -0.6, 0]) {
        const bend = Math.max(-1.4, Math.min(1.4, aligned + offset))
        const course = trace(bend, curl, shape.length * scale)
        if (course && (!best || course.score > best.score)) best = course
      }
    if (best) break
  }
  const course = best ?? {
    points: [
      { x: startX, z: startZ, ground: fall.top },
      { x: startX - nx * step * 2, z: startZ - nz * step * 2, ground: fall.top },
    ],
  }
  // Water level upstream: an easing climb, or deeper into higher ground, never falling.
  const lengths = [0]
  for (let i = 1; i < course.points.length; i++) {
    const a = course.points[i - 1],
      b = course.points[i]
    lengths.push((lengths.at(-1) ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0))
  }
  const length = lengths.at(-1) ?? 1
  let level = fall.top
  const upstream = course.points.map((point, i) => {
    const t = (lengths[i] ?? 0) / length
    const eased = fall.top + shape.rise * (length / shape.length) * t ** 1.3
    const buried = Number.isNaN(point.ground) ? -Infinity : point.ground - shape.bank - 0.15
    level = Math.max(level, Math.min(fall.top + shape.maxRise * t, Math.max(eased, buried)))
    return { x: point.x, y: level, z: point.z, shown: 1 }
  })
  return { points: upstream.toReversed(), width: 2 * (shape.bed + shape.wall * 0.5) }
}

/** Nearest point of the course: distance, and distance along it measured from the pool. */
function nearest(stream: WaterfallStream, x: number, z: number, camera: readonly [number, number]) {
  const points = stream.points
  let best = { distance: Infinity, along: 0, level: 0, beyond: false, facing: false }
  let travelled = 0
  // Points run downstream; walk them from the pool upstream.
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i],
      b = points[i - 1]
    if (!a || !b) continue
    const dx = b.x - a.x,
      dz = b.z - a.z
    const span = Math.hypot(dx, dz) || 1e-6
    const raw = ((x - a.x) * dx + (z - a.z) * dz) / (span * span)
    const t = Math.min(1, Math.max(0, raw))
    const distance = Math.hypot(x - a.x - dx * t, z - a.z - dz * t)
    if (distance < best.distance)
      best = {
        distance,
        along: travelled + span * t,
        level: mix(a.y, b.y, t),
        // Past the spring by more than a cell.
        beyond: i === 1 && (raw - 1) * span > 0.3,
        // On the camera's side of the course.
        facing:
          Math.sign(dx * (z - a.z) - dz * (x - a.x)) ===
          Math.sign(dx * (camera[1] - a.z) - dz * (camera[0] - a.x)),
      }
    travelled += span
  }
  return best
}

/**
 * Cut the channel into the composed corners and raise its banks: a level bed under the water,
 * walls up to a crest just above it, and shoulders that fade back into the ground, so the
 * spring sits in a notch of higher ground. Pool corners, the lip and the shore are left alone.
 */
export function applyStream(
  ground: Ground,
  fall: Fall,
  stream: WaterfallStream,
  mobile: boolean,
  camera: readonly [number, number, number] = [0, 2.5, 16],
) {
  const { grid, heights } = ground
  const shape = streamShape(mobile)
  const [nx, nz] = fall.direction
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity
  for (const point of stream.points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
  }
  const c0 = Math.max(0, Math.floor((minX - shape.reach - grid.minX) / grid.cell)),
    c1 = Math.min(grid.columns - 1, Math.ceil((maxX + shape.reach - grid.minX) / grid.cell))
  const r0 = Math.max(0, Math.floor((minZ - shape.reach - grid.minZ) / grid.cell)),
    r1 = Math.min(grid.rows - 1, Math.ceil((maxZ + shape.reach - grid.minZ) / grid.cell))
  const back = poolDepth(fall)
  for (let row = r0; row <= r1; row++)
    for (let column = c0; column <= c1; column++) {
      const i = row * grid.columns + column
      const h = heights[i] ?? Number.NaN
      // Water and the low shore keep their contour.
      if (!(h > 0.3)) continue
      const x = grid.minX + column * grid.cell,
        z = grid.minZ + row * grid.cell
      // The lip and the face under it stay as carved.
      if ((x - fall.x) * nx + (z - fall.z) * nz > -Math.min(back * 0.5, 0.6)) continue
      const near = nearest(stream, x, z, [camera[0], camera[2]])
      if (near.distance > shape.reach) continue
      const bed = near.level - shape.depth
      const pool = fall.basin.some(
        (cell) =>
          Math.abs(x - cell.x) <= cell.size / 2 + 1e-6 &&
          Math.abs(z - cell.z) <= cell.size / 2 + 1e-6,
      )
      const fade = 1 - smoothstep(shape.bed + shape.wall, shape.reach, near.distance)
      // Shoulders rise behind the channel; on the camera's side the bank is cut down (or built
      // up, where the ground dips) to just above the water, so the viewer sees the stream over
      // it and never under it.
      const outer = near.facing
        ? mix(h, near.level + shape.bank * 0.6, fade)
        : Math.max(h, mix(h, near.level + shape.bank + shape.shoulder, fade))
      // The spring's head is closed: no bed past the course's upstream end.
      const wall = near.beyond
        ? Math.max(h, near.level + shape.bank)
        : mix(bed, outer, smoothstep(shape.bed, shape.bed + shape.wall, near.distance))
      const next = near.beyond ? Math.max(outer, wall) : wall
      heights[i] = pool ? Math.min(h, next) : next
    }
}

/** The channel and its cut banks keep their composed profile through smoothing. */
export function streamProtection(stream: WaterfallStream, mobile: boolean): ProtectedArea[] {
  const shape = streamShape(mobile)
  const protect: ProtectedArea[] = []
  const points = stream.points
  for (let i = 0; i < points.length; i += 2) {
    const point = points[i]
    if (point) protect.push({ x: point.x, z: point.z, radius: shape.reach * 0.6 })
  }
  return protect
}

/** The bank must stand this far out from the ribbon's centre line, and this much above it. */
export const STREAM_BANK_REACH = 0.15
export const STREAM_CLEARANCE = 0.02

/**
 * Keep only the reach of the stream the final ground actually holds, from the pool upstream:
 * over each point the bed lies under the water and both banks stand above it. At the first
 * point that fails, the ribbon stops; upstream of it the channel stays a dry gully.
 */
export function fitStream(
  stream: WaterfallStream,
  fall: Fall,
  height: (x: number, z: number) => number,
  camera: readonly [number, number, number] = [0, 2.5, 16],
): WaterfallStream {
  const points = stream.points
  const inPool = (x: number, z: number) =>
    fall.basin.some(
      (cell) =>
        Math.abs(x - cell.x) <= cell.size / 2 + 1e-6 &&
        Math.abs(z - cell.z) <= cell.size / 2 + 1e-6,
    )
  let first = points.length - 1
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    if (!point) break
    const before = points[Math.max(0, i - 1)] ?? point,
      after = points[Math.min(points.length - 1, i + 1)] ?? point
    const dx = after.x - before.x,
      dz = after.z - before.z
    const span = Math.hypot(dx, dz) || 1
    const reach = stream.width / 2 + STREAM_BANK_REACH
    let held = height(point.x, point.z) < point.y - STREAM_CLEARANCE
    for (const side of [-1, 1]) {
      const x = point.x + (dz / span) * reach * side,
        z = point.z - (dx / span) * reach * side
      if (!inPool(x, z) && !inPool(point.x, point.z) && height(x, z) < point.y + STREAM_CLEARANCE)
        held = false
    }
    if (!held) break
    first = i
  }
  // Where the line of sight grazes the ground in front of the channel, the water would show
  // through the ground's undulations as broken slivers; those reaches are hidden instead.
  const kept = points.slice(first)
  const reach = stream.width / 2 + STREAM_BANK_REACH + 0.3
  return {
    points: kept.map((point) => {
      const distance = Math.hypot(point.x - camera[0], point.z - camera[2])
      const samples = Math.ceil(distance / 0.1)
      let clearance = Infinity
      for (let k = 1; k < samples; k++) {
        const t = k / samples
        const x = mix(camera[0], point.x, t),
          z = mix(camera[2], point.z, t)
        if (kept.some((other) => Math.hypot(other.x - x, other.z - z) < reach)) continue
        clearance = Math.min(clearance, mix(camera[1], point.y, t) - height(x, z))
      }
      return {
        x: point.x,
        y: point.y,
        z: point.z,
        shown: clearance > STREAM_SIGHT_MARGIN ? 1 : 0,
      }
    }),
    width: stream.width,
  }
}

/** The ribbon shows only where the camera clears the ground in front by this much. */
const STREAM_SIGHT_MARGIN = 0.12

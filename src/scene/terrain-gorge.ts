import { WATER_LEVEL } from './lake-bed'
import type { WaterfallSite } from './lake-world'
import { clamp, smoothstep as smooth01 } from './math'
import { vertexNormals } from './terrain-boulders'
import type { PreparedBoulders } from './terrain-boulders'
import { sampleHeight } from './terrain-field'
import type { TerrainField } from './terrain-field'

/**
 * The rock face behind a waterfall. A heightfield has no vertices partway down a cliff, so the
 * face under the lip would be one planar slope; this lays a jointed granite wall over it: blocky
 * bulges, horizontal ledges and vertical joints, kept behind the falling sheet and tucked into
 * the ground at its sides and under the lip, wet where the spray reaches it. It shares the
 * boulders' material and merges into their mesh.
 */
export type GorgeMesh = Pick<PreparedBoulders, 'positions' | 'normals' | 'surface' | 'indices'>

function hash(seed: number, x: number, y: number) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d)
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39)
  return ((n ^ (n >>> 15)) >>> 0) / 0x1_0000_0000
}

/** Smooth value noise in [0, 1]. */
function noise(seed: number, x: number, y: number) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y)
  const tx = x - x0,
    ty = y - y0
  const sx = tx * tx * (3 - 2 * tx),
    sy = ty * ty * (3 - 2 * ty)
  const a = hash(seed, x0, y0),
    b = hash(seed, x0 + 1, y0),
    c = hash(seed, x0, y0 + 1),
    d = hash(seed, x0 + 1, y0 + 1)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** Vertex spacing round and down the face, metres. */
const STEP = 0.07

export function prepareGorge(field: TerrainField, fall: WaterfallSite | null): GorgeMesh {
  const empty: GorgeMesh = {
    positions: new Float32Array(0),
    normals: new Int8Array(0),
    surface: new Uint8Array(0),
    indices: new Uint32Array(0),
  }
  if (!fall) return empty
  const [nx, nz] = fall.direction
  const seed = fall.seed >>> 0
  const halfWidth = fall.width / 2
  // The wall wraps the block the fall leaves from: rays fan out in plan from a point behind the
  // lip, round its front and both flanks, and each column follows the cliff down that ray.
  const cx = fall.x - nx * 0.7,
    cz = fall.z - nz * 0.7
  const ray = (angle: number) => {
    const c = Math.cos(angle),
      s = Math.sin(angle)
    return [nx * c - nz * s, nz * c + nx * s] as const
  }
  const ground = (angle: number, r: number) => {
    const [dx, dz] = ray(angle)
    return sampleHeight(field, cx + dx * r, cz + dz * r)
  }
  // The sheet's front at height y: ballistic from the lip to the landing 0.8 m out.
  const sheet = (y: number) =>
    0.8 * Math.sqrt(clamp((fall.top - y) / (fall.top - WATER_LEVEL), 0, 1))
  // A column's crest: the bank just inside the cliff, before it drops.
  const crest = (angle: number) => {
    let top = -Infinity
    for (let r = 0.15; r <= 0.6; r += 0.05) top = Math.max(top, ground(angle, r))
    return top
  }
  // Angles where a real face stands, outward from straight ahead on both sides.
  const angleStep = STEP / 1.2
  const limit = (side: number) => {
    let angle = 0
    while (Math.abs(angle) < 2.6 && crest(angle + side * angleStep) > 0.55)
      angle += side * angleStep
    return angle
  }
  const from = limit(-1),
    to = limit(1)
  const columns = Math.max(2, Math.round((to - from) / angleStep) + 1)
  const bottom = WATER_LEVEL - 0.35
  const crests = Array.from({ length: columns }, (_, i) =>
    crest(from + ((to - from) * i) / (columns - 1)),
  )
  const rows = Math.max(2, Math.round((Math.max(...crests) - bottom) / STEP) + 1)

  const positions = new Float32Array(columns * rows * 3)
  const surface = new Uint8Array(columns * rows * 4)
  for (let column = 0; column < columns; column++) {
    const angle = from + ((to - from) * column) / (columns - 1)
    const [dx, dz] = ray(angle)
    const columnTop = (crests[column] ?? 0) - 0.03
    // Fade toward the fan's ends, where the cliff gives way to the bank.
    const end = Math.min(angle - from, to - angle) * 1.2
    for (let row = 0; row < rows; row++) {
      const v = row / (rows - 1)
      const y = bottom + (columnTop - bottom) * v
      // Where the ground crosses this height down the ray: the heightfield's own face.
      let face = 0.15
      while (face < 3 && ground(angle, face) >= y) face += 0.01
      // Granite: blocky bulges, horizontal ledges a hand or two high, vertical joints.
      const u = angle * 1.3
      const bulge = noise(seed, u * 2.4, y * 1.6)
      const bands = y / 0.38 + noise(seed + 1, u * 0.8, y * 0.5) * 0.6
      const ledge = smooth01(0.72, 0.95, bands - Math.floor(bands))
      const joint = 1 - smooth01(0.02, 0.07, Math.abs(noise(seed + 2, u * 3.3, y * 0.4) - 0.5))
      const grain = noise(seed + 3, u * 9, y * 9)
      let out = 0.02 + 0.09 * bulge + 0.04 * ledge - 0.05 * joint + 0.015 * grain
      // Tucked into the ground at the fan's ends and under the crest, so its edges never show.
      const keep = smooth01(0, 0.35, end)
      out = out * keep - 0.08 * (1 - keep)
      out = out * smooth01(1, 0.85, v) - 0.03 * smooth01(0.9, 1, v)
      let r = face + out
      // Behind the water the wall stays a hand's breadth clear of the sheet.
      const px = cx + dx * r - fall.x,
        pz = cz + dz * r - fall.z
      const along = px * nx + pz * nz
      const across = px * nz - pz * nx
      const behind = Math.abs(across) < halfWidth + 0.12
      const clear = sheet(y) - 0.1
      const forward = dx * nx + dz * nz
      if (behind && along > clear && forward > 0.2) r -= (along - clear) / forward
      const i = column * rows + row
      positions[i * 3] = cx + dx * r
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = cz + dz * r
      // Spray keeps the face behind and beside the sheet wet, most of all near the plunge.
      const spray =
        (1 - smooth01(halfWidth, halfWidth + 1, Math.abs(across))) *
        smooth01(-0.2, 0.3, forward) *
        (0.55 + 0.45 * (1 - v))
      surface[i * 4] = Math.round((0.32 + 0.25 * bulge) * 255)
      // Moss only on the dry upper part.
      surface[i * 4 + 1] = Math.round(clamp((v - 0.6) * 1.5 * (1 - spray), 0, 1) * 255)
      // No soil foot: the wall rises straight from the water.
      surface[i * 4 + 2] = 255
      surface[i * 4 + 3] = Math.round(clamp(spray, 0, 1) * 255)
    }
  }
  const indices: number[] = []
  for (let column = 0; column < columns - 1; column++)
    for (let row = 0; row < rows - 1; row++) {
      const a = column * rows + row,
        b = a + rows,
        c = a + 1,
        d = b + 1
      indices.push(a, b, c, b, d, c)
    }
  // Wind so the face looks toward the water.
  let facing = 0
  const normals = vertexNormals(positions, indices)
  for (let i = 0; i < normals.length; i += 3)
    facing += (normals[i] ?? 0) * nx + (normals[i + 2] ?? 0) * nz
  if (facing < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const b = indices[i + 1] ?? 0
      indices[i + 1] = indices[i + 2] ?? 0
      indices[i + 2] = b
    }
    for (let i = 0; i < normals.length; i++) normals[i] = -(normals[i] ?? 0)
  }
  return {
    positions,
    normals: Int8Array.from(normals, (value) => Math.round(value * 127)),
    surface,
    indices: Uint32Array.from(indices),
  }
}

/** `a` then `b` in one new typed array of their kind. */
function concat<T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(
  make: new (length: number) => T,
  a: T,
  b: T,
) {
  const out = new make(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** Append the gorge to the merged boulder mesh (render only; colliders keep the boulders). */
export function withGorge(boulders: PreparedBoulders, gorge: GorgeMesh): PreparedBoulders {
  if (!gorge.indices.length) return boulders
  const offset = boulders.positions.length / 3
  return {
    ...boulders,
    positions: concat(Float32Array, boulders.positions, gorge.positions),
    normals: concat(Int8Array, boulders.normals, gorge.normals),
    surface: concat(Uint8Array, boulders.surface, gorge.surface),
    indices: concat(
      Uint32Array,
      boulders.indices,
      Uint32Array.from(gorge.indices, (index) => index + offset),
    ),
  }
}

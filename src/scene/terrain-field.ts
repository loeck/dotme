import { WATER_LEVEL } from './lake-bed'

/**
 * The smooth, natural ground of the lake. The world generator (`lake-world.ts`) composes the
 * coast, islets, headlands and the waterfall's pool as heights on a regular grid of corners;
 * this shapes them into the final ground: open water continues down the lake bed's shelving
 * profile, a cliff-preserving filter smooths the composition, and gradient-damped relief gives
 * slopes their knobs and undulation while steep faces stay steep. Coordinates are Three.js
 * world coordinates (x right, y up, z depth).
 */
export type TerrainField = Readonly<{
  /** World position of corner (0, 0); rows advance along +z, columns along +x. */
  minX: number
  minZ: number
  cell: number
  columns: number
  rows: number
  /** Final ground height per corner; open water continues down a shelving bed. */
  heights: Float32Array
  /** 1 where the composition put land on the corner (after tiny specks became boulders). */
  land: Uint8Array
  /** 0..1 share of exposed rock the composition asked for, softly blurred. */
  rock: Float32Array
  /** 0..1 where the ground must stay exactly as composed (the waterfall's lip and pool). */
  locked: Float32Array
}>

/** A small stone in the water or on a bank: rendered as a boulder, not a bump. */
export type TerrainIsland = Readonly<{ x: number; z: number; top: number; extent: number }>

export type TerrainGrid = Readonly<{
  minX: number
  minZ: number
  cell: number
  columns: number
  rows: number
}>

/**
 * A circle where the composition constrains the smooth ground: `exact` keeps it as it is
 * (the waterfall's pool floor and lip), `raise` never lets the ground fall below them (the pool's
 * rim keeps its height while its outer sides still slope naturally), `water` keeps the ground
 * below the surface (the plunge in front of the fall stays open water).
 */
export type ProtectedArea = Readonly<{
  x: number
  z: number
  radius: number
  mode?: 'exact' | 'raise' | 'water'
}>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth01 = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

function hash(seed: number, x: number, z: number, stream: number) {
  let n =
    Math.imul(x | 0, 0x8da6b343) ^ Math.imul(z | 0, 0xd8163841) ^ Math.imul(stream, 0x9e3779b1)
  n = Math.imul(n ^ seed ^ (n >>> 13), 0x85ebca6b)
  n = Math.imul(n ^ (n >>> 16), 0xc2b2ae35)
  return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000
}

/** Smooth value noise in [-0.5, 0.5]. */
function valueNoise(seed: number, x: number, z: number, stream: number) {
  const x0 = Math.floor(x),
    z0 = Math.floor(z)
  const tx = x - x0,
    tz = z - z0
  const sx = tx * tx * (3 - 2 * tx),
    sz = tz * tz * (3 - 2 * tz)
  const a = hash(seed, x0, z0, stream),
    b = hash(seed, x0 + 1, z0, stream)
  const c = hash(seed, x0, z0 + 1, stream),
    d = hash(seed, x0 + 1, z0 + 1, stream)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz - 0.5
}

/** Three passes of a separable box blur approximate a Gaussian of sigma ≈ radius. */
export function blurGrid(values: Float32Array, columns: number, rows: number, radius: number) {
  let source = Float32Array.from(values)
  let target = new Float32Array(values.length)
  const width = radius * 2 + 1
  for (let pass = 0; pass < 3; pass++) {
    for (let row = 0; row < rows; row++) {
      const base = row * columns
      let sum = 0
      for (let k = -radius; k <= radius; k++) sum += source[base + clamp(k, 0, columns - 1)] ?? 0
      for (let column = 0; column < columns; column++) {
        target[base + column] = sum / width
        sum +=
          (source[base + Math.min(column + radius + 1, columns - 1)] ?? 0) -
          (source[base + Math.max(column - radius, 0)] ?? 0)
      }
    }
    ;[source, target] = [target, source]
    for (let column = 0; column < columns; column++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++)
        sum += source[clamp(k, 0, rows - 1) * columns + column] ?? 0
      for (let row = 0; row < rows; row++) {
        target[row * columns + column] = sum / width
        sum +=
          (source[Math.min(row + radius + 1, rows - 1) * columns + column] ?? 0) -
          (source[Math.max(row - radius, 0) * columns + column] ?? 0)
      }
    }
    ;[source, target] = [target, source]
  }
  return source
}

/** Two-sweep chamfer distance (world units) to cells where `seed` holds. */
export function chamfer(seedMask: Uint8Array, columns: number, rows: number, cell: number) {
  const far = (columns + rows) * cell
  const distance = new Float32Array(columns * rows)
  for (let i = 0; i < distance.length; i++) distance[i] = seedMask[i] ? 0 : far
  const diagonal = cell * Math.SQRT2
  const at = (i: number) => distance[i] ?? far
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column
      let d = at(i)
      if (column > 0) d = Math.min(d, at(i - 1) + cell)
      if (row > 0) {
        d = Math.min(d, at(i - columns) + cell)
        if (column > 0) d = Math.min(d, at(i - columns - 1) + diagonal)
        if (column < columns - 1) d = Math.min(d, at(i - columns + 1) + diagonal)
      }
      distance[i] = d
    }
  for (let row = rows - 1; row >= 0; row--)
    for (let column = columns - 1; column >= 0; column--) {
      const i = row * columns + column
      let d = at(i)
      if (column < columns - 1) d = Math.min(d, at(i + 1) + cell)
      if (row < rows - 1) {
        d = Math.min(d, at(i + columns) + cell)
        if (column < columns - 1) d = Math.min(d, at(i + columns + 1) + diagonal)
        if (column > 0) d = Math.min(d, at(i + columns - 1) + diagonal)
      }
      distance[i] = d
    }
  return distance
}

/** Depth of the lake bed below the water line at a distance from the shore (lake-bed.ts). */
export const bedDepthAt = (distance: number) => Math.min(7.5, 0.12 + distance * 0.42)

export type TerrainFieldInput = Readonly<{
  grid: TerrainGrid
  /** Composed ground height per corner, row-major; NaN where the corner is open water. */
  heights: Float32Array
  /** 0..1 exposed rock per corner, as composed. */
  rock: Float32Array
  seed: number
  mobile: boolean
  protect: readonly ProtectedArea[]
}>

export function createTerrainField(input: TerrainFieldInput): {
  field: TerrainField
  islands: TerrainIsland[]
} {
  const { grid, seed, mobile } = input
  const { minX, minZ, cell, columns, rows } = grid
  const count = columns * rows
  const raw = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const value = input.heights[i] ?? Number.NaN
    raw[i] = Number.isNaN(value) ? -Infinity : value
  }
  const rockRaw = Float32Array.from(input.rock)

  // Specks of land the coast leaves in the water read as boulders, not as soft bumps in the
  // ground: lift small, low components out of the field.
  const land = new Uint8Array(count)
  for (let i = 0; i < count; i++) land[i] = Number.isFinite(raw[i] ?? -Infinity) ? 1 : 0
  const islands: TerrainIsland[] = []
  const seen = new Uint8Array(count)
  const maxIsland = mobile ? 10 : 18
  const stack: number[] = []
  const component: number[] = []
  for (let start = 0; start < count; start++) {
    if (!land[start] || seen[start]) continue
    stack.length = 0
    component.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop() ?? 0
      component.push(i)
      const row = Math.floor(i / columns),
        column = i % columns
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const r = row + dr,
          c = column + dc
        if (r < 0 || c < 0 || r >= rows || c >= columns) continue
        const j = r * columns + c
        if (land[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    if (component.length > maxIsland) continue
    let sx = 0,
      sz = 0,
      top = -Infinity
    for (const i of component) {
      sx += minX + (i % columns) * cell
      sz += minZ + Math.floor(i / columns) * cell
      top = Math.max(top, raw[i] ?? 0)
    }
    if (top > 0.9) continue
    islands.push({
      x: sx / component.length,
      z: sz / component.length,
      top,
      extent: Math.sqrt(component.length) * cell,
    })
    for (const i of component) {
      land[i] = 0
      raw[i] = -Infinity
    }
  }

  // Open water continues down the same shelving profile as the rendered lake bed, so smoothing
  // shapes a natural beach instead of pulling the bank toward a flat floor.
  const distance = chamfer(land, columns, rows, cell)
  const base = new Float32Array(count)
  for (let i = 0; i < count; i++)
    base[i] = land[i] ? (raw[i] ?? 0) : WATER_LEVEL - bedDepthAt(distance[i] ?? 0)
  const wide = blurGrid(base, columns, rows, 2)
  const narrow = blurGrid(base, columns, rows, 1)

  // Local relief of the source: where a true cliff stands, lean back toward the narrow blur.
  const relief = new Float32Array(count)
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      let low = Infinity,
        high = -Infinity
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) {
          const r = clamp(row + dr, 0, rows - 1),
            c = clamp(column + dc, 0, columns - 1)
          const value = base[r * columns + c] ?? 0
          low = Math.min(low, value)
          high = Math.max(high, value)
        }
      relief[row * columns + column] = high - low
    }

  const protect = input.protect
  const reach = 1.3
  let boxMinX = Infinity,
    boxMaxX = -Infinity,
    boxMinZ = Infinity,
    boxMaxZ = -Infinity
  for (const area of protect) {
    boxMinX = Math.min(boxMinX, area.x - area.radius - reach)
    boxMaxX = Math.max(boxMaxX, area.x + area.radius + reach)
    boxMinZ = Math.min(boxMinZ, area.z - area.radius - reach)
    boxMaxZ = Math.max(boxMaxZ, area.z + area.radius + reach)
  }
  const kept = (x: number, z: number, mode: 'exact' | 'raise' | 'water') => {
    if (x < boxMinX || x > boxMaxX || z < boxMinZ || z > boxMaxZ) return 0
    let weight = 0
    for (const area of protect) {
      if ((area.mode ?? 'exact') !== mode) continue
      const d = Math.hypot(x - area.x, z - area.z)
      // Exact areas end crisply; raised rims blend over half a metre.
      const falloff = mode === 'raise' ? 1.2 : 0.25
      weight = Math.max(weight, 1 - smooth01(area.radius, area.radius + falloff, d))
    }
    return weight
  }

  const heights = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const cliff = smooth01(0.7, 1.6, relief[i] ?? 0)
    heights[i] = (wide[i] ?? 0) * (1 - cliff * 0.45) + (narrow[i] ?? 0) * cliff * 0.45
  }
  // Gradient-damped relief (Quilez, "more noise"): undulation on soft ground, almost none on
  // steep faces, and none at the water line so the shore contour stays where it was composed.
  const relieved = new Float32Array(count)
  const locked = new Float32Array(count)
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column
      const x = minX + column * cell,
        z = minZ + row * cell
      const h = heights[i] ?? 0
      const gx =
        ((heights[row * columns + Math.min(column + 1, columns - 1)] ?? h) -
          (heights[row * columns + Math.max(column - 1, 0)] ?? h)) /
        (2 * cell)
      const gz =
        ((heights[Math.min(row + 1, rows - 1) * columns + column] ?? h) -
          (heights[Math.max(row - 1, 0) * columns + column] ?? h)) /
        (2 * cell)
      const damping = 1 / (1 + 1.5 * (gx * gx + gz * gz))
      const onLand = smooth01(WATER_LEVEL + 0.04, 0.4, h)
      // Rounded granite knobs (ridged, a few metres across) under softer undulation.
      const knob = 0.5 - Math.abs(valueNoise(seed, x * 0.28, z * 0.28, 19)) * 2
      const noise =
        knob * 0.32 +
        valueNoise(seed, x * 0.6, z * 0.6, 11) * 0.34 +
        valueNoise(seed, x * 1.7, z * 1.7, 13) * 0.12 +
        valueNoise(seed, x * 3.9, z * 3.9, 17) * 0.04
      const source = base[i] ?? 0
      const natural = h + noise * damping * onLand
      // A raised rim keeps at least its composed height, with a ragged, never lower crest.
      const rim = kept(x, z, 'raise')
      const crest = source + Math.abs(valueNoise(seed, x * 2.3, z * 2.3, 23)) * 0.3 * rim
      const raised = natural + Math.max(0, crest - natural) * rim
      const keep = kept(x, z, 'exact')
      locked[i] = keep
      const composed = raised * (1 - keep) + source * keep
      const open = kept(x, z, 'water')
      relieved[i] = composed + (Math.min(composed, WATER_LEVEL - 0.25) - composed) * open
    }

  const rock = blurGrid(rockRaw, columns, rows, 2)
  return {
    field: { minX, minZ, cell, columns, rows, heights: relieved, land, rock, locked },
    islands,
  }
}

/** Bilinear height; outside the field the bed keeps falling away. */
export function sampleHeight(field: TerrainField, x: number, z: number) {
  const u = (x - field.minX) / field.cell,
    v = (z - field.minZ) / field.cell
  const c = clamp(Math.floor(u), 0, field.columns - 2),
    r = clamp(Math.floor(v), 0, field.rows - 2)
  const fx = clamp(u - c, 0, 1),
    fz = clamp(v - r, 0, 1)
  const i = r * field.columns + c
  const h = field.heights
  const a = h[i] ?? 0,
    b = h[i + 1] ?? 0,
    d = h[i + field.columns] ?? 0,
    e = h[i + field.columns + 1] ?? 0
  const inside = u >= 0 && v >= 0 && u <= field.columns - 1 && v <= field.rows - 1
  const value = (a * (1 - fx) + b * fx) * (1 - fz) + (d * (1 - fx) + e * fx) * fz
  return inside ? value : Math.min(value, WATER_LEVEL - 1)
}

/** Unit surface normal from central differences of the bilinear height. */
export function sampleNormal(field: TerrainField, x: number, z: number): [number, number, number] {
  const step = field.cell
  const dx = (sampleHeight(field, x + step, z) - sampleHeight(field, x - step, z)) / (2 * step)
  const dz = (sampleHeight(field, x, z + step) - sampleHeight(field, x, z - step)) / (2 * step)
  const length = Math.hypot(dx, 1, dz)
  return [-dx / length, 1 / length, -dz / length]
}

/** Rock share at a world position (nearest corner). */
export function sampleRock(field: TerrainField, x: number, z: number) {
  const c = clamp(Math.round((x - field.minX) / field.cell), 0, field.columns - 1)
  const r = clamp(Math.round((z - field.minZ) / field.cell), 0, field.rows - 1)
  return field.rock[r * field.columns + c] ?? 0
}

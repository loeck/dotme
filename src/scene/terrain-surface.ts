import { prepareGeometryBounds } from './geometry-bounds'
import type { PreparedBounds } from './geometry-bounds'
import { WATER_LEVEL } from './lake-bed'
import { clamp, mix as lerp, smoothstep as smooth01 } from './math'
import { vertexNormals } from './terrain-boulders'
import type { PreparedBoulders } from './terrain-boulders'
import { blurGrid } from './terrain-field'
import type { TerrainField } from './terrain-field'

/** Below this the ground is hidden by the water (the lake bed renders separately). */
const HIDDEN_BELOW = WATER_LEVEL - 0.55

export type TreeShade = Readonly<{ x: number; z: number; scale: number; kind: string }>

export type PreparedTerrainSurface = {
  positions: Float32Array
  normals: Int8Array
  /**
   * Per vertex, normalised bytes: rock share, sky visibility (horizon and canopy occlusion),
   * curvature (0.5 flat, higher in hollows) and forest litter under trees.
   */
  surface: Uint8Array
  indices: Uint32Array
  bounds: PreparedBounds
  triangles: number
}

function hash3(x: number, y: number, z: number) {
  let n = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f)
  n = Math.imul(n ^ (n >>> 13), 0x85ebca6b)
  n = Math.imul(n ^ (n >>> 16), 0xc2b2ae35)
  return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000
}

/** Trilinear value noise in [-0.5, 0.5]. */
function noise3(x: number, y: number, z: number) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    z0 = Math.floor(z)
  const fx = x - x0,
    fy = y - y0,
    fz = z - z0
  const sx = fx * fx * (3 - 2 * fx),
    sy = fy * fy * (3 - 2 * fy),
    sz = fz * fz * (3 - 2 * fz)
  const plane = (layer: number) =>
    lerp(
      lerp(hash3(x0, layer, z0), hash3(x0 + 1, layer, z0), sx),
      lerp(hash3(x0, layer, z0 + 1), hash3(x0 + 1, layer, z0 + 1), sx),
      sz,
    )
  return lerp(plane(y0), plane(y0 + 1), sy) - 0.5
}

/**
 * Shade under each crown, radius per unit of tree scale: a broadleaf's dense summer canopy shades
 * a wide disc nearly as deeply as a spruce's skirt that reaches the ground; a pine's high crown
 * and a birch's open curtains far less.
 */
const BIRCH_SHADE = { radius: 1.6, strength: 0.14 }
const CANOPY_SHADE: Readonly<Record<string, { radius: number; strength: number }>> = {
  oak: { radius: 2.6, strength: 0.28 },
  beech: { radius: 2.6, strength: 0.28 },
  spruce: { radius: 2, strength: 0.34 },
  pine: { radius: 1.9, strength: 0.16 },
  birch: BIRCH_SHADE,
}

/**
 * Sky visibility from the heightfield's horizon (8 azimuths, marched to 7 m) and from the
 * canopies of nearby trees, the main cue that seats ground in hollows and under the forest.
 */
function skyVisibility(field: TerrainField, trees: readonly TreeShade[], mobile: boolean) {
  const { columns, rows, cell, heights } = field
  const visibility = new Float32Array(columns * rows)
  const distances = mobile ? [0.5, 1, 2, 3.5, 6] : [0.3, 0.6, 1, 1.6, 2.5, 4, 7]
  const directions = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2
    return [Math.cos(angle), Math.sin(angle)] as const
  })
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column
      const h = heights[i] ?? 0
      if (h < HIDDEN_BELOW) {
        visibility[i] = 1
        continue
      }
      let occlusion = 0
      for (const [dx, dz] of directions) {
        let horizon = 0
        for (const distance of distances) {
          const c = Math.round(column + (dx * distance) / cell),
            r = Math.round(row + (dz * distance) / cell)
          if (c < 0 || r < 0 || c >= columns || r >= rows) break
          const rise = ((heights[r * columns + c] ?? 0) - h) / distance
          if (rise > horizon) horizon = rise
        }
        // sin(atan(t)): the share of this azimuth's sky hidden by the horizon.
        occlusion += horizon / Math.sqrt(1 + horizon * horizon)
      }
      visibility[i] = 1 - occlusion / directions.length
    }
  // Canopy: a soft disc of shade under each crown (see CANOPY_SHADE).
  for (const tree of trees) {
    // Any other kind shades like a birch.
    const canopy = CANOPY_SHADE[tree.kind] ?? BIRCH_SHADE
    const radius = tree.scale * canopy.radius,
      strength = canopy.strength
    const c0 = Math.max(0, Math.floor((tree.x - radius - field.minX) / cell)),
      c1 = Math.min(columns - 1, Math.ceil((tree.x + radius - field.minX) / cell))
    const r0 = Math.max(0, Math.floor((tree.z - radius - field.minZ) / cell)),
      r1 = Math.min(rows - 1, Math.ceil((tree.z + radius - field.minZ) / cell))
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(field.minX + c * cell - tree.x, field.minZ + r * cell - tree.z)
        const shade = strength * (1 - smooth01(radius * 0.25, radius, d))
        const i = r * columns + c
        visibility[i] = (visibility[i] ?? 1) * (1 - shade)
      }
  }
  return visibility
}

/** Needle and leaf litter under the trees' drip lines. */
function forestLitter(field: TerrainField, trees: readonly TreeShade[]) {
  const { columns, rows, cell } = field
  const litter = new Float32Array(columns * rows)
  for (const tree of trees) {
    const radius = tree.scale * (tree.kind === 'birch' ? 1.6 : 2.1)
    const c0 = Math.max(0, Math.floor((tree.x - radius - field.minX) / cell)),
      c1 = Math.min(columns - 1, Math.ceil((tree.x + radius - field.minX) / cell))
    const r0 = Math.max(0, Math.floor((tree.z - radius - field.minZ) / cell)),
      r1 = Math.min(rows - 1, Math.ceil((tree.z + radius - field.minZ) / cell))
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(field.minX + c * cell - tree.x, field.minZ + r * cell - tree.z)
        const i = r * columns + c
        litter[i] = Math.max(litter[i] ?? 0, 1 - smooth01(radius * 0.35, radius, d))
      }
  }
  return litter
}

/** Corner positions and normals (central differences, quantized as the mesh stores them). */
function cornerGrid(field: TerrainField) {
  const { columns, rows, cell, heights, minX, minZ } = field
  const positions = new Float32Array(columns * rows * 3)
  const normals = new Int8Array(columns * rows * 3)
  const at = (row: number, column: number) =>
    heights[clamp(row, 0, rows - 1) * columns + clamp(column, 0, columns - 1)] ?? 0
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column
      positions[i * 3] = minX + column * cell
      positions[i * 3 + 1] = heights[i] ?? 0
      positions[i * 3 + 2] = minZ + row * cell
      const dx = (at(row, column + 1) - at(row, column - 1)) / (2 * cell)
      const dz = (at(row + 1, column) - at(row - 1, column)) / (2 * cell)
      const length = Math.hypot(dx, 1, dz)
      normals[i * 3] = Math.round((-dx / length) * 127)
      normals[i * 3 + 1] = Math.round((1 / length) * 127)
      normals[i * 3 + 2] = Math.round((-dz / length) * 127)
    }
  return { positions, normals }
}

/**
 * A heightfield face is a ruled plane; break steep faces up horizontally with 3D noise so
 * cliffs bulge and recede like jointed rock. The composed waterfall lip stays put: the lock
 * fades over most of a metre here, so no bulge reaches under the falling sheet. Returns the
 * displaced corners. The colliders replay this exactly, so they match the drawn rock.
 */
function displaceCliffs(field: TerrainField, positions: Float32Array, normals: Int8Array) {
  const { columns, rows } = field
  const calm = blurGrid(field.locked, columns, rows, 3)
  const moved: number[] = []
  for (let i = 0; i < columns * rows; i++) {
    const nx = (normals[i * 3] ?? 0) / 127,
      ny = (normals[i * 3 + 1] ?? 127) / 127,
      nz = (normals[i * 3 + 2] ?? 0) / 127
    const steep =
      smooth01(0.3, 0.75, 1 - ny) *
      (1 - Math.min(1, Math.max(field.locked[i] ?? 0, (calm[i] ?? 0) * 2.5)))
    if (steep <= 0) continue
    const horizontal = Math.hypot(nx, nz) || 1
    const x = positions[i * 3] ?? 0,
      y = positions[i * 3 + 1] ?? 0,
      z = positions[i * 3 + 2] ?? 0
    const push =
      (noise3(x * 0.45, y * 0.7, z * 0.45) * 0.6 +
        noise3(x * 1.1, y * 1.6, z * 1.1) * 0.24 +
        noise3(x * 3.3, y * 3.3, z * 3.3) * 0.07) *
      steep
    positions[i * 3] = x + (nx / horizontal) * push
    positions[i * 3 + 2] = z + (nz / horizontal) * push
    positions[i * 3 + 1] = y + noise3(x * 2.1 + 7, y * 2.1, z * 2.1) * 0.06 * steep
    moved.push(i)
  }
  return moved
}

export function prepareTerrainSurface(
  field: TerrainField,
  trees: readonly TreeShade[],
  mobile: boolean,
): PreparedTerrainSurface {
  const { columns, rows, cell, heights } = field
  const count = columns * rows
  const { positions, normals } = cornerGrid(field)
  const surface = new Uint8Array(count * 4)
  const visibility = skyVisibility(field, trees, mobile)
  const litter = forestLitter(field, trees)
  // Curvature at about a metre: the blurred height minus the height, positive in hollows.
  const broad = blurGrid(heights, columns, rows, Math.max(1, Math.round(0.8 / cell)))
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column
      const h = heights[i] ?? 0
      surface[i * 4] = Math.round(clamp(field.rock[i] ?? 0, 0, 1) * 255)
      surface[i * 4 + 1] = Math.round(clamp(visibility[i] ?? 1, 0, 1) * 255)
      surface[i * 4 + 2] = Math.round(clamp(0.5 + ((broad[i] ?? h) - h) * 2.5, 0, 1) * 255)
      surface[i * 4 + 3] = Math.round(clamp(litter[i] ?? 0, 0, 1) * 255)
    }
  // Each quad splits along its flatter diagonal, so ridges and gullies follow the relief
  // instead of a uniform triangle grain. Quads fully under the water are dropped.
  const indices: number[] = []
  for (let row = 0; row < rows - 1; row++)
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column,
        b = a + 1,
        c = a + columns + 1,
        d = a + columns
      const ha = heights[a] ?? 0,
        hb = heights[b] ?? 0,
        hc = heights[c] ?? 0,
        hd = heights[d] ?? 0
      if (Math.max(ha, hb, hc, hd) < HIDDEN_BELOW) continue
      // Counter-clockwise seen from above (+y), with rows advancing along +z.
      if (Math.abs(ha - hc) <= Math.abs(hb - hd)) indices.push(a, d, c, a, c, b)
      else indices.push(a, d, b, b, d, c)
    }
  displaceCliffs(field, positions, normals)
  const indexArray = Uint32Array.from(indices)
  const smoothNormals = vertexNormals(positions, indexArray)
  for (let i = 0; i < smoothNormals.length; i++)
    normals[i] = Math.round((smoothNormals[i] ?? 0) * 127)
  return {
    positions,
    normals,
    surface,
    indices: indexArray,
    bounds: prepareGeometryBounds(positions),
    triangles: indices.length / 3,
  }
}

/**
 * Static collision data: a Rapier heightfield over the land, the drawn cliff faces as a small
 * triangle mesh where the heightfield steps aside for them, and one hull per boulder.
 */
export type TerrainColliders = {
  /** Heights in Rapier's layout: row (z) + column (x) * rows. */
  heights: Float32Array
  rows: number
  columns: number
  /** World extent of the heightfield and its centre. */
  scale: readonly [number, number, number]
  center: readonly [number, number, number]
  /** The displaced cliff cells as drawn: world positions and triangles. */
  cliffPositions: Float32Array
  cliffIndices: Uint32Array
  /** Boulder hull points, `boulderStarts` delimiting each boulder's. */
  boulderPoints: Float32Array
  /** First hull point of each boulder, plus the total at the end. */
  boulderStarts: Uint32Array
  /** Conservative 2 m broadphase: highest solid per column, for airborne segment rejection. */
  columnsTop: Readonly<{ x: number; z: number; width: number; height: number; tops: Float64Array }>
}

/** Open water has no floor collider: the ground ends below the shore. */
const OPEN_WATER_FLOOR = -9

export function prepareTerrainColliders(
  field: TerrainField,
  boulders: PreparedBoulders,
): TerrainColliders {
  const { columns, rows, cell, minX, minZ } = field
  // Cliffs are drawn pushed in and out of the heightfield's ruled faces. Their cells collide as
  // the same triangles, and the heightfield drops away under them.
  const grid = cornerGrid(field)
  const moved = displaceCliffs(field, grid.positions, grid.normals)
  const cellColumns = columns - 1
  const zone = new Uint8Array(cellColumns * (rows - 1))
  for (const i of moved) {
    const row = Math.floor(i / columns),
      column = i % columns
    for (let r = row - 1; r <= row; r++)
      for (let c = column - 1; c <= column; c++)
        if (r >= 0 && c >= 0 && r < rows - 1 && c < cellColumns) zone[r * cellColumns + c] = 1
  }
  const cliffVertex = new Map<number, number>()
  const cliffPositions: number[] = []
  const cliffIndices: number[] = []
  const vertex = (i: number) => {
    let index = cliffVertex.get(i)
    if (index === undefined) {
      index = cliffPositions.length / 3
      cliffVertex.set(i, index)
      cliffPositions.push(
        grid.positions[i * 3] ?? 0,
        grid.positions[i * 3 + 1] ?? 0,
        grid.positions[i * 3 + 2] ?? 0,
      )
    }
    return index
  }
  for (let row = 0; row < rows - 1; row++)
    for (let column = 0; column < cellColumns; column++) {
      if (!zone[row * cellColumns + column]) continue
      const a = row * columns + column,
        b = a + 1,
        c = a + columns + 1,
        d = a + columns
      const h = field.heights
      const ha = h[a] ?? 0,
        hb = h[b] ?? 0,
        hc = h[c] ?? 0,
        hd = h[d] ?? 0
      if (Math.max(ha, hb, hc, hd) < HIDDEN_BELOW) continue
      // The drawn mesh's flatter diagonal.
      const corners =
        Math.abs(ha - hc) <= Math.abs(hb - hd) ? [a, d, c, a, c, b] : [a, d, b, b, d, c]
      for (const corner of corners) cliffIndices.push(vertex(corner))
    }
  // A corner whose every cell is a cliff cell leaves the heightfield.
  const inZone = (r: number, c: number) =>
    r < 0 || c < 0 || r >= rows - 1 || c >= cellColumns || zone[r * cellColumns + c] === 1
  const heights = new Float32Array(columns * rows)
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const h = field.heights[row * columns + column] ?? OPEN_WATER_FLOOR
      const cliff =
        inZone(row - 1, column - 1) &&
        inZone(row - 1, column) &&
        inZone(row, column - 1) &&
        inZone(row, column) &&
        cliffVertex.has(row * columns + column)
      // The land continues just below the wave trough, then drops away under open water.
      heights[row + column * rows] = h > WATER_LEVEL - 0.4 && !cliff ? h : OPEN_WATER_FLOOR
    }
  const width = (columns - 1) * cell,
    depth = (rows - 1) * cell
  const x = Math.floor(minX / 2),
    z = Math.floor(minZ / 2)
  const tileWidth = Math.floor((minX + width) / 2) - x + 1,
    tileHeight = Math.floor((minZ + depth) / 2) - z + 1
  const tops = new Float64Array(tileWidth * tileHeight).fill(-Infinity)
  const raise = (px: number, pz: number, top: number) => {
    const tx = Math.floor(px / 2) - x,
      tz = Math.floor(pz / 2) - z
    if (tx < 0 || tz < 0 || tx >= tileWidth || tz >= tileHeight) return
    const i = tz * tileWidth + tx
    tops[i] = Math.max(tops[i] ?? -Infinity, top)
  }
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const top = heights[row + column * rows] ?? OPEN_WATER_FLOOR
      // A corner bounds the four quads around it.
      for (const [dx, dz] of [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ] as const)
        raise(minX + (column + dx) * cell, minZ + (row + dz) * cell, top)
    }
  for (let i = 0; i < cliffPositions.length; i += 3)
    raise(cliffPositions[i] ?? 0, cliffPositions[i + 2] ?? 0, cliffPositions[i + 1] ?? 0)
  for (let i = 0; i < boulders.positions.length; i += 3)
    raise(
      boulders.positions[i] ?? 0,
      boulders.positions[i + 2] ?? 0,
      boulders.positions[i + 1] ?? 0,
    )
  return {
    heights,
    rows,
    columns,
    scale: [width, 1, depth],
    center: [minX + width / 2, 0, minZ + depth / 2],
    cliffPositions: Float32Array.from(cliffPositions),
    cliffIndices: Uint32Array.from(cliffIndices),
    boulderPoints: boulders.positions.slice(),
    boulderStarts: boulders.starts.slice(),
    columnsTop: { x, z, width: tileWidth, height: tileHeight, tops },
  }
}

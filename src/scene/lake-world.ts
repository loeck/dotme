import { createLakeBedFromTerrain, LAKE_BOUNDS, lakeResolution, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { placeBoulders } from './terrain-boulders'
import type { Boulder } from './terrain-boulders'
import { createTerrainField, sampleHeight, sampleNormal, sampleRock } from './terrain-field'
import type { ProtectedArea, TerrainField, TerrainGrid, TerrainIsland } from './terrain-field'

/**
 * Deterministic, renderer-agnostic data for the low lake composition. The coast, islets,
 * headlands and ridges are continuous fields, sampled straight onto the corners of the terrain
 * grid; `terrain-field.ts` shapes those heights into the smooth ground, and the lake, the
 * waterfall's pool, the forest, the lanterns and the boulders are all placed on that ground.
 * Coordinates are Three.js world coordinates: x horizontal, y up, z depth; water is y = 0.
 */
export type LakeWorldVariant = 'desktop' | 'mobile'

export type LakeLamp = Readonly<{
  x: number
  y: number
  groundY: number
  z: number
  intensity: number
  phase: number
  speed: number
  amplitude: number
  driftRadius: number
}>

/** Last Signal's forest: dark conical spruces, Scots pines with an orange upper trunk, and
 * pale birches as the main value break against the conifers. */
export type TreeKind = 'spruce' | 'pine' | 'birch'

export type LakeTree = Readonly<{
  x: number
  y: number
  z: number
  scale: number
  kind: TreeKind
  /** Rotation about Y, radians. */
  yaw: number
}>

export type WaterfallSite = Readonly<{
  /** Square grid cells covered by the pool, whose water stands at `top`. */
  basin: readonly Readonly<{ x: number; z: number; size: number }>[]
  direction: readonly [number, number]
  x: number
  z: number
  top: number
  width: number
  seed: number
}>

export type LakeWorld = Readonly<{
  variant: LakeWorldVariant
  seed: number
  lakeBed: LakeBed
  waterfall: WaterfallSite | null
  lamps: readonly LakeLamp[]
  trees: readonly LakeTree[]
  /** The smooth ground the scene renders and collides with. */
  field: TerrainField
  boulders: readonly Boulder[]
  bounds: Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>
  suggestedCamera: Readonly<{
    position: readonly [number, number, number]
    target: readonly [number, number, number]
    fov: number
  }>
}>

type Islet = Readonly<{
  x: number
  z: number
  width: number
  depth: number
  heightScale: number
}>
type TerrainShape = Readonly<{
  islets: readonly Islet[]
  nearHeadlandX: number
  nearHeadlandWidth: number
  outerHeadlandWidth: number
  rightBankX: number
  rightBankWidth: number
  inletWidth: number
  inletMouthX: number
  inletMouthWidth: number
  nearHillHeight: number
  leftRidgeHeight: number
  leftSlopeHeight: number
}>
/** A stone the composition sets in the water: its top and footprint. */
type Stone = Readonly<{ x: number; z: number; top: number; size: number }>

/** Minimum distance between trunks, in metres. */
export const TREE_SPACING = 1.8
/** An islet's crown tree stays in proportion to a mound a few metres across. */
const ISLET_TREE_SCALE = 0.75
/** The ground never rises closer to the water than this, so every bank has a lip. */
const LAND_MIN = 0.28
/** Where the pool's surroundings fall back to the bed below the wave trough. */
const WATER_CONTACT_Y = -0.4
/** The waterfall's sill lies this far under the pool's surface. */
const SILL_DEPTH = 0.02
/** Open water the composition must leave around the landing's lake cells, for the smoothed bank. */
const LANDING_MARGIN = 0.15

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount
const smooth01 = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

function hash(seed: number, x: number, z: number, stream = 0) {
  let value = (seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77) ^ stream) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000
}

function smoothNoise(seed: number, x: number, z: number, scale: number, stream: number) {
  const px = x / scale
  const pz = z / scale
  const x0 = Math.floor(px)
  const z0 = Math.floor(pz)
  const tx = px - x0
  const tz = pz - z0
  const sx = tx * tx * (3 - 2 * tx)
  const sz = tz * tz * (3 - 2 * tz)
  return mix(
    mix(hash(seed, x0, z0, stream), hash(seed, x0 + 1, z0, stream), sx),
    mix(hash(seed, x0, z0 + 1, stream), hash(seed, x0 + 1, z0 + 1, stream), sx),
    sz,
  )
}

/** Broad seeded changes are visible from the camera; fine noise only changes surface detail. */
function terrainShape(seed: number, mobile: boolean): TerrainShape {
  const variation = (stream: number) => hash(seed, 0, 0, stream) * 2 - 1
  return {
    // Depth bands keep water between the islands; each seed changes their
    // position and footprint. Portrait islands stay inside the narrower inlet.
    islets: (
      [
        [mobile ? 9 : 12, -12, 2.5, 1.8],
        [mobile ? 7.5 : 9, -28, 2, 2.2],
        [mobile ? 9 : 15, -44, 2.7, 1.9],
      ] as const
    ).map(([x, z, width, depth], index) => ({
      x: x + (hash(seed, index, 0, 827) - 0.5) * (mobile ? 1 : 3),
      z: z + (hash(seed, index, 0, 829) - 0.5) * 4,
      width: width * mix(0.8, 1.15, hash(seed, index, 0, 831)),
      depth: depth * mix(0.8, 1.2, hash(seed, index, 0, 833)),
      heightScale: mix(0.55, 0.75, hash(seed, index, 0, 835)) * (mobile ? 0.65 : 1),
    })),
    nearHeadlandX: -19 + variation(803) * (mobile ? 2.4 : 2.8),
    nearHeadlandWidth: 16 + variation(805) * (mobile ? 2.1 : 2.7),
    outerHeadlandWidth: 25 + variation(807) * 3.5,
    rightBankX: 44 + variation(809) * 2.5,
    rightBankWidth: 19 + variation(811) * 2.6,
    inletWidth: 7.2 + variation(813) * 0.8,
    inletMouthX: (mobile ? -3 : -11.5) + variation(815) * (mobile ? 0.8 : 1.2),
    inletMouthWidth: (mobile ? 5.5 : 4.3) + variation(817) * 0.5,
    nearHillHeight: 1.2 + variation(819) * 0.35,
    leftRidgeHeight: variation(821) * 0.75,
    leftSlopeHeight: 4.6 + variation(823) * 0.6,
  }
}

/** The portrait layout pulls the two banks into the narrow camera frustum. */
function profileX(x: number, mobile: boolean) {
  return mobile ? x * 2.8 : x
}

/** Positive on land, negative in the water; roughly 1/15 per metre near the shore. */
function coastField(seed: number, x: number, z: number, mobile: boolean, shape: TerrainShape) {
  const px = profileX(x, mobile)
  const ellipse = (cx: number, cz: number, rx: number, rz: number) =>
    1 - Math.hypot((px - cx) / rx, (z - cz) / rz)
  // The left shore is two unequal headlands backed by a broad hill. Their wet edges are
  // separate; the deep notch between them stops the shoreline becoming one long wall.
  const left = Math.max(
    ellipse(-46, -32, shape.outerHeadlandWidth, 17),
    ellipse(shape.nearHeadlandX, -26, shape.nearHeadlandWidth, 15),
    ellipse(-34, -48, 29, 24),
    // Two low, detached stones carry the left bank into the open water.
    ellipse(-7.5, -10.0, 2.3, 1.6) * 0.48,
  )
  const inlet =
    Math.exp(-(((px + 34) / shape.inletWidth) ** 2) - ((z + 24) / 20) ** 2) * 1.2 +
    Math.exp(-(((px + 53) / 6) ** 2) - ((z + 9) / 6.5) ** 2) * 0.23
  // A slim diagonal mouth brings that deep inlet through the nearer eastern headland.
  // Otherwise the world-space channel is hidden behind it at the low camera angle.
  const mouth = shape.inletMouthX
  const channelX = mouth - clamp((-z - 18) / 14, 0, 1) * (mobile ? 30.5 : 22)
  const aperture =
    Math.exp(-(((px - channelX) / shape.inletMouthWidth) ** 2) - ((z + 21) / 17) ** 2) * 1.35
  const right = Math.max(
    ellipse(shape.rightBankX, -41, shape.rightBankWidth, 14),
    ellipse(43, -67, 18, 18),
    // A rear shoulder connects the low shore to the high right-hand ridge.
    ellipse(50, -56, 27, 22),
    // A low finger extends in front of the rear hill.
    mobile ? ellipse(28, -35, 15, 10) : ellipse(29, -33, 8, 9),
    // Low distant islets break the straight horizon and give the far lights a real shore.
    ellipse(13, -63, 8.5, 4.2) * 0.55,
    ellipse(25, -65, 10, 5) * 0.62,
  )
  let land = Math.max(left - inlet - aperture, right)
  for (const islet of shape.islets)
    land = Math.max(land, ellipse(islet.x, islet.z, islet.width, islet.depth) * 0.42)
  // One smooth coastal perturbation shapes coves; the fine term scatters a few tiny stones.
  const coves = (smoothNoise(seed, px, z, 10, 71) - 0.5) * 0.18
  const breaks = (smoothNoise(seed, px, z, 3.2, 73) - 0.5) * 0.085
  return land + coves + breaks
}

/** Ground height on land, from the coast value at the same point. */
function heightAt(
  seed: number,
  x: number,
  z: number,
  coast: number,
  mobile: boolean,
  shape: TerrainShape,
) {
  const px = profileX(x, mobile)
  const nearHill = Math.exp(-(((px - (shape.nearHeadlandX - 6)) / 14) ** 2) - ((z + 22) / 18) ** 2)
  const leftRidge = Math.exp(-(((px + 43) / 23) ** 2) - ((z + 25) / 22) ** 2)
  const rightRidge = Math.exp(-(((px - 38) / 23) ** 2) - ((z + 40) / 25) ** 2)
  const rightAcross = clamp((px - 39) / 24, 0, 1)
  const rightBack = clamp((-z - 29) / 35, 0, 1)
  const rightSlope =
    rightAcross *
    rightAcross *
    (3 - 2 * rightAcross) *
    (0.8 + 6.2 * rightBack * rightBack * (3 - 2 * rightBack))
  const leftSlope = Math.pow(clamp((-px - 8) / 43, 0, 1), 1.35) * shape.leftSlopeHeight
  const nearSpur = Math.exp(-(((px + 40) / 11) ** 2) - ((z + 17) / 10) ** 2) * 0.9
  const farSpur = Math.exp(-(((px + 50) / 14) ** 2) - ((z + 39) / 14) ** 2) * 0.8
  const distant = clamp((-z - 37) / 30, 0, 1) * 0.22
  const broad = (smoothNoise(seed, px, z, 15, 131) - 0.5) * 0.68
  const middle = (smoothNoise(seed, px, z, 5.8, 149) - 0.5) * 0.44
  const pebbles = (smoothNoise(seed, px, z, 1.3, 157) - 0.5) * 0.23
  // Larger irregularities belong to the rear hill, leaving a low shelf in front.
  const rightRoughness =
    (smoothNoise(seed, px, z, 8.5, 165) - 0.5) * 2.8 +
    (smoothNoise(seed, px, z, 2.3, 167) - 0.5) * 0.72
  const ramp = clamp(coast / 0.42, 0, 1)
  const coastFade = ramp * ramp * (3 - 2 * ramp)
  const leftRidgeStrength = mix(2.55, 3.1, clamp((-px - 25) / 15, 0, 1)) + shape.leftRidgeHeight
  const outcrops = Math.max(0, smoothNoise(seed, px, z, 3.6, 169) - 0.54) * 3.6
  const rightPeaks =
    Math.exp(-(((px - 47) / 8.5) ** 2) - ((z + 48) / 12) ** 2) * 1.4 +
    Math.exp(-(((px - 62) / 10) ** 2) - ((z + 57) / 13) ** 2) * 1.7
  const mass =
    (px < 0
      ? nearHill * shape.nearHillHeight +
        leftRidge * leftRidgeStrength +
        leftSlope +
        nearSpur +
        farSpur +
        outcrops
      : rightRidge * 1.25 +
        rightSlope +
        rightPeaks +
        outcrops +
        rightRoughness * clamp((px - 27) / 21, 0, 1) * clamp((-z - 34) / 19, 0, 1)) * coastFade
  const shoreRise = clamp(coast * 3.2, 0, px < 0 ? 0.9 : 1.15)
  // Rocky patches of a metre or two break broad slopes into benches and knolls.
  const surfaceRelief =
    (smoothNoise(seed, x, z, 1, 173) - 0.5) * 0.6 + (smoothNoise(seed, x, z, 2.25, 179) - 0.5) * 0.5
  const elevation = clamp(
    0.2 +
      shoreRise +
      mass * (px < 0 && z > -32 ? 0.76 : 1) +
      distant +
      broad +
      middle +
      pebbles +
      surfaceRelief * (mobile ? 0.65 : 1),
    LAND_MIN,
    11,
  )
  const islet = shape.islets.find(
    (island) =>
      Math.abs(px - island.x) < island.width * 1.4 && Math.abs(z - island.z) < island.depth * 1.4,
  )
  if (!islet) return elevation
  // Each islet is a rounded mound of rock and moss, high enough at its crown for a tree once
  // the ground is smoothed; portrait islets are narrow, so their dome rises more steeply.
  const dome = Math.max(
    0,
    1 - Math.hypot((px - islet.x) / islet.width, (z - islet.z) / islet.depth),
  )
  return (
    Math.max(LAND_MIN, elevation * islet.heightScale) + Math.sqrt(dome) * (mobile ? 0.75 : 0.15)
  )
}

/** Exposed rock: a bare shore band and seeded outcrop patches. */
function rockAt(seed: number, x: number, z: number, coast: number, mobile: boolean) {
  const outcrop = smooth01(0.66, 0.74, smoothNoise(seed, profileX(x, mobile), z, 4.2, 191))
  const shore = 0.45 * (1 - smooth01(0.08, 0.11, coast))
  return Math.max(outcrop, shore)
}

/**
 * A low shore enters beneath the camera. Its diagonal, broken wet edge supplies a near plane
 * while the middle of the lake remains open all the way to the horizon.
 */
type Foreground = Readonly<{ minX: number; maxX: number; start: number; end: number }>

function foregroundAt(
  seed: number,
  x: number,
  z: number,
  mobile: boolean,
  shift: number,
  zone: Foreground,
): { height: number; rock: number } | null {
  if (z < zone.start || z > zone.end || x < zone.minX || x > zone.maxX) return null
  const advance = clamp((z - zone.start) / 7, 0, 1)
  const edge =
    (mobile ? -2.55 + advance * 2.49 : -10 + advance * 9.4) +
    shift +
    (smoothNoise(seed, z, 0, 1.8, 409) - 0.5) * (mobile ? 0.35 : 1.3)
  const depth = edge - x
  const brokenEdge = (smoothNoise(seed, x, z, 0.52, 419) - 0.5) * 0.52
  if (depth + brokenEdge < 0) return null
  const swell = smoothNoise(seed, x, z, 1.45, 431)
  const patches = smoothNoise(seed, x, z, 0.5, 433)
  const ridges = smoothNoise(seed, x, z, 1, 439)
  const relief = ((patches - 0.5) * 2.6 + (ridges - 0.5) * 2) * 0.125
  const height = 0.03 + clamp(depth / 2.4, 0, 1) * 0.13 + Math.max(0, swell - 0.32) * 0.3 + relief
  const shore = 0.45 * (1 - smooth01(0.08, 0.18, depth))
  const outcrop = smooth01(0.74, 0.8, smoothNoise(seed, x, z, 0.8, 421))
  return { height: Math.max(0.125, height), rock: Math.max(shore, outcrop) }
}

/** The composed ground on a grid: corner heights (NaN in the water) and cell tops. */
type Composition = Readonly<{
  grid: TerrainGrid
  heights: Float32Array
  rock: Float32Array
  /** Highest corner of each land cell; NaN when any corner is water. */
  cells: Float32Array
  cellColumns: number
  cellRows: number
}>

function cellTops(grid: TerrainGrid, heights: Float32Array) {
  const cellColumns = grid.columns - 1,
    cellRows = grid.rows - 1
  const cells = new Float32Array(cellColumns * cellRows)
  for (let row = 0; row < cellRows; row++)
    for (let column = 0; column < cellColumns; column++) {
      const i = row * grid.columns + column
      const a = heights[i] ?? Number.NaN,
        b = heights[i + 1] ?? Number.NaN,
        c = heights[i + grid.columns] ?? Number.NaN,
        d = heights[i + grid.columns + 1] ?? Number.NaN
      // Math.max propagates NaN: a cell is land only when all its corners are.
      cells[row * cellColumns + column] = Math.max(a, b, c, d)
    }
  return { cells, cellColumns, cellRows }
}

/** World centre of the grid cell between corners (column, row) and (column + 1, row + 1). */
const cellCentre = (grid: TerrainGrid, column: number, row: number) => ({
  x: grid.minX + (column + 0.5) * grid.cell,
  z: grid.minZ + (row + 0.5) * grid.cell,
})

function cellAt(composition: Composition, x: number, z: number) {
  const { grid, cellColumns, cellRows } = composition
  const column = Math.floor((x - grid.minX) / grid.cell)
  const row = Math.floor((z - grid.minZ) / grid.cell)
  if (column < 0 || row < 0 || column >= cellColumns || row >= cellRows) return -1
  return row * cellColumns + column
}

const cellTopAt = (composition: Composition, x: number, z: number) => {
  const index = cellAt(composition, x, z)
  return index < 0 ? Number.NaN : (composition.cells[index] ?? Number.NaN)
}

/** Highest composed corner within a radius; NaN when any corner there is water. */
function cornerMax(composition: Composition, x: number, z: number, radius: number) {
  const { grid, heights } = composition
  const c0 = Math.ceil((x - radius - grid.minX) / grid.cell),
    c1 = Math.floor((x + radius - grid.minX) / grid.cell)
  const r0 = Math.ceil((z - radius - grid.minZ) / grid.cell),
    r1 = Math.floor((z + radius - grid.minZ) / grid.cell)
  let top = -Infinity
  for (let row = r0; row <= r1; row++)
    for (let column = c0; column <= c1; column++) {
      if (row < 0 || column < 0 || row >= grid.rows || column >= grid.columns) return Number.NaN
      top = Math.max(top, heights[row * grid.columns + column] ?? Number.NaN)
    }
  return top
}

/** Whether any composed corner within a square reach is land. */
function landWithin(composition: Composition, x: number, z: number, radius: number) {
  const { grid, heights } = composition
  const c0 = Math.max(0, Math.ceil((x - radius - grid.minX) / grid.cell)),
    c1 = Math.min(grid.columns - 1, Math.floor((x + radius - grid.minX) / grid.cell))
  const r0 = Math.max(0, Math.ceil((z - radius - grid.minZ) / grid.cell)),
    r1 = Math.min(grid.rows - 1, Math.floor((z + radius - grid.minZ) / grid.cell))
  for (let row = r0; row <= r1; row++)
    for (let column = c0; column <= c1; column++)
      if (!Number.isNaN(heights[row * grid.columns + column] ?? Number.NaN)) return true
  return false
}

type Carve = Readonly<{ fall: WaterfallSite; cells: ReadonlyMap<number, number> }>

/**
 * Pick an exposed shore facing the camera and carve a small pool behind its lip. The pool's
 * cells, raised rim and terraced surroundings are cell tops; `applyCarve` writes them onto the
 * corners.
 */
function selectWaterfall(
  seed: number,
  mobile: boolean,
  composition: Composition,
  stones: readonly Stone[],
  lamps: readonly LakeLamp[],
  relaxed = false,
): Carve | null {
  const { grid, cells, cellColumns, cellRows, heights } = composition
  const cell = grid.cell
  const desiredWidth = mix(mobile ? 0.7 : 1.5, mobile ? 1 : 2, hash(seed, 0, 0, 919))
  const landingOffset = 0.8
  const top = mobile ? cell * 7 : 2
  const lakeCell = LAKE_BOUNDS.size / lakeResolution(mobile)
  const isLand = (column: number, row: number) =>
    column >= 0 &&
    row >= 0 &&
    column < cellColumns &&
    row < cellRows &&
    !Number.isNaN(cells[row * cellColumns + column] ?? Number.NaN)
  const stoneAt = (x: number, z: number, above: number, margin: number) =>
    stones.some(
      (stone) =>
        Math.abs(stone.x - x) < stone.size / 2 + margin &&
        Math.abs(stone.z - z) < stone.size / 2 + margin &&
        stone.top > above,
    )
  const portraitPosition = (x: number, z: number) =>
    Math.abs(x / ((16 - z) * Math.tan((54 * Math.PI) / 360) * 0.46) + 0.48)

  type Candidate = Readonly<{
    column: number
    row: number
    x: number
    z: number
    direction: readonly [number, number]
    width: number
    offset: number
  }>
  const candidates: Candidate[] = []
  for (let row = 0; row < cellRows; row++)
    for (let column = 0; column < cellColumns; column++) {
      const { x, z } = cellCentre(grid, column, row)
      const px = profileX(x, mobile)
      if (
        px < (relaxed ? -45 : -38) ||
        px > (relaxed ? -8 : -13) ||
        z < (relaxed ? -40 : -34) ||
        z > (relaxed ? -8 : -12) ||
        !isLand(column, row)
      )
        continue
      for (const direction of [
        [1, 0],
        [0, 1],
      ] as const) {
        if (isLand(column + direction[0], row + direction[1])) continue
        for (const width of [desiredWidth, mobile ? 0.7 : 1.5])
          for (const offset of [0, 0.5, -0.5])
            candidates.push({ column, row, x, z, direction, width, offset: offset * cell })
      }
    }
  const cellHash = (candidate: Candidate) =>
    hash(seed, candidate.column, cellRows - candidate.row, 929)
  candidates.sort(
    (a, b) =>
      (mobile ? b.direction[1] - a.direction[1] : 0) ||
      (mobile ? portraitPosition(a.x, a.z) - portraitPosition(b.x, b.z) : 0) ||
      cellHash(a) - cellHash(b),
  )

  for (const candidate of candidates) {
    const [nx, nz] = candidate.direction
    const { width } = candidate
    const centerX = candidate.x + nz * candidate.offset,
      centerZ = candidate.z - nx * candidate.offset
    const x = centerX + nx * (cell / 2 + 0.03)
    const z = centerZ + nz * (cell / 2 + 0.03)
    if (z < (relaxed ? -40 : -34) || z > (relaxed ? -8 : -12)) continue
    // A physically exposed sheet must also face the camera enough to show its width.
    const facing = (-x * nx + (16 - z) * nz) / Math.hypot(x, 16 - z)
    if (facing < (relaxed ? 0.16 : 0.35)) continue
    const halfView = (16 - z) * Math.tan((54 * Math.PI) / 360) * (mobile ? 0.46 : 1.6)
    if (Math.abs(x) + width / 2 > halfView * (relaxed ? 1 : 0.92)) continue
    if (lamps.some((lamp) => Math.hypot(lamp.x - x, lamp.z - z) < 2.2)) continue
    const halfWidth = width / 2
    // The landing is open water: no land and no stone in the lake raster's cells there, nor
    // close enough for the smoothed bank to reach them.
    const samples = Math.ceil(width / (cell / 2))
    let supported = true
    for (let i = 0; i <= samples && supported; i++) {
      const along = -halfWidth + (width * i) / samples
      const lx = x + nz * along + nx * landingOffset,
        lz = z - nx * along + nz * landingOffset
      const lakeX =
        LAKE_BOUNDS.minX + (Math.floor((lx - LAKE_BOUNDS.minX) / lakeCell) + 0.5) * lakeCell
      const lakeZ =
        LAKE_BOUNDS.minZ + (Math.floor((lz - LAKE_BOUNDS.minZ) / lakeCell) + 0.5) * lakeCell
      supported =
        !landWithin(composition, lakeX, lakeZ, lakeCell / 2 + LANDING_MARGIN) &&
        !stoneAt(lakeX, lakeZ, WATER_LEVEL, lakeCell / 2 + 0.05)
    }
    if (!supported) continue
    // Nothing may stand in the sheet's path down to the water.
    let open = true
    const c0 = Math.floor(
      (Math.min(x, x + nx * landingOffset) - halfWidth - cell - grid.minX) / cell,
    )
    const c1 = Math.ceil(
      (Math.max(x, x + nx * landingOffset) + halfWidth + cell - grid.minX) / cell,
    )
    const r0 = Math.floor(
      (Math.min(z, z + nz * landingOffset) - halfWidth - cell - grid.minZ) / cell,
    )
    const r1 = Math.ceil(
      (Math.max(z, z + nz * landingOffset) + halfWidth + cell - grid.minZ) / cell,
    )
    for (let row = Math.max(0, r0); row <= Math.min(grid.rows - 1, r1) && open; row++)
      for (let column = Math.max(0, c0); column <= Math.min(grid.columns - 1, c1); column++) {
        const h = heights[row * grid.columns + column] ?? Number.NaN
        if (Number.isNaN(h)) continue
        const px = grid.minX + column * cell,
          pz = grid.minZ + row * cell
        const along = (px - x) * nx + (pz - z) * nz
        const across = (px - x) * nz - (pz - z) * nx
        if (
          along <= 0 ||
          along >= landingOffset + cell / 2 ||
          Math.abs(across) >= halfWidth + cell / 2
        )
          continue
        const last = clamp((along + cell / 2) / landingOffset, 0, 1)
        if (h > mix(top, WATER_LEVEL, last * last) - 0.015) {
          open = false
          break
        }
      }
    if (!open) continue
    if (
      stones.some((stone) => {
        const along = (stone.x - x) * nx + (stone.z - z) * nz
        const across = (stone.x - x) * nz - (stone.z - z) * nx
        return (
          along + stone.size / 2 > 0 &&
          along - stone.size / 2 < landingOffset &&
          Math.abs(across) < halfWidth + stone.size / 2
        )
      })
    )
      continue
    // Reject a fall hidden behind another bank.
    const steps = Math.ceil(Math.hypot(x, 16 - z) / cell)
    let visible = true
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const blocker = cellTopAt(composition, x * (1 - t), mix(z, 16, t))
      if (blocker > mix(top * 0.5, 2.5, t)) {
        visible = false
        break
      }
    }
    if (!visible) continue

    // An upstream pool widens behind the narrow outlet, dug into the bank.
    const basinHalfWidth = mobile ? (relaxed ? 0.8 : 1.0) : 1.75
    const basinDepth = mobile ? (relaxed ? 1.7 : 2.24) : 3
    const basinCenter = basinDepth * 0.56
    const basinRadius = basinDepth * 0.44
    const phase = hash(seed, candidate.column, cellRows - candidate.row, 947) * Math.PI * 2
    const basin = new Set<number>()
    let dug = 0
    for (let back = 0; back <= Math.floor(basinDepth / cell); back++) {
      const behind = back * cell
      const ellipse =
        basinHalfWidth * Math.sqrt(Math.max(0, 1 - ((behind - basinCenter) / basinRadius) ** 2))
      const reach = Math.ceil(basinHalfWidth / cell) + 1
      for (let side = -reach; side <= reach; side++) {
        const column = candidate.column - nx * back + nz * side
        const row = candidate.row - nz * back - nx * side
        const { x: px, z: pz } = cellCentre(grid, column, row)
        const signedAcross = (px - centerX) * nz - (pz - centerZ) * nx
        const shape =
          1 +
          Math.sin(behind * 1.3 + phase) * 0.09 +
          Math.sign(signedAcross) * Math.cos(behind * 1.7 + phase) * 0.06
        const openWidth = Math.max(behind < basinCenter ? halfWidth : 0, ellipse * shape)
        if (Math.abs(signedAcross) >= openWidth + 1e-6) continue
        if (column < 0 || row < 0 || column >= cellColumns || row >= cellRows) continue
        if (isLand(column, row)) dug++
        basin.add(row * cellColumns + column)
      }
    }
    if (basin.size < (mobile ? 10 : 20) || dug < basin.size * (relaxed ? 0.4 : 0.7)) continue

    const carved = new Map<number, number>()
    for (const index of basin) carved.set(index, top - cell)
    const neighbours = (index: number) => {
      const column = index % cellColumns,
        row = Math.floor(index / cellColumns)
      return (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const
      )
        .map(([dc, dr]) => ({ column: column + dc, row: row + dr }))
        .filter((n) => n.column >= 0 && n.row >= 0 && n.column < cellColumns && n.row < cellRows)
    }
    // Behind the lip, every cell around the pool holds its water.
    const behindLip = (column: number, row: number) => {
      const { x: px, z: pz } = cellCentre(grid, column, row)
      return (candidate.x - px) * nx + (candidate.z - pz) * nz >= -1e-6
    }
    let rim: number[] = []
    for (const index of basin)
      for (const n of neighbours(index)) {
        const key = n.row * cellColumns + n.column
        if (carved.has(key) || !behindLip(n.column, n.row)) continue
        carved.set(key, top + cell)
        rim.push(key)
      }
    // Terraces blend the raised rim back into the bank, rather than leaving a uniform wall.
    for (let ring = 0; ring < (mobile ? (relaxed ? 0 : 2) : 3); ring++) {
      const next: number[] = []
      for (const edge of rim)
        for (const n of neighbours(edge)) {
          const key = n.row * cellColumns + n.column
          if (carved.has(key) || !isLand(n.column, n.row) || !behindLip(n.column, n.row)) continue
          const ground = cells[key] ?? WATER_CONTACT_Y
          const drop = cell * (hash(seed, n.column, cellRows - n.row, 953) > 0.55 ? 3 : 2)
          const height = Math.max(ground, (carved.get(edge) ?? ground) - drop)
          if (height <= ground + 1e-6) continue
          carved.set(key, height)
          next.push(key)
        }
      rim = next
    }
    if (
      lamps.some((lamp) =>
        [...carved.keys()].some((index) => {
          const { x: px, z: pz } = cellCentre(
            grid,
            index % cellColumns,
            Math.floor(index / cellColumns),
          )
          return Math.hypot(lamp.x - px, lamp.z - pz) < 0.7
        }),
      )
    )
      continue
    return {
      fall: {
        basin: [...basin].map((index) => ({
          ...cellCentre(grid, index % cellColumns, Math.floor(index / cellColumns)),
          size: cell,
        })),
        x,
        z,
        top,
        width,
        direction: candidate.direction,
        seed: Math.floor(
          hash(seed, candidate.column, cellRows - candidate.row, 937) * 0x1_0000_0000,
        ),
      },
      cells: carved,
    }
  }
  return relaxed ? null : selectWaterfall(seed, mobile, composition, stones, lamps, true)
}

/** Each corner touching a carved cell takes the highest top around it, as a bank lip does. */
function applyCarve(composition: Composition, carve: Carve) {
  const { grid, heights, cellColumns } = composition
  const touched = new Set<number>()
  for (const index of carve.cells.keys()) {
    const column = index % cellColumns,
      row = Math.floor(index / cellColumns)
    for (const [dc, dr] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      touched.add((row + dr) * grid.columns + column + dc)
  }
  const source = Float32Array.from(heights)
  for (const corner of touched) {
    const column = corner % grid.columns,
      row = Math.floor(corner / grid.columns)
    const own = source[corner] ?? Number.NaN
    let top = -Infinity
    for (const [dc, dr] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ] as const) {
      const c = column + dc,
        r = row + dr
      if (c < 0 || r < 0 || c >= cellColumns || r >= grid.rows - 1) continue
      const carved = carve.cells.get(r * cellColumns + c)
      top = Math.max(top, carved ?? (Number.isNaN(own) ? -Infinity : own))
    }
    heights[corner] = Number.isFinite(top) ? top : own
  }
  // A level rock sill under the whole sheet, just below the pool's surface: the water leaves
  // from a ledge across its full width, even where the outlet is only a cell or two wide.
  const { fall } = carve
  const [nx, nz] = fall.direction
  const reach = fall.width / 2 + grid.cell
  const c0 = Math.floor((fall.x - reach - 2 * grid.cell - grid.minX) / grid.cell),
    c1 = Math.ceil((fall.x + reach + 2 * grid.cell - grid.minX) / grid.cell)
  const r0 = Math.floor((fall.z - reach - 2 * grid.cell - grid.minZ) / grid.cell),
    r1 = Math.ceil((fall.z + reach + 2 * grid.cell - grid.minZ) / grid.cell)
  for (let row = Math.max(0, r0); row <= Math.min(grid.rows - 1, r1); row++)
    for (let column = Math.max(0, c0); column <= Math.min(grid.columns - 1, c1); column++) {
      const x = grid.minX + column * grid.cell,
        z = grid.minZ + row * grid.cell
      const along = (x - fall.x) * nx + (z - fall.z) * nz
      const across = (x - fall.x) * nz - (z - fall.z) * nx
      if (along > 0 || along < -1.5 * grid.cell || Math.abs(across) > reach) continue
      const i = row * grid.columns + column
      heights[i] = Math.min(heights[i] ?? fall.top, fall.top - SILL_DEPTH)
    }
  const refreshed = cellTops(grid, heights)
  composition.cells.set(refreshed.cells)
}

/** Stones the composition sets in the water, merged where they touch. */
function waterStones(
  seed: number,
  mobile: boolean,
  grid: TerrainGrid,
  heights: Float32Array,
  zNear: number,
): Stone[] {
  const cell = grid.cell
  const sizeAt = (z: number) => cell * (z > 2 ? 0.5 : z < -44 ? 2 : 1)
  const stones: Stone[] = []
  const add = (x: number, z: number) => {
    const size = sizeAt(z)
    stones.push({ x, z, top: size / 2, size })
  }
  // Single separated blocks on the wet edge keep it granular instead of reading as a wall.
  for (let row = 0; row < grid.rows - 1; row++)
    for (let column = 0; column < grid.columns; column++) {
      const i = row * grid.columns + column
      const x = grid.minX + column * cell,
        z = grid.minZ + row * cell
      // A bank corner with open water toward the camera.
      if (
        z > zNear ||
        Number.isNaN(heights[i] ?? Number.NaN) ||
        !Number.isNaN(heights[i + grid.columns] ?? Number.NaN)
      )
        continue
      const xi = Math.round(x / cell),
        zi = Math.round((zNear - z) / cell)
      if (hash(seed, xi, zi, 187) <= 0.915) continue
      add(x, z + cell * 1.2)
      if (hash(seed, xi, zi, 189) > 0.82) add(x + cell, z + cell * 1.8)
    }
  for (const [index, px, z] of [
    [0, -19, -5.8],
    [1, -16, -6.2],
    [2, -12, -7.3],
  ] as const) {
    const x = mobile ? px / 2.8 : px
    add(x + (hash(seed, index, 0, 243) - 0.5) * cell * 0.8, z)
    if (index === 1) add(x + cell, z - cell)
  }
  // A few broken fingers of stone run off the two left headlands into the water.
  for (const [cluster, px, z] of [
    [0, -49, -7],
    [1, -36, -8.5],
    [2, -28, -7.5],
    [3, -14, -5.5],
  ] as const) {
    const x = mobile ? px / 2.8 : px
    for (let stone = 0; stone < (mobile ? 5 : 9); stone += 1) {
      if (hash(seed, cluster, stone, 247) < 0.17) continue
      add(
        x + (hash(seed, cluster, stone, 251) - 0.5) * cell * 8,
        z + (hash(seed, cluster, stone, 257) - 0.5) * cell * 7,
      )
    }
  }
  for (const [px, z] of [
    [-41, -8],
    [-39, -10],
    [-36, -8.5],
    [-30, -9],
    [-27, -7.5],
  ] as const)
    add(mobile ? px / 2.8 : px, z)

  // A stone touching the bank belongs to it; touching stones form one larger block.
  const inWater = stones.filter((stone) => {
    const half = stone.size / 2 + 1e-3
    const c0 = Math.ceil((stone.x - half - grid.minX) / cell),
      c1 = Math.floor((stone.x + half - grid.minX) / cell)
    const r0 = Math.ceil((stone.z - half - grid.minZ) / cell),
      r1 = Math.floor((stone.z + half - grid.minZ) / cell)
    for (let row = r0; row <= r1; row++)
      for (let column = c0; column <= c1; column++) {
        const h = heights[row * grid.columns + column]
        if (h !== undefined && !Number.isNaN(h)) return false
      }
    return true
  })
  const groups: Stone[][] = []
  for (const stone of inWater) {
    const touching = groups.filter((group) =>
      group.some(
        (other) =>
          Math.abs(other.x - stone.x) <= (other.size + stone.size) / 2 + 1e-3 &&
          Math.abs(other.z - stone.z) <= (other.size + stone.size) / 2 + 1e-3,
      ),
    )
    const merged = [stone, ...touching.flat()]
    for (const group of touching) groups.splice(groups.indexOf(group), 1)
    groups.push(merged)
  }
  return groups.map((group) => {
    const area = group.reduce((sum, stone) => sum + stone.size * stone.size, 0)
    return {
      x: group.reduce((sum, stone) => sum + stone.x, 0) / group.length,
      z: group.reduce((sum, stone) => sum + stone.z, 0) / group.length,
      top: Math.max(...group.map((stone) => stone.top)),
      size: Math.sqrt(area),
    }
  })
}

/** Floating lanterns over solid ground, spread across the composition and kept in view. */
function placeLamps(seed: number, mobile: boolean, composition: Composition): LakeLamp[] {
  const { grid, cells, cellColumns, cellRows } = composition
  type Site = { x: number; z: number; height: number; driftRadius: number }
  const sites: Site[] = []
  for (let row = 0; row < cellRows; row++)
    for (let column = 0; column < cellColumns; column++) {
      const top = cells[row * cellColumns + column] ?? Number.NaN
      if (Number.isNaN(top) || top > 6) continue
      const { x, z } = cellCentre(grid, column, row)
      if (z < -66) continue
      const near = z > 2
      // The whole drift area stays over land, with a margin the smoothed bank cannot erode.
      const height = cornerMax(composition, x, z, 1)
      if (Number.isNaN(height)) continue
      sites.push({ x, z, height, driftRadius: near ? 0.12 : 0.3 })
    }
  const lamps: LakeLamp[] = []
  const regions = ['left', 'right', 'left', 'right']
  if (hash(seed, 0, 0, 499) > 0.35) regions.push('front')
  if (!mobile) regions.push('far', 'far')
  const clearance = mobile ? 8 : 12
  for (const [index, region] of regions.entries()) {
    const separated = sites.filter((site) =>
      lamps.every(
        (lamp) =>
          Math.hypot(lamp.x - site.x, lamp.z - site.z) >
          clearance + (lamp.driftRadius + site.driftRadius) * Math.hypot(1, 0.7),
      ),
    )
    const regional = separated.filter((site) =>
      region === 'front'
        ? site.z > 3
        : region === 'far'
          ? site.z < -40
          : site.z < 0 && site.z > -40 && (region === 'left' ? site.x < 0 : site.x > 0),
    )
    const ranked = regional
      .map((site) => ({
        site,
        rank: hash(seed, Math.round(site.x * 100), Math.round(site.z * 100), 501 + index),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ site }) => site)
    const hover = 0.65 + hash(seed, index, 0, 521) * 0.85
    // Keep the randomly chosen lights in view and in front of intervening hills.
    const visible = (site: Site) => {
      const y = site.height + hover
      const pitch = mobile ? 0 : Math.atan2(5, 41)
      const depth = (16 - site.z) * Math.cos(pitch) + (y - 2.3) * Math.sin(pitch)
      const up = (y - 2.3) * Math.cos(pitch) - (16 - site.z) * Math.sin(pitch)
      const halfView = depth * Math.tan((54 * Math.PI) / 360)
      if (
        Math.abs(site.x) > halfView * (mobile ? 0.46 : 1.6) * 0.85 ||
        up < -halfView * 0.85 ||
        up > halfView * 0.8
      )
        return false
      const steps = Math.ceil(Math.hypot(site.x, 16 - site.z) / (grid.cell * 0.5))
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        const ground = cellTopAt(composition, site.x * (1 - t), mix(site.z, 16, t))
        if (ground > mix(y - 0.25, 2.3, t)) return false
      }
      return true
    }
    const fallback = separated.filter((site) =>
      region === 'left'
        ? site.x < 0 && site.z < 0
        : region === 'right'
          ? site.x > 0 && site.z < 0
          : region === 'front'
            ? site.z > 3
            : site.z < 0,
    )
    const site = ranked.find(visible) ?? fallback.find(visible)
    if (!site) continue
    lamps.push({
      x: site.x,
      y: site.height + hover,
      groundY: site.height,
      z: site.z,
      intensity: 0.65 + hash(seed, index, 0, 523) * 0.35,
      phase: hash(seed, index, 0, 527) * Math.PI * 2,
      speed: 0.35 + hash(seed, index, 0, 529) * 0.4,
      amplitude: 0.1 + hash(seed, index, 0, 531) * 0.12,
      driftRadius: site.driftRadius,
    })
  }
  return lamps
}

/** Trees colonize the mid-ground islets first, then high ground elsewhere. */
function placeTrees(
  field: TerrainField,
  seed: number,
  mobile: boolean,
  waterfall: WaterfallSite | null,
  islets: readonly Islet[],
): LakeTree[] {
  // Soft, open ground: above the bank, not on rock or a face, clear of the fall.
  type Site = { x: number; top: number; z: number; spread: number }
  const clear: Site[] = []
  for (let row = 0; row < field.rows - 1; row++)
    for (let column = 0; column < field.columns - 1; column++) {
      const x = field.minX + (column + 0.5) * field.cell,
        z = field.minZ + (row + 0.5) * field.cell
      if (z >= 0) continue
      const top = sampleHeight(field, x, z)
      if (top <= 0.4 || sampleRock(field, x, z) > 0.5 || sampleNormal(field, x, z)[1] < 0.8)
        continue
      if (waterfall && (x - waterfall.x) ** 2 + (z - waterfall.z) ** 2 <= 6.25) continue
      clear.push({ x, top, z, spread: hash(seed, Math.round(x * 10), Math.round(z * 10), 911) })
    }
  const midground = clear
    .filter((site) => site.z < -3 && site.z > -40)
    .sort((a, b) => b.spread - a.spread)
  const ridges = clear.filter((site) => site.z >= -3 || site.z <= -40).sort((a, b) => b.top - a.top)
  const cap = mobile ? 20 : 72
  const trees: LakeTree[] = []
  const plant = (site: Site, gate: number, size = 1) => {
    if (trees.length >= cap) return
    const xi = Math.round(site.x * 10),
      zi = Math.round(site.z * 10)
    // Groves rather than an even sprinkle: a slow field opens clearings between stands.
    const grove = smoothNoise(seed, site.x, site.z, 7, 917)
    if (site.spread < gate + (0.45 - grove) * 0.8) return
    if (trees.some((tree) => (tree.x - site.x) ** 2 + (tree.z - site.z) ** 2 < TREE_SPACING ** 2))
      return
    // Trees grow toward the horizon, which deepens the layered forest (Last Signal's diorama).
    const depth = clamp((-site.z - 8) / 50, 0, 1)
    const pick = hash(seed, xi, zi, 919)
    const kind: TreeKind = site.z > -40 && pick < 0.34 ? 'birch' : pick < 0.72 ? 'spruce' : 'pine'
    // The trunk sits at the lowest ground under it, so no root hangs over a slope.
    const y = Math.min(
      ...[
        [0, 0],
        [0.12, 0],
        [-0.12, 0],
        [0, 0.12],
        [0, -0.12],
      ].map(([dx = 0, dz = 0]) => sampleHeight(field, site.x + dx, site.z + dz)),
    )
    trees.push({
      x: site.x,
      y,
      z: site.z,
      scale: (0.85 + hash(seed, xi, zi, 913) * 0.45) * (1 + depth * 0.35) * size,
      kind,
      yaw: hash(seed, xi, zi, 921) * Math.PI * 2,
    })
  }
  // Last Signal's islets each carry a tree on their crown: the highest open ground, nearest
  // the centre on a tie, so a bare mound never reads as a pile of stone.
  for (const islet of islets) {
    const crown = clear
      .filter(
        (site) =>
          Math.abs(profileX(site.x, mobile) - islet.x) < islet.width &&
          Math.abs(site.z - islet.z) < islet.depth,
      )
      .sort(
        (a, b) =>
          b.top - a.top ||
          Math.hypot(profileX(a.x, mobile) - islet.x, a.z - islet.z) -
            Math.hypot(profileX(b.x, mobile) - islet.x, b.z - islet.z),
      )[0]
    if (crown) plant(crown, -Infinity, ISLET_TREE_SCALE)
  }
  for (const site of midground) {
    // Most trees go to the visible mid-ground islets; ridges take the rest.
    if (trees.length >= cap * 0.7) break
    plant(site, 0.3)
  }
  for (const site of midground.concat(ridges)) plant(site, 0.45)
  return trees
}

/** The waterfall's pool, lip and plunge, as constraints on the smooth ground. */
function waterfallProtection(fall: WaterfallSite): ProtectedArea[] {
  const protect: ProtectedArea[] = []
  for (const cell of fall.basin) {
    protect.push({ x: cell.x, z: cell.z, radius: cell.size * 0.6 })
    protect.push({ x: cell.x, z: cell.z, radius: cell.size * 1.1, mode: 'raise' })
  }
  const [nx, nz] = fall.direction
  // The lip, the face right under it and the plunge in front stay where the sheet expects
  // them: no smoothed slope may creep into the landing.
  for (let along = -0.2; along <= 1.21; along += 0.1)
    protect.push({
      x: fall.x + nx * along,
      z: fall.z + nz * along,
      // The sill keeps its full width; wider over the plunge so no bank creeps toward the
      // landing, narrow in between so the rim beside the face still slopes.
      radius:
        fall.width / 2 + (along > 0.15 ? 0.5 : along < 0 ? (fall.basin[0]?.size ?? 0.25) : 0.05),
    })
  // Small circles, so the open-water zone never reaches back over the lip (its falloff
  // ends at least 5 cm in front of it).
  const across = fall.width / 2 + 0.6
  for (let along = 0.65; along <= 1.21; along += 0.2)
    for (let side = -across; side <= across + 1e-6; side += 0.3)
      protect.push({
        x: fall.x + nx * along + nz * side,
        z: fall.z + nz * along - nx * side,
        radius: 0.35,
        mode: 'water',
      })
  return protect
}

/**
 * Build a single scene-sized lake: close heavy left shore, a deliberately empty middle water
 * corridor, a recessed right bank and detached islets. The output contains no Three dependency.
 */
export function createLakeWorld(seed: number, mobile: boolean): LakeWorld {
  const root = seed >>> 0
  const shape = terrainShape(root, mobile)
  const variant: LakeWorldVariant = mobile ? 'mobile' : 'desktop'
  const cell = mobile ? 0.28 : 0.25
  // The tall rear bank reaches past the sides of the frame, so its crest stays in view.
  const xCells = mobile ? 101 : 297
  const zNear = 7
  const zCells = mobile ? 231 : 302
  const gridTop = Math.ceil((13.2 - (zNear + cell / 2)) / cell)
  const grid: TerrainGrid = {
    minX: -(xCells + 0.5) * cell,
    minZ: zNear + cell / 2 - zCells * cell,
    cell,
    columns: 2 * xCells + 2,
    rows: zCells + 1 + gridTop,
  }
  const coast = (x: number, z: number) => coastField(root, x, z, mobile, shape)
  const foreground: Foreground = {
    minX: mobile ? -4.2 : -12,
    maxX: mobile ? -0.08 : -0.55,
    start: mobile ? 5 : 3,
    end: 13,
  }
  const foregroundShift = (hash(root, 0, 0, 401) - 0.5) * (mobile ? 0.22 : 0.7)

  // Compose the ground on every corner: the lake's banks, then the near shore under the camera.
  const count = grid.columns * grid.rows
  const heights = new Float32Array(count).fill(Number.NaN)
  const rock = new Float32Array(count)
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++) {
      const i = row * grid.columns + column
      const x = grid.minX + column * cell,
        z = grid.minZ + row * cell
      if (z <= zNear + cell / 2 && Math.abs(x) <= xCells * cell + cell / 2) {
        const value = coast(x, z)
        if (value > 0) {
          heights[i] = heightAt(root, x, z, value, mobile, shape)
          rock[i] = rockAt(root, x, z, value, mobile)
        }
      }
      const near = foregroundAt(root, x, z, mobile, foregroundShift, foreground)
      if (near && !(near.height <= (heights[i] ?? Number.NaN))) {
        heights[i] = near.height
        rock[i] = near.rock
      }
    }
  const composition: Composition = { grid, heights, rock, ...cellTops(grid, heights) }
  const stones = waterStones(root, mobile, grid, heights, zNear)

  const lamps = placeLamps(root, mobile, composition)
  const carve = selectWaterfall(root, mobile, composition, stones, lamps)
  const waterfall = carve?.fall ?? null
  if (carve) applyCarve(composition, carve)

  const { field, islands } = createTerrainField({
    grid,
    heights,
    rock,
    seed: root,
    mobile,
    protect: waterfall ? waterfallProtection(waterfall) : [],
  })
  const height = (x: number, z: number) => sampleHeight(field, x, z)
  const trees = placeTrees(field, root, mobile, waterfall, shape.islets)
  // Lanterns keep their hover above the highest smoothed ground under their drift.
  const placedLamps = lamps.map((lamp) => {
    const groundY = height(lamp.x, lamp.z)
    let highest = groundY
    for (const dx of [-1, 0, 1])
      for (const dz of [-1, 0, 1])
        highest = Math.max(
          highest,
          height(lamp.x + dx * (lamp.driftRadius + 0.1), lamp.z + dz * (lamp.driftRadius + 0.1)),
        )
    return { ...lamp, groundY, y: highest + (lamp.y - lamp.groundY) }
  })
  const shoreStones: TerrainIsland[] = [
    ...stones.map((stone) => ({ x: stone.x, z: stone.z, top: stone.top, extent: stone.size * 2 })),
    ...islands,
  ]
  const boulders = placeBoulders(
    field,
    shoreStones,
    root,
    mobile,
    [
      ...placedLamps.map((lamp) => ({ x: lamp.x, z: lamp.z, radius: lamp.driftRadius + 0.6 })),
      ...trees.map((tree) => ({ x: tree.x, z: tree.z, radius: 0.35 * tree.scale })),
      // The camera's own bank stays walkable turf; only small stones near the lens.
      { x: 0, z: 16, radius: 4 },
    ],
    waterfall,
  )
  const lakeBed = createLakeBedFromTerrain(
    {
      height,
      boulders: boulders.map((boulder) => ({
        x: boulder.x,
        z: boulder.z,
        top: boulder.y + boulder.size[1],
        footprint: Math.max(boulder.size[0], boulder.size[2]),
        // Where the boulder crosses the water line, roughly.
        radius:
          Math.max(boulder.size[0], boulder.size[2]) *
          Math.sqrt(Math.max(0, 1 - ((WATER_LEVEL - boulder.y) / boulder.size[1]) ** 2)) *
          0.85,
      })),
    },
    root,
    mobile,
  )
  return {
    variant,
    seed: root,
    lakeBed,
    waterfall,
    lamps: placedLamps,
    trees,
    field,
    boulders,
    bounds: {
      minX: -xCells * cell,
      maxX: xCells * cell,
      minZ: zNear - (zCells - 1) * cell,
      maxZ: 13,
    },
    suggestedCamera: {
      position: [0, 2.5, 16],
      target: [0, 1.4, -20],
      fov: mobile ? 48 : 43,
    },
  }
}

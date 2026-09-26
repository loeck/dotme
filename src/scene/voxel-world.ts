import { required } from '../invariant'
import { createLakeBed, lakeIndex, LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'

/**
 * Deterministic, renderer-agnostic voxel data for the low lake composition. Coordinates are
 * Three.js world coordinates: x horizontal, y up, z depth; water is the y = 0 plane.
 */
export type VoxelWorldVariant = 'desktop' | 'mobile'

export type VoxelMaterial = 'ground' | 'shore' | 'rock'

export type VoxelGroup = Readonly<{
  /** Center positions, three floats per unit voxel: ready for THREE.InstancedMesh. */
  positions: Float32Array
  count: number
}>

export type VoxelLamp = Readonly<{
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

export type VoxelWaterfall = Readonly<{
  basin: readonly Readonly<{ x: number; z: number; size: number }>[]
  direction: readonly [number, number]
  x: number
  z: number
  top: number
  width: number
  seed: number
}>

export type VoxelWorldData = Readonly<{
  version: 'lake-voxel-v1'
  variant: VoxelWorldVariant
  seed: number
  voxelSize: number
  lakeBed: LakeBed
  waterfall: VoxelWaterfall | null
  /** Material groups are deliberately separate so a renderer can use one InstancedMesh each. */
  groups: Readonly<Record<VoxelMaterial, VoxelGroup>>
  /** Top-most shoreline voxels, useful for a subtle wet edge or reflected-light pass. */
  shores: Float32Array
  shoreCount: number
  lamps: readonly VoxelLamp[]
  bounds: Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>
  suggestedCamera: Readonly<{
    position: readonly [number, number, number]
    target: readonly [number, number, number]
    fov: number
  }>
}>

export type Voxel = Readonly<{ x: number; y: number; z: number; size: number; color: number }>

/** Compatibility-oriented public result: flat voxels for a simple renderer, plus grouped data. */
export type VoxelWorld = VoxelWorldData & Readonly<{ voxels: Voxel[] }>

const TERRAIN_VARIANTS = {
  ground: [0x1b2b36, 0x273944, 0x344955],
  shore: [0x263b46, 0x354c57, 0x45606b],
  rock: [0x22343f, 0x304651, 0x405963],
} as const

type MutableGroups = Record<VoxelMaterial, number[]>
type Cell = Readonly<{ x: number; z: number; height: number }>
type SurfaceCell = Cell & Readonly<{ xi: number; zi: number; size: number }>
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

const MATERIALS: readonly VoxelMaterial[] = ['ground', 'shore', 'rock']

// Keep exposed footings below the lake trough: -0.035 level, up to 0.083 wind
// displacement and 0.22 simulated displacement, plus a small immersion margin.
const WATER_CONTACT_Y = -0.4

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount
const dimColor = (color: number, factor: number) =>
  (Math.round(((color >> 16) & 255) * factor) << 16) |
  (Math.round(((color >> 8) & 255) * factor) << 8) |
  Math.round((color & 255) * factor)

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

/** Broad seeded changes are visible from the camera; fine noise only changes tile detail. */
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
      z: z + (hash(seed, index, 0, 829) - 0.5) * 2.4,
      width: width * mix(0.85, 1.08, hash(seed, index, 0, 831)),
      depth: depth * mix(0.86, 1.1, hash(seed, index, 0, 833)),
      heightScale: mix(0.55, 0.75, hash(seed, index, 0, 835)) * (mobile ? 0.65 : 1),
    })),
    nearHeadlandX: -19 + variation(803) * (mobile ? 2.4 : 2.8),
    nearHeadlandWidth: 15.5 + variation(805) * (mobile ? 1.4 : 1.8),
    outerHeadlandWidth: 24.5 + variation(807) * 2.4,
    rightBankX: 44 + variation(809) * 2.5,
    rightBankWidth: 18.5 + variation(811) * 1.8,
    inletWidth: 7.2 + variation(813) * 0.8,
    inletMouthX: (mobile ? -3 : -11.5) + variation(815) * (mobile ? 0.8 : 1.2),
    inletMouthWidth: (mobile ? 5.5 : 4.3) + variation(817) * 0.5,
    nearHillHeight: 1.05 + variation(819) * 0.22,
    leftRidgeHeight: variation(821) * 0.5,
    leftSlopeHeight: 4.2 + variation(823) * 0.45,
  }
}

function addVoxel(group: number[], x: number, y: number, z: number) {
  group.push(x, y, z)
}

/** Only add layers exposed above a lower neighbor; the hidden interior stays empty. */
function addClosedColumn(
  group: number[],
  x: number,
  z: number,
  top: number,
  lower: number,
  size: number,
) {
  const footing = lower <= 0 ? Math.min(lower, WATER_CONTACT_Y) : lower
  const layers = Math.max(1, Math.ceil((top - footing) / size - 1e-6))
  for (let layer = 0; layer < layers; layer += 1) addVoxel(group, x, top - (layer + 0.5) * size, z)
}

/** The portrait layout pulls the two banks into the narrow camera frustum. */
function profileX(x: number, mobile: boolean) {
  return mobile ? x * 2.8 : x
}

function coastField(seed: number, x: number, z: number, mobile: boolean, shape: TerrainShape) {
  const px = profileX(x, mobile)
  const ellipse = (cx: number, cz: number, rx: number, rz: number) =>
    1 - Math.hypot((px - cx) / rx, (z - cz) / rz)
  // The left shore is two unequal headlands backed by a broad hill. Their wet edges are
  // separate; the deep notch between them stops the shoreline becoming one masonry wall.
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
    // A rear shoulder connects the low shore to the high, right-hand voxel ridge.
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
  // Stochastic rounding preserves the slope but stops neighboring cells forming long courses.
  const step = mobile ? 0.28 : 0.25
  // Connected rocky patches interrupt broad terraces without separating their blocks.
  const surfaceRelief =
    (smoothNoise(seed, x, z, step * 4, 173) - 0.5) * step * 2.4 +
    (smoothNoise(seed, x, z, step * 9, 179) - 0.5) * step * 2
  const elevation = clamp(
    0.2 +
      shoreRise +
      mass * (px < 0 && z > -32 ? 0.76 : 1) +
      distant +
      broad +
      middle +
      pebbles +
      surfaceRelief * (mobile ? 0.65 : 1),
    0.28,
    11,
  )
  const islet = shape.islets.find(
    (island) =>
      Math.abs(px - island.x) < island.width * 1.4 && Math.abs(z - island.z) < island.depth * 1.4,
  )
  const levels = Math.max(step, elevation * (islet?.heightScale ?? 1)) / step
  const whole = Math.floor(levels)
  const fraction = levels - whole
  return (
    (whole + (hash(seed, Math.round(x / step), Math.round(z / step), 159) < fraction ? 1 : 0)) *
    step
  )
}

function freezeGroup(values: number[]) {
  return { positions: new Float32Array(values), count: values.length / 3 }
}

const cellKey = (x: number, z: number) => `${x}:${z}`

/** Pick an exposed shore with an independent stream, keeping terrain and lamp randomness stable. */
function selectWaterfall(
  seed: number,
  mobile: boolean,
  columns: readonly SurfaceCell[],
  surface: ReadonlyMap<string, SurfaceCell>,
  voxels: Voxel[],
  groups: MutableGroups,
  lamps: readonly VoxelLamp[],
  lakeBed: LakeBed,
  voxelSize: number,
  zNear: number,
): VoxelWaterfall | null {
  if (hash(seed, 0, 0, 911) >= 0.58) return null
  const desiredWidth = mix(mobile ? 0.7 : 1.5, mobile ? 1 : 2, hash(seed, 0, 0, 919))
  const landingOffset = 0.8
  const candidates = columns
    .flatMap((cell) => {
      const x = profileX(cell.x, mobile)
      if (x < -38 || x > -13 || cell.z < -34 || cell.z > -12) return []
      return (
        [
          [1, 0],
          [0, 1],
        ] as const
      )
        .filter(([nx, nz]) => !surface.has(cellKey(cell.xi + nx, cell.zi - nz)))
        .flatMap((direction) =>
          [desiredWidth, mobile ? 0.7 : 1.5].flatMap((width) =>
            [0, 0.5, -0.5].map((offset) => ({
              cell,
              direction,
              width,
              offset: offset * voxelSize,
            })),
          ),
        )
    })
    .toSorted(
      (a, b) =>
        (mobile ? b.direction[1] - a.direction[1] : 0) ||
        hash(seed, a.cell.xi, a.cell.zi, 929) - hash(seed, b.cell.xi, b.cell.zi, 929),
    )
  for (const { cell, direction, width, offset } of candidates) {
    const [nx, nz] = direction
    const top = mobile ? voxelSize * 7 : 2
    const centerX = cell.x + nz * offset,
      centerZ = cell.z - nx * offset
    const x = centerX + nx * (cell.size / 2 + 0.03)
    const z = centerZ + nz * (cell.size / 2 + 0.03)
    if (z < -34 || z > -12) continue
    // A physically exposed sheet must also face the camera enough to show its width.
    const facing = (-x * nx + (16 - z) * nz) / Math.hypot(x, 16 - z)
    if (facing < 0.35) continue
    const halfView = (16 - z) * Math.tan((54 * Math.PI) / 360) * (mobile ? 0.46 : 1.6)
    if (Math.abs(x) + width / 2 > halfView * 0.92) continue
    if (lamps.some((lamp) => Math.hypot(lamp.x - x, lamp.z - z) < 2.2)) continue
    const halfWidth = width / 2
    const samples = Math.ceil(width / (voxelSize / 2))
    let supported = true
    for (let i = 0; i <= samples; i++) {
      const along = -halfWidth + (width * i) / samples
      const landing = lakeIndex(
        lakeBed,
        x + nz * along + nx * landingOffset,
        z - nx * along + nz * landingOffset,
      )
      if (
        landing < 0 ||
        lakeBed.water[landing] !== 255 ||
        required(lakeBed.obstacle[landing]) >= WATER_LEVEL
      ) {
        supported = false
        break
      }
    }
    if (!supported) continue
    if (
      voxels.some((voxel) => {
        const half = voxel.size / 2
        const along = (voxel.x - x) * nx + (voxel.z - z) * nz
        const across = (voxel.x - x) * nz - (voxel.z - z) * nx
        if (
          along + half <= 0 ||
          along - half >= landingOffset ||
          Math.abs(across) >= halfWidth + half
        )
          return false
        const last = clamp((along + half) / landingOffset, 0, 1)
        const streamBottom = mix(top, WATER_LEVEL, last * last)
        return voxel.y + half > streamBottom - 0.015
      })
    )
      continue
    // Reject a fall hidden behind another bank, using the same actual terrain surface.
    const steps = Math.ceil(Math.hypot(x, 16 - z) / voxelSize)
    let visible = true
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const rayX = x * (1 - t),
        rayZ = mix(z, 16, t)
      const blocker = surface.get(
        cellKey(Math.round(rayX / voxelSize), Math.round((zNear - rayZ) / voxelSize)),
      )
      if (blocker && blocker.height > mix(top * 0.5, 2.5, t)) {
        visible = false
        break
      }
    }
    if (!visible) continue
    // An upstream pool widens behind the narrow outlet. Its floor and banks
    // replace the actual terrain columns, so water never lies over solid rock.
    const basinHalfWidth = mobile ? 1.0 : 1.75
    const basinDepth = mobile ? 2.24 : 3
    const basinCenter = basinDepth * 0.56
    const basinRadius = basinDepth * 0.44
    const basin = new Map<string, SurfaceCell>()
    let existingWaterCells = 0
    for (let row = 0; row <= Math.floor(basinDepth / voxelSize); row++) {
      const behind = row * voxelSize
      const ellipse =
        basinHalfWidth * Math.sqrt(Math.max(0, 1 - ((behind - basinCenter) / basinRadius) ** 2))
      for (
        let side = -Math.ceil(basinHalfWidth / voxelSize) - 1;
        side <= Math.ceil(basinHalfWidth / voxelSize) + 1;
        side++
      ) {
        const px = cell.x - nx * behind + nz * side * voxelSize
        const pz = cell.z - nz * behind - nx * side * voxelSize
        const signedAcross = (px - centerX) * nz - (pz - centerZ) * nx
        const phase = hash(seed, cell.xi, cell.zi, 947) * Math.PI * 2
        const shape =
          1 +
          Math.sin(behind * 1.3 + phase) * 0.09 +
          Math.sign(signedAcross) * Math.cos(behind * 1.7 + phase) * 0.06
        const openWidth = Math.max(behind < basinCenter ? halfWidth : 0, ellipse * shape)
        if (Math.abs(signedAcross) >= openWidth + 1e-6) continue
        const key = cellKey(Math.round(px / voxelSize), Math.round((zNear - pz) / voxelSize))
        const existing = surface.get(key)
        if (existing) existingWaterCells++
        basin.set(
          key,
          existing ?? {
            x: px,
            z: pz,
            height: WATER_CONTACT_Y,
            xi: Math.round(px / voxelSize),
            zi: Math.round((zNear - pz) / voxelSize),
            size: voxelSize,
          },
        )
      }
    }
    if (basin.size < (mobile ? 10 : 20) || existingWaterCells < basin.size * 0.7) continue
    const patch = new Map<string, SurfaceCell>()
    for (const [key, support] of basin) patch.set(key, { ...support, height: top - voxelSize })
    for (const support of basin.values()) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const xi = support.xi + dx,
          zi = support.zi + dz
        const key = cellKey(xi, zi)
        if (basin.has(key)) continue
        // This is the only opening: the front face of the first channel row.
        const behind = (cell.x - xi * voxelSize) * nx + (cell.z - (zNear - zi * voxelSize)) * nz
        if (behind < -1e-6) continue
        const bank = surface.get(key) ?? {
          x: xi * voxelSize,
          z: zNear - zi * voxelSize,
          height: WATER_CONTACT_Y,
          xi,
          zi,
          size: voxelSize,
        }
        patch.set(key, { ...bank, height: top + voxelSize })
      }
    }
    // Blend the small raised reservoir back into the original bank, rather
    // than leaving a uniform retaining wall around its entire perimeter.
    let rim = [...patch.values()].filter((support) => !basin.has(cellKey(support.xi, support.zi)))
    for (let ring = 0; ring < (mobile ? 2 : 3); ring++) {
      const next: SurfaceCell[] = []
      for (const edge of rim) {
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const key = cellKey(edge.xi + dx, edge.zi + dz)
          if (patch.has(key)) continue
          const support = surface.get(key)
          if (!support) continue
          const behind = (cell.x - support.x) * nx + (cell.z - support.z) * nz
          if (behind < -1e-6) continue
          const drop = voxelSize * (hash(seed, support.xi, support.zi, 953) > 0.55 ? 3 : 2)
          const height = Math.max(support.height, edge.height - drop)
          if (height <= support.height + 1e-6) continue
          const terrace = { ...support, height }
          patch.set(key, terrace)
          next.push(terrace)
        }
      }
      rim = next
    }
    if (
      lamps.some((lamp) =>
        [...patch.values()].some(
          (support) => Math.hypot(lamp.x - support.x, lamp.z - support.z) < 0.7,
        ),
      )
    )
      continue
    // Excavation exposes formerly hidden sides of neighboring columns. Keep
    // their original tops, but rebuild the perimeter down to the new lower floor.
    const perimeter = [...patch.values()]
    for (const support of perimeter) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const key = cellKey(support.xi + dx, support.zi + dz)
        const adjacent = surface.get(key)
        if (!patch.has(key) && adjacent) patch.set(key, adjacent)
      }
    }
    const positions: number[] = []
    for (const support of patch.values()) {
      let lower = support.height
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const key = cellKey(support.xi + dx, support.zi + dz)
        lower = Math.min(lower, (patch.get(key) ?? surface.get(key))?.height ?? WATER_CONTACT_Y)
      }
      addClosedColumn(positions, support.x, support.z, support.height, lower, voxelSize)
    }
    const landingCells = new Set<number>()
    for (let sample = 0; sample <= samples; sample++) {
      const across = -halfWidth + (width * sample) / samples
      landingCells.add(
        lakeIndex(
          lakeBed,
          x + nz * across + nx * landingOffset,
          z - nx * across + nz * landingOffset,
        ),
      )
    }
    const rasterSize = LAKE_BOUNDS.size / lakeBed.resolution
    for (const support of patch.values()) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const adjacentKey = cellKey(support.xi + dx, support.zi + dz)
        if (basin.has(adjacentKey)) continue
        const adjacent =
          (patch.get(adjacentKey) ?? surface.get(adjacentKey))?.height ?? WATER_CONTACT_Y
        for (
          let ledgeTop = support.height - voxelSize;
          ledgeTop > Math.max(adjacent, 0) + voxelSize;
          ledgeTop -= voxelSize
        ) {
          const layer = Math.round(ledgeTop / voxelSize)
          if (hash(seed, support.xi + layer, support.zi, 967) < 0.35) continue
          const projection =
            voxelSize * mix(0.24, 0.78, hash(seed, support.xi, support.zi + layer, 971))
          const px = support.x + dx * projection,
            pz = support.z - dz * projection
          const half = voxelSize / 2
          const along = (px - x) * nx + (pz - z) * nz
          const across = (px - x) * nz - (pz - z) * nx
          if (
            Math.abs(across) < halfWidth + half &&
            along + half > 0 &&
            along - half < landingOffset
          ) {
            const last = clamp((along + half) / landingOffset, 0, 1)
            if (ledgeTop > mix(top, WATER_LEVEL, last * last) - 0.04) continue
          }
          let blocksLanding = false
          for (let sz = pz - half; sz <= pz + half + rasterSize; sz += rasterSize)
            for (let sx = px - half; sx <= px + half + rasterSize; sx += rasterSize) {
              if (
                landingCells.has(
                  lakeIndex(lakeBed, Math.min(sx, px + half), Math.min(sz, pz + half)),
                )
              )
                blocksLanding = true
            }
          if (blocksLanding) continue
          addVoxel(positions, px, ledgeTop - half, pz)
        }
      }
    }
    const edited: MutableGroups = { ground: [], shore: [], rock: [] }
    for (const material of MATERIALS) {
      const original = groups[material]
      for (let index = 0; index < original.length; index += 3) {
        const px = required(original[index]),
          py = required(original[index + 1]),
          pz = required(original[index + 2])
        const key = cellKey(Math.round(px / voxelSize), Math.round((zNear - pz) / voxelSize))
        if (!patch.has(key)) addVoxel(edited[material], px, py, pz)
      }
    }
    const count =
      (edited.ground.length + edited.shore.length + edited.rock.length + positions.length) / 3
    if (mobile && count >= 22_000) continue
    edited.ground.push(...positions)
    for (const material of MATERIALS) groups[material] = edited[material]
    return {
      basin: [...basin.values()].map((support) => ({
        x: support.x,
        z: support.z,
        size: voxelSize,
      })),
      x,
      z,
      top,
      width,
      direction,
      seed: Math.floor(hash(seed, cell.xi, cell.zi, 937) * 0x1_0000_0000),
    }
  }
  return null
}

/**
 * Build a single scene-sized lake: close heavy left shore, a deliberately empty middle water
 * corridor, a recessed right bank and detached islets. The output contains no Three dependency.
 */
export function createVoxelWorld(seed: number, mobile: boolean): VoxelWorld {
  const root = seed >>> 0
  const shape = terrainShape(root, mobile)
  const variant: VoxelWorldVariant = mobile ? 'mobile' : 'desktop'
  const voxelSize = mobile ? 0.28 : 0.25
  // The tall rear bank extends beyond the old desktop grid, so its crest remains in frame.
  const xCells = mobile ? 101 : 297
  const zNear = 7
  const zCells = mobile ? 231 : 302
  // Place the coarse boundary on a shared grid edge, so both resolutions meet exactly.
  const farRow = Math.ceil(((zNear + 44) / voxelSize + 0.5) / 2) * 2
  const farBoundaryZ = zNear - (farRow - 0.5) * voxelSize
  const terrainSizeAt = (z: number) => voxelSize * (z > 2 ? 0.5 : z < farBoundaryZ ? 2 : 1)
  const groups: MutableGroups = {
    ground: [],
    shore: [],
    rock: [],
  }
  const addWetVoxel = (group: number[], x: number, z: number) => {
    const size = terrainSizeAt(z)
    // Center the visible stone at Y = 0 and keep its support below the wave trough.
    addClosedColumn(group, x, z, size / 2, WATER_CONTACT_Y, size)
  }
  const shores: number[] = []
  const land = new Map<string, Cell>()

  for (let zi = 0; zi < zCells; zi += 1) {
    const z = zNear - zi * voxelSize
    for (let xi = -xCells; xi <= xCells; xi += 1) {
      const x = xi * voxelSize
      const coast = coastField(root, x, z, mobile, shape)
      if (coast <= 0) continue
      const height = heightAt(root, x, z, coast, mobile, shape)
      land.set(cellKey(xi, zi), { x, z, height })
    }
  }

  // Keep the original near/far voxel sizes and render only the top and exposed side layers.
  const surface = new Map<string, SurfaceCell>()
  const columns: SurfaceCell[] = []
  for (const cell of land.values()) {
    const xi = Math.round(cell.x / voxelSize)
    const zi = Math.round((zNear - cell.z) / voxelSize)
    if (surface.has(cellKey(xi, zi))) continue
    const span = zi >= farRow ? 2 : 1
    const anchorX = span === 2 ? Math.floor((xi + xCells) / 2) * 2 - xCells : xi
    const anchorZ = span === 2 ? farRow + Math.floor((zi - farRow) / 2) * 2 : zi
    let height = cell.height
    for (let dz = 0; dz < span; dz += 1)
      for (let dx = 0; dx < span; dx += 1)
        height = Math.max(height, land.get(cellKey(anchorX + dx, anchorZ + dz))?.height ?? 0)
    const column: SurfaceCell = {
      x: (anchorX + (span - 1) / 2) * voxelSize,
      z: zNear - (anchorZ + (span - 1) / 2) * voxelSize,
      height,
      xi: anchorX,
      zi: anchorZ,
      size: voxelSize * span,
    }
    columns.push(column)
    for (let dz = 0; dz < span; dz += 1)
      for (let dx = 0; dx < span; dx += 1) surface.set(cellKey(anchorX + dx, anchorZ + dz), column)
  }
  for (const column of columns) {
    const span = Math.round(column.size / voxelSize)
    let lower = column.height
    for (let offset = 0; offset < span; offset += 1) {
      for (const [nx, nz] of [
        [column.xi - 1, column.zi + offset],
        [column.xi + span, column.zi + offset],
        [column.xi + offset, column.zi - 1],
        [column.xi + offset, column.zi + span],
      ] as const)
        lower = Math.min(lower, surface.get(cellKey(nx, nz))?.height ?? 0)
    }
    const coast = coastField(root, column.x, column.z, mobile, shape)
    const material: VoxelMaterial =
      coast < 0.095
        ? 'shore'
        : smoothNoise(root, profileX(column.x, mobile), column.z, 4.2, 191) > 0.7
          ? 'rock'
          : 'ground'
    addClosedColumn(groups[material], column.x, column.z, column.height, lower, column.size)

    // Break up flat near-bank faces with overlapping rock ledges. The closed
    // column remains behind each ledge, including where the relief recedes.
    if (span !== 1 || column.x >= 0 || column.z < -40) continue
    const neighborTop = surface.get(cellKey(column.xi + 1, column.zi))?.height ?? WATER_CONTACT_Y
    for (
      let top = column.height;
      top - column.size >= Math.max(neighborTop, 0) - 1e-6;
      top -= column.size
    ) {
      const y = top - column.size / 2
      const along = column.z + column.x * 0.37
      const relief = smoothNoise(root, along, y, column.size * 2.2, 461)
      if (relief < (mobile ? 0.94 : 0.57)) continue
      const projection = column.size * mix(0.35, 0.75, clamp((relief - 0.57) / 0.25, 0, 1))
      addVoxel(groups[material], column.x + projection, y - column.size * 0.08, column.z)
    }
  }

  const lamps: VoxelLamp[] = []

  for (const cell of land.values()) {
    const xi = Math.round(cell.x / voxelSize)
    const zi = Math.round((zNear - cell.z) / voxelSize)
    const waterAhead = !land.has(cellKey(xi, zi - 1))
    if (waterAhead) {
      shores.push(cell.x, cell.height, cell.z)
      // Single separated blocks on the wet edge keep it granular instead of reading as a wall.
      if (hash(root, xi, zi, 187) > 0.915) {
        addWetVoxel(groups.shore, cell.x, cell.z + voxelSize * 1.2)
        if (hash(root, xi, zi, 189) > 0.82)
          addWetVoxel(groups.rock, cell.x + voxelSize, cell.z + voxelSize * 1.8)
      }
    }
  }

  for (const [index, px, z] of [
    [0, -19, -5.8],
    [1, -16, -6.2],
    [2, -12, -7.3],
  ] as const) {
    const x = mobile ? px / 2.8 : px
    const shift = (hash(root, index, 0, 243) - 0.5) * voxelSize * 0.8
    addWetVoxel(groups.shore, x + shift, z)
    if (index === 1) addWetVoxel(groups.rock, x + voxelSize, z - voxelSize)
  }

  // A few broken fingers of stone run off the two left headlands into the water.
  // They sit barely above the surface so they add depth without forming a new bank.
  for (const [cluster, px, z] of [
    [0, -49, -7],
    [1, -36, -8.5],
    [2, -28, -7.5],
    [3, -14, -5.5],
  ] as const) {
    const x = mobile ? px / 2.8 : px
    for (let stone = 0; stone < (mobile ? 5 : 9); stone += 1) {
      const scatter = hash(root, cluster, stone, 247)
      if (scatter < 0.17) continue
      const dx = (hash(root, cluster, stone, 251) - 0.5) * voxelSize * 8
      const dz = (hash(root, cluster, stone, 257) - 0.5) * voxelSize * 7
      addWetVoxel(groups[scatter > 0.72 ? 'rock' : 'shore'], x + dx, z + dz)
    }
  }
  for (const [px, z] of [
    [-41, -8],
    [-39, -10],
    [-36, -8.5],
    [-30, -9],
    [-27, -7.5],
  ] as const) {
    const x = mobile ? px / 2.8 : px
    addWetVoxel(groups.rock, x, z)
  }

  // A low shore enters beneath the camera. Its diagonal, broken wet edge supplies a
  // near plane while the middle of the lake remains open all the way to the horizon.
  // Keep it separate from `land`: the far-bank lights must stay above their shelves.
  const foregroundMinX = mobile ? -4.2 : -12
  const foregroundStep = voxelSize * 0.5
  const foregroundStart = mobile ? 5 : 3
  const foregroundShift = (hash(root, 0, 0, 401) - 0.5) * (mobile ? 0.22 : 0.7)
  const foreground = new Map<string, Cell & { material: VoxelMaterial }>()
  for (let zi = 0; zi < Math.ceil((13 - foregroundStart) / foregroundStep); zi += 1) {
    const z = foregroundStart + zi * foregroundStep
    const advance = clamp((z - foregroundStart) / 7, 0, 1)
    const edge =
      (mobile ? -3 + advance * 2.55 : -12.5 + advance * 8.8) +
      foregroundShift +
      (smoothNoise(root, z, 0, 1.8, 409) - 0.5) * (mobile ? 0.35 : 1.3)
    for (let xi = 0; xi < Math.ceil(-foregroundMinX / foregroundStep); xi += 1) {
      const x = foregroundMinX + xi * foregroundStep
      const depth = edge - x
      const brokenEdge = (smoothNoise(root, x, z, 0.52, 419) - 0.5) * 0.52
      if (depth + brokenEdge < 0 || x > (mobile ? -0.08 : -0.55)) continue
      const detail = hash(root, xi, zi, 421)
      const swell = smoothNoise(root, x, z, 1.45, 431)
      const patches = smoothNoise(root, x, z, foregroundStep * 4, 433)
      const ridges = smoothNoise(root, x, z, foregroundStep * 8, 439)
      const relief = ((patches - 0.5) * 2.6 + (ridges - 0.5) * 2) * foregroundStep
      const height =
        0.03 + clamp(depth / 2.4, 0, 1) * 0.13 + Math.max(0, swell - 0.32) * 0.3 + relief
      foreground.set(cellKey(xi, zi), {
        x,
        z,
        height: Math.max(
          foregroundStep,
          Math.round((height + foregroundStep / 2) / foregroundStep) * foregroundStep,
        ),
        material: depth < 0.26 ? 'shore' : detail > 0.83 ? 'rock' : 'ground',
      })
    }
  }
  for (const cell of foreground.values()) {
    const xi = Math.round((cell.x - foregroundMinX) / foregroundStep)
    const zi = Math.round((cell.z - foregroundStart) / foregroundStep)
    const lower = Math.min(
      ...[
        [xi - 1, zi],
        [xi + 1, zi],
        [xi, zi - 1],
        [xi, zi + 1],
      ].map(([nx, nz]) => foreground.get(cellKey(required(nx), required(nz)))?.height ?? 0),
    )
    addClosedColumn(groups[cell.material], cell.x, cell.z, cell.height, lower, foregroundStep)
  }

  // Pick actual ground cells, with enough land around the whole luminous cube.
  // Stratification spreads the seeded picks across the composition, without fixed positions.
  const lightCandidates = [...columns, ...foreground.values()].flatMap((cell) => {
    if (cell.z < -66 || cell.height > 6) return []
    const near = cell.z > 2
    const step = near ? foregroundStep : voxelSize
    const xi = Math.round((cell.x - (near ? foregroundMinX : 0)) / step)
    const zi = Math.round((near ? cell.z - foregroundStart : zNear - cell.z) / step)
    let height = cell.height
    // Reserve the entire drift area, including diagonals, for the cube's footprint.
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const ground = (near ? foreground : surface).get(cellKey(xi + dx, zi + dz))
        if (!ground) return []
        height = Math.max(height, ground.height)
      }
    return [{ ...cell, height, driftRadius: near ? 0.12 : 0.3 }]
  })
  const regions = ['left', 'right', 'left', 'right']
  if (hash(root, 0, 0, 499) > 0.35) regions.push('front')
  if (!mobile) regions.push('far', 'far')
  const lightClearance = mobile ? 8 : 12
  for (const [index, region] of regions.entries()) {
    const separated = lightCandidates.filter((cell) =>
      lamps.every(
        (lamp) =>
          Math.hypot(lamp.x - cell.x, lamp.z - cell.z) >
          lightClearance + (lamp.driftRadius + cell.driftRadius) * Math.hypot(1, 0.7),
      ),
    )
    const regional = separated.filter((cell) =>
      region === 'front'
        ? cell.z > 3
        : region === 'far'
          ? cell.z < -40
          : cell.z < 0 && cell.z > -40 && (region === 'left' ? cell.x < 0 : cell.x > 0),
    )
    const ranked = regional.toSorted(
      (a, b) =>
        hash(root, Math.round(a.x * 100), Math.round(a.z * 100), 501 + index) -
        hash(root, Math.round(b.x * 100), Math.round(b.z * 100), 501 + index),
    )
    const hover = 0.65 + hash(root, index, 0, 521) * 0.85
    // Keep the randomly chosen lights in view and in front of intervening hills.
    const visible = (cell: Cell) => {
      const y = cell.height + hover
      const pitch = mobile ? 0 : Math.atan2(5, 41)
      const depth = (16 - cell.z) * Math.cos(pitch) + (y - 2.3) * Math.sin(pitch)
      const up = (y - 2.3) * Math.cos(pitch) - (16 - cell.z) * Math.sin(pitch)
      const halfView = depth * Math.tan((54 * Math.PI) / 360)
      if (
        Math.abs(cell.x) > halfView * (mobile ? 0.46 : 1.6) * 0.85 ||
        up < -halfView * 0.85 ||
        up > halfView * 0.8
      )
        return false
      const steps = Math.ceil(Math.hypot(cell.x, 16 - cell.z) / (voxelSize * 0.5))
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        const x = cell.x * (1 - t),
          z = mix(cell.z, 16, t)
        const ground =
          z > 2
            ? foreground.get(
                cellKey(
                  Math.round((x - foregroundMinX) / foregroundStep),
                  Math.round((z - foregroundStart) / foregroundStep),
                ),
              )
            : surface.get(cellKey(Math.round(x / voxelSize), Math.round((zNear - z) / voxelSize)))
        if (ground && ground.height > mix(y - 0.25, 2.3, t)) return false
      }
      return true
    }
    const fallback = separated.filter((cell) =>
      region === 'left'
        ? cell.x < 0 && cell.z < 0
        : region === 'right'
          ? cell.x > 0 && cell.z < 0
          : region === 'front'
            ? cell.z > 3
            : cell.z < 0,
    )
    const cell = ranked.find(visible) ?? fallback.find(visible)
    if (!cell) continue
    lamps.push({
      x: cell.x,
      y: cell.height + hover,
      groundY: cell.height,
      z: cell.z,
      intensity: 0.65 + hash(root, index, 0, 523) * 0.35,
      phase: hash(root, index, 0, 527) * Math.PI * 2,
      speed: 0.35 + hash(root, index, 0, 529) * 0.4,
      amplitude: 0.1 + hash(root, index, 0, 531) * 0.12,
      driftRadius: cell.driftRadius,
    })
  }

  const resultGroups: Record<VoxelMaterial, VoxelGroup> = {
    ground: freezeGroup(groups.ground),
    shore: freezeGroup(groups.shore),
    rock: freezeGroup(groups.rock),
  }
  const buildVoxels = () => {
    const voxels: Voxel[] = []
    for (const material of MATERIALS) {
      const positions = resultGroups[material].positions
      for (let index = 0; index < positions.length; index += 3) {
        const colorIndex = Math.min(
          2,
          Math.floor(
            smoothNoise(
              root,
              required(positions[index]),
              required(positions[index + 2]),
              material === 'shore' ? 0.9 : 2.6,
              317,
            ) * 3,
          ),
        )
        // The high right bank recedes as one dark shape; individual top facets stay secondary.
        const ridgeShade =
          clamp((profileX(required(positions[index]), mobile) - 31) / 18, 0, 1) *
          clamp((-required(positions[index + 2]) - 29) / 18, 0, 1) *
          clamp((required(positions[index + 1]) - 1.4) / 3, 0, 1)
        voxels.push({
          x: required(positions[index]),
          y: required(positions[index + 1]),
          z: required(positions[index + 2]),
          // A block must cover its grid cell completely; smaller randomized sizes open cracks.
          size: terrainSizeAt(required(positions[index + 2])),
          color: dimColor(
            required(TERRAIN_VARIANTS[material][colorIndex]),
            required(positions[index + 2]) > 2 ? 0.4 : 1 - ridgeShade * 0.25,
          ),
        })
      }
    }
    return voxels
  }
  let voxels = buildVoxels()
  let lakeBed = createLakeBed(
    voxels,
    root,
    mobile,
    resultGroups.ground.count + resultGroups.shore.count + resultGroups.rock.count,
  )
  const waterfall = selectWaterfall(
    root,
    mobile,
    columns,
    surface,
    voxels,
    groups,
    lamps,
    lakeBed,
    voxelSize,
    zNear,
  )
  if (waterfall) {
    for (const material of MATERIALS) resultGroups[material] = freezeGroup(groups[material])
    voxels = buildVoxels()
    // Carving can lower obstacles as well as raise them. Rebuild from final solids;
    // the elevated pool remains land in the separate lake-level water mask.
    lakeBed = createLakeBed(voxels, root, mobile)
  }
  return {
    version: 'lake-voxel-v1',
    variant,
    seed: root,
    voxelSize,
    groups: resultGroups,
    voxels,
    lakeBed,
    waterfall,
    shores: new Float32Array(shores),
    shoreCount: shores.length / 3,
    lamps,
    bounds: {
      minX: -xCells * voxelSize,
      maxX: xCells * voxelSize,
      minZ: zNear - (zCells - 1) * voxelSize,
      maxZ: 13,
    },
    suggestedCamera: {
      position: [0, 2.5, 16],
      target: [0, 1.4, -20],
      fov: mobile ? 48 : 43,
    },
  }
}

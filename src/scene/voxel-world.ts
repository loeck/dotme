import { createLakeBed } from './lake-bed'
import type { LakeBed } from './lake-bed'

/**
 * Deterministic, renderer-agnostic voxel data for the low lake composition. Coordinates are
 * Three.js world coordinates: x horizontal, y up, z depth; water is the y = 0 plane.
 */
export type VoxelWorldVariant = 'desktop' | 'mobile'

export type VoxelMaterial =
  | 'ground'
  | 'shore'
  | 'rock'
  | 'treeTrunk'
  | 'treeLeaf'
  | 'lampPost'
  | 'lampGlow'

export type VoxelGroup = Readonly<{
  /** Center positions, three floats per unit voxel: ready for THREE.InstancedMesh. */
  positions: Float32Array
  count: number
}>

export type VoxelLamp = Readonly<{
  x: number
  y: number
  z: number
  warm: boolean
  intensity: number
}>

export type VoxelWorldData = Readonly<{
  version: 'lake-voxel-v1'
  variant: VoxelWorldVariant
  seed: number
  voxelSize: number
  lakeBed: LakeBed
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

export const VOXEL_PALETTE = {
  ground: 0x20313d,
  shore: 0x293d49,
  rock: 0x304552,
  treeTrunk: 0x1d2930,
  treeLeaf: 0x243540,
  lampPost: 0x34434d,
  lampGlow: 0xffddaf,
} as const satisfies Record<VoxelMaterial, number>

const TERRAIN_VARIANTS = {
  ground: [0x15212b, 0x1d2c36, 0x2b3b46],
  shore: [0x1a2831, 0x293a45, 0x354955],
  rock: [0x192630, 0x263742, 0x344955],
} as const

type MutableGroups = Record<VoxelMaterial, number[]>
type Cell = Readonly<{ x: number; z: number; height: number }>
type TerrainShape = Readonly<{
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

const MATERIALS: readonly VoxelMaterial[] = [
  'ground',
  'shore',
  'rock',
  'treeTrunk',
  'treeLeaf',
  'lampPost',
  'lampGlow',
]

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

function addVoxel(group: number[], x: number, y: number, z: number) {
  group.push(x, y, z)
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
    // A low finger carries the sapling in front of the rear hill, preserving its silhouette.
    mobile ? ellipse(28, -35, 15, 10) : ellipse(29, -33, 8, 9),
    // Low distant islets break the straight horizon and give the far lights a real shore.
    ellipse(13, -63, 8.5, 4.2) * 0.55,
    ellipse(25, -65, 10, 5) * 0.62,
  )
  const land = Math.max(left - inlet - aperture, right)
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
  // Larger irregularities belong to the rear hill, leaving the lamp and tree on its low shelf.
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
  const levels =
    clamp(
      0.2 + shoreRise + mass * (px < 0 && z > -32 ? 0.76 : 1) + distant + broad + middle + pebbles,
      0.28,
      11,
    ) / step
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

/**
 * Build a single scene-sized lake: close heavy left shore, a deliberately empty middle water
 * corridor, and right/far land held behind z = -16. The output contains no Three dependency.
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
  const groups: MutableGroups = {
    ground: [],
    shore: [],
    rock: [],
    treeTrunk: [],
    treeLeaf: [],
    lampPost: [],
    lampGlow: [],
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
      const px = profileX(x, mobile)
      const material: VoxelMaterial =
        coast < 0.095 ? 'shore' : smoothNoise(root, px, z, 4.2, 191) > 0.7 ? 'rock' : 'ground'
      // Broad, seeded gaps expose irregular patches of the slope instead of an even checkerboard.
      // The wet shelf stays continuous so the bank still meets the water convincingly.
      const wetShelf = coast < 0.46
      const exposed = clamp((height - 1.1) / 5.5, 0, 1)
      const openPatch = smoothNoise(root, px, z, 3.4, 195) < (px > 24 ? 0.49 : 0.42)
      const gapChance = wetShelf
        ? px < -20
          ? 0.065
          : 0.04
        : 0.012 + exposed * (openPatch ? (px > 24 ? 0.35 : 0.25) : 0.025)
      // Beyond the focal shore, two-cell blocks are subpixel detail at this camera distance.
      // Keep the full height field for placement but render a cheaper, coherent distant mass.
      if (z < -44 && (xi % 2 !== 0 || zi % 2 !== 0)) continue
      if (hash(root, xi, zi, 193) < 1 - gapChance) {
        const jitterX = (hash(root, xi, zi, 199) - 0.5) * voxelSize * 0.38
        const jitterZ = (hash(root, xi, zi, 201) - 0.5) * voxelSize * 0.38
        const jitterY = (hash(root, xi, zi, 203) - 0.5) * voxelSize * 0.24
        addVoxel(groups[material], x + jitterX, height - voxelSize * 0.5 + jitterY, z + jitterZ)
      }
    }
  }

  // A few broken side stones give near banks depth without laying regular visible courses.
  for (const cell of land.values()) {
    if (cell.z < -44) continue
    const xi = Math.round(cell.x / voxelSize)
    const zi = Math.round((zNear - cell.z) / voxelSize)
    const neighbors = [
      land.get(cellKey(xi, zi - 1)),
      land.get(cellKey(xi - 1, zi)),
      land.get(cellKey(xi + 1, zi)),
    ]
    const lowerVisibleFace = Math.min(...neighbors.map((neighbor) => neighbor?.height ?? 0))
    const layers = Math.min(
      1,
      Math.max(0, Math.ceil((cell.height - lowerVisibleFace) / voxelSize) - 2),
    )
    for (let layer = 1; layer <= layers; layer += 1) {
      if (hash(root, xi, zi + layer, 205) > 0.28) continue
      const material = hash(root, xi, zi + layer, 197) > 0.73 ? 'shore' : 'rock'
      const stagger = (hash(root, xi, zi + layer, 207) - 0.5) * voxelSize * 0.35
      addVoxel(
        groups[material],
        cell.x + stagger,
        cell.height - (layer + 0.5) * voxelSize,
        cell.z - stagger * 0.55,
      )
    }
  }

  const lamps: VoxelLamp[] = []
  const nearestLand = (x: number, z: number) => {
    let nearest: Cell | undefined
    let distance = Infinity
    for (const cell of land.values()) {
      const candidate = (cell.x - x) ** 2 + (cell.z - z) ** 2
      if (candidate < distance) {
        nearest = cell
        distance = candidate
      }
    }
    return nearest
  }
  const addLamp = (x: number, z: number, intensity: number, warm = true) => {
    const cell = nearestLand(x, z)
    if (!cell || lamps.length >= (mobile ? 4 : 7)) return
    if (Math.hypot(cell.x - x, cell.z - z) > (mobile ? 3.5 : 5.5)) return
    if (lamps.some((lamp) => Math.hypot(lamp.x - cell.x, lamp.z - cell.z) < voxelSize * 3)) return
    lamps.push({ x: cell.x, y: cell.height, z: cell.z, warm, intensity })
  }

  for (const cell of land.values()) {
    const xi = Math.round(cell.x / voxelSize)
    const zi = Math.round((zNear - cell.z) / voxelSize)
    const waterAhead = !land.has(cellKey(xi, zi - 1))
    if (waterAhead) {
      shores.push(cell.x, cell.height, cell.z)
      // Single separated blocks on the wet edge keep it granular instead of reading as a wall.
      if (hash(root, xi, zi, 187) > 0.915) {
        addVoxel(groups.shore, cell.x, voxelSize * 0.1, cell.z + voxelSize * 1.2)
        if (hash(root, xi, zi, 189) > 0.82)
          addVoxel(groups.rock, cell.x + voxelSize, voxelSize * 0.1, cell.z + voxelSize * 1.8)
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
    addVoxel(groups.shore, x + shift, voxelSize * 0.33, z)
    if (index === 1) addVoxel(groups.rock, x + voxelSize, voxelSize * 0.3, z - voxelSize)
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
      addVoxel(
        groups[scatter > 0.72 ? 'rock' : 'shore'],
        x + dx,
        voxelSize * (0.12 + hash(root, cluster, stone, 263) * 0.45),
        z + dz,
      )
    }
  }
  for (const [px, z, height] of [
    [-41, -8, 0.5],
    [-39, -10, 0.35],
    [-36, -8.5, 0.65],
    [-30, -9, 0.45],
    [-27, -7.5, 0.55],
  ] as const) {
    const x = mobile ? px / 2.8 : px
    addVoxel(groups.rock, x, voxelSize * height, z)
  }

  // A low shore enters beneath the camera. Its diagonal, broken wet edge supplies a
  // near plane while the middle of the lake remains open all the way to the horizon.
  // Keep it separate from `land`: the far-bank lamps and trees must stay on their shelves.
  const foregroundMinX = mobile ? -4.2 : -12
  const foregroundStep = voxelSize * 0.5
  const foregroundStart = mobile ? 5 : 3
  const foregroundShift = (hash(root, 0, 0, 401) - 0.5) * (mobile ? 0.22 : 0.7)
  for (let zi = 0; zi < Math.ceil((13 - foregroundStart) / foregroundStep); zi += 1) {
    const z = foregroundStart + zi * foregroundStep
    const advance = clamp((z - foregroundStart) / 7, 0, 1)
    const edge =
      (mobile ? -2.55 + advance * 2.49 : -10 + advance * 9.4) +
      foregroundShift +
      (smoothNoise(root, z, 0, 1.8, 409) - 0.5) * (mobile ? 0.35 : 1.3)
    for (let xi = 0; xi < Math.ceil(-foregroundMinX / foregroundStep); xi += 1) {
      const x = foregroundMinX + xi * foregroundStep
      const depth = edge - x
      const brokenEdge = (smoothNoise(root, x, z, 0.52, 419) - 0.5) * 0.52
      if (depth + brokenEdge < 0 || x > (mobile ? -0.08 : -0.55)) continue
      const detail = hash(root, xi, zi, 421)
      if (detail < (depth < 0.45 ? 0.19 : 0.035)) continue
      const swell = smoothNoise(root, x, z, 1.45, 431)
      const height = 0.03 + clamp(depth / 2.4, 0, 1) * 0.13 + Math.max(0, swell - 0.32) * 0.3
      const jitterX = (hash(root, xi, zi, 433) - 0.5) * foregroundStep * 0.74
      const jitterZ = (hash(root, xi, zi, 439) - 0.5) * foregroundStep * 0.74
      addVoxel(
        groups[depth < 0.26 ? 'shore' : detail > 0.83 ? 'rock' : 'ground'],
        x + jitterX,
        height + (detail - 0.5) * 0.085,
        z + jitterZ,
      )
      if (height > foregroundStep && detail > 0.25)
        addVoxel(groups.ground, x + jitterX, height - foregroundStep * 0.8, z + jitterZ)
    }
  }

  // Two authored tree silhouettes echo the reference; rare seeded companions keep visits distinct.
  const addTree = (x: number, z: number, scale: number) => {
    const cell = nearestLand(x, z)
    if (!cell) return
    const treeX = cell.x
    const baseY = cell.height
    const isMainTree = scale > 0.85
    const trunk = isMainTree ? (mobile ? 5 : 6) : mobile ? 4 : scale > 0.65 ? 6 : 5
    for (let y = 0; y < trunk; y += 1)
      addVoxel(groups.treeTrunk, treeX, baseY + (y + 0.5) * voxelSize, cell.z)
    // Short lateral branches tuck into an uneven crown; no isolated ball on a pole.
    for (const direction of [-1, 1])
      for (let step = 1; step <= (isMainTree ? 3 : 2); step += 1)
        addVoxel(
          groups.treeTrunk,
          treeX + direction * step * voxelSize,
          baseY + (trunk - 0.5 + Math.floor(step / 2)) * voxelSize,
          cell.z - (step % 2) * voxelSize,
        )
    const treeSeed = Math.round(treeX * 13 + cell.z * 31)
    const breadth = isMainTree ? (mobile ? 4.25 : 6.6) : mobile ? 3.1 : scale > 0.65 ? 4.7 : 3.55
    const crownHeight = isMainTree
      ? mobile
        ? 4.8
        : 6.05
      : mobile
        ? 3.45
        : scale > 0.65
          ? 4.8
          : 3.8
    const lobes = [
      { x: -breadth * 0.48, y: trunk + crownHeight * 0.48, z: -0.7, rx: 0.68, ry: 0.5 },
      { x: breadth * 0.34, y: trunk + crownHeight * 0.76, z: 0.45, rx: 0.74, ry: 0.56 },
      { x: -breadth * 0.14, y: trunk + crownHeight * 1.25, z: -0.2, rx: 0.48, ry: 0.36 },
      { x: -breadth * 0.82, y: trunk + crownHeight * 0.76, z: 0.25, rx: 0.42, ry: 0.43 },
    ]
    for (let dy = trunk - 2; dy <= trunk + Math.ceil(crownHeight * 1.8); dy += 1)
      for (let dz = -Math.ceil(breadth); dz <= Math.ceil(breadth); dz += 1)
        for (let dx = -Math.ceil(breadth * 1.4); dx <= Math.ceil(breadth * 1.3); dx += 1) {
          const irregular = hash(root, treeSeed + dx * 3, dy * 7 + dz, 229)
          if (irregular < (isMainTree ? 0.085 : 0.14)) continue
          const covered = lobes.some((lobe, index) => {
            const offset = (hash(root, treeSeed, index, 227) - 0.5) * 0.46
            return (
              ((dx - lobe.x - offset) / (breadth * lobe.rx)) ** 2 +
                ((dy - lobe.y) / (crownHeight * lobe.ry)) ** 2 +
                ((dz - lobe.z) / (breadth * 0.58)) ** 2 <
              1.04
            )
          })
          if (!covered) continue
          addVoxel(
            groups.treeLeaf,
            treeX + dx * voxelSize,
            baseY + (dy + irregular * 0.2) * voxelSize,
            cell.z + dz * voxelSize,
          )
        }
  }

  const sceneX = (x: number) => (mobile ? x / 2.8 : x)
  addTree(
    sceneX((mobile ? -15.7 : -22) + (hash(root, 1, 1, 201) - 0.5) * (mobile ? 0.8 : 1.2)),
    mobile ? -18 : -20,
    1,
  )
  addTree(
    sceneX((mobile ? 24 : 25.5) + (hash(root, 2, 1, 203) - 0.5) * 2),
    mobile ? -34 : -29.5,
    0.7,
  )
  for (const cell of land.values()) {
    const shoreDistance = coastField(root, cell.x, cell.z, mobile, shape)
    const chance = hash(root, Math.round(cell.x / voxelSize), Math.round(cell.z / voxelSize), 211)
    if (
      profileX(cell.x, mobile) > -12 &&
      cell.z < -12 &&
      shoreDistance > 0.17 &&
      chance < (mobile ? 0.00008 : 0.00012)
    )
      addTree(cell.x, cell.z, 0.55)
  }

  addLamp(sceneX(mobile ? -11 : -20.5), mobile ? -8 : -20, 1.15)
  addLamp(sceneX(-9), -28, 0.75)
  addLamp(sceneX(-8), -52, 0.4, false)
  addLamp(sceneX(mobile ? 25 : 29), mobile ? -34 : -30, 0.76)
  addLamp(sceneX(40), -18, 1)
  if (!mobile) {
    addLamp(12, -61, 0.42)
    addLamp(24, -63, 0.32)
  }
  const lampTarget = mobile ? 3 : 4
  if (lamps.length < lampTarget) {
    const fallbackTargets: readonly (readonly [number, number])[] = mobile
      ? [
          [sceneX(-12), -10],
          [sceneX(-9), -46],
          [sceneX(31), -30],
        ]
      : [
          [-22, -6],
          [-9, -27],
          [-10, -49],
          [31, -30],
          [42, -20],
        ]
    for (const [x, z] of fallbackTargets) {
      if (lamps.length >= lampTarget) break
      addLamp(x, z, 0.7)
    }
  }

  const resultGroups = Object.fromEntries(
    MATERIALS.map((material) => [material, freezeGroup(groups[material])]),
  ) as Record<VoxelMaterial, VoxelGroup>
  const voxels: Voxel[] = []
  for (const material of MATERIALS) {
    const positions = resultGroups[material].positions
    for (let index = 0; index < positions.length; index += 3) {
      const leafFacet =
        material === 'treeLeaf'
          ? hash(
              root,
              Math.round(positions[index]! * 11) ^ (Math.round(positions[index + 1]! * 13) * 31),
              Math.round(positions[index + 2]! * 11),
              353,
            )
          : 0
      const terrain = material === 'ground' || material === 'shore' || material === 'rock'
      const colorIndex = Math.min(
        2,
        Math.floor(
          smoothNoise(
            root,
            positions[index]!,
            positions[index + 2]!,
            material === 'shore' ? 0.9 : 2.6,
            317,
          ) * 3,
        ),
      )
      // The high right bank recedes as one dark shape; individual top facets stay secondary.
      const ridgeShade =
        clamp((profileX(positions[index]!, mobile) - 31) / 18, 0, 1) *
        clamp((-positions[index + 2]! - 29) / 18, 0, 1) *
        clamp((positions[index + 1]! - 1.4) / 3, 0, 1)
      voxels.push({
        x: positions[index]!,
        y: positions[index + 1]!,
        z: positions[index + 2]!,
        size: terrain
          ? voxelSize *
            (positions[index + 2]! > 2 ? 0.56 : positions[index + 2]! < -44 ? 2 : 1) *
            ((material === 'shore' ? 0.8 : positions[index + 2]! > -24 ? 0.83 : 0.91) +
              hash(
                root,
                Math.round(positions[index]! * 11),
                Math.round(positions[index + 2]! * 11),
                311,
              ) *
                0.2)
          : voxelSize * (material === 'treeLeaf' ? 0.96 : 0.9),
        color: terrain
          ? dimColor(
              TERRAIN_VARIANTS[material][colorIndex]!,
              positions[index + 2]! > 2 ? 0.4 : 1 - ridgeShade * 0.25,
            )
          : material === 'treeLeaf'
            ? leafFacet > 0.956
              ? 0x496576
              : leafFacet > 0.79
                ? 0x2c414f
                : VOXEL_PALETTE.treeLeaf
            : VOXEL_PALETTE[material],
      })
    }
  }
  return {
    version: 'lake-voxel-v1',
    variant,
    seed: root,
    voxelSize,
    groups: resultGroups,
    voxels,
    lakeBed: createLakeBed(
      voxels,
      root,
      mobile,
      resultGroups.ground.count + resultGroups.shore.count + resultGroups.rock.count,
    ),
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

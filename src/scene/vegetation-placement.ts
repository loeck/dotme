import { WATER_LEVEL } from './lake-bed'
import {
  meshSculpt,
  mulberry32,
  sculptBirch,
  sculptBush,
  sculptFern,
  sculptFlower,
  sculptPine,
  sculptSpruce,
  sculptTuft,
  VEGETATION_PALETTE,
} from './vegetation-models'
import type { VegetationGeometry, VoxelSculpt } from './vegetation-models'
import type { TreeKind, VoxelWorld } from './voxel-world'

/** One instanced draw: a meshed model and where it stands. */
export type VegetationLayer = Readonly<{
  name: string
  geometry: VegetationGeometry
  /** Column-major 4×4 matrices, 16 floats per instance. */
  matrices: Float32Array
  /** Per instance: yaw (radians) and sway phase. */
  motion: Float32Array
  /** Tip displacement at full wind, as a fraction of the model height. */
  sway: number
  castShadow: boolean
  /** Foreground detail only the main view renders: no reflection, probe or shadow pass. */
  mainViewOnly: boolean
}>
export type PreparedVegetation = Readonly<{ layers: VegetationLayer[] }>

/**
 * Micro voxels only read where they build forms of a few pixels (Deadloop's lesson). Trees,
 * 15–60 m away, use about a third of the terrain voxel; the foreground undergrowth, a few
 * metres from the camera, a much finer grid. Phones use coarser grids.
 */
const GRID = {
  desktop: { tree: 0.08, ground: 0.035 },
  mobile: { tree: 0.1, ground: 0.045 },
} as const
const GROUND_COVER_Z = -1.5
/** Furthest a companion bush stands from its tree: (0.6 + 0.7) × the largest tree scale. */
const COMPANION_REACH = 2.4
const TREE_VARIANTS: Record<TreeKind, number> = { spruce: 3, pine: 2, birch: 2 }
const TUFT_VARIANTS = 3

type Column = { top: number; ground: boolean }
const COLUMN = 0.125

function hash(seed: number, a: number, b: number, stream: number) {
  let n = (seed ^ Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ stream) >>> 0
  n ^= n >>> 16
  n = Math.imul(n, 0x7feb352d)
  n ^= n >>> 15
  n = Math.imul(n, 0x846ca68b)
  return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000
}
/** Smooth value noise, used for Last Signal's clumps (1.6 m) and patches (8 m). */
function valueNoise(seed: number, x: number, z: number, scale: number, stream: number) {
  const px = x / scale,
    pz = z / scale
  const x0 = Math.floor(px),
    z0 = Math.floor(pz)
  const tx = px - x0,
    tz = pz - z0
  const sx = tx * tx * (3 - 2 * tx),
    sz = tz * tz * (3 - 2 * tz)
  const a = hash(seed, x0, z0, stream),
    b = hash(seed, x0 + 1, z0, stream)
  const c = hash(seed, x0, z0 + 1, stream),
    d = hash(seed, x0 + 1, z0 + 1, stream)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}

/** Highest solid top per 12.5 cm column, and whether that top is mossy ground, limited to
 * the foreground bank and the ground around trees: the whole lake would cost far more. */
function columnTops(world: VoxelWorld) {
  const columns = new Map<string, Column>()
  const groundEnd = world.groups.ground.count
  const needed = (x: number, z: number, margin: number) =>
    z > GROUND_COVER_Z - margin ||
    world.trees.some(
      (tree) => (tree.x - x) ** 2 + (tree.z - z) ** 2 < (COMPANION_REACH + margin) ** 2,
    )
  world.voxels.forEach((voxel, index) => {
    if (!needed(voxel.x, voxel.z, voxel.size)) return
    const top = voxel.y + voxel.size / 2
    const span = Math.max(1, Math.round(voxel.size / COLUMN))
    const x0 = Math.round((voxel.x - voxel.size / 2) / COLUMN),
      z0 = Math.round((voxel.z - voxel.size / 2) / COLUMN)
    for (let i = 0; i < span; i++)
      for (let k = 0; k < span; k++) {
        const key = `${x0 + i}:${z0 + k}`
        const previous = columns.get(key)
        if (previous && previous.top >= top) continue
        columns.set(key, { top, ground: index < groundEnd })
      }
  })
  return {
    columns,
    at(x: number, z: number) {
      return columns.get(`${Math.floor(x / COLUMN)}:${Math.floor(z / COLUMN)}`)
    },
  }
}

class LayerBuilder {
  readonly matrices: number[] = []
  readonly motion: number[] = []
  place(x: number, y: number, z: number, yaw: number, scale: number, phase: number) {
    const c = Math.cos(yaw) * scale,
      s = Math.sin(yaw) * scale
    this.matrices.push(c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, z, 1)
    this.motion.push(yaw, phase)
  }
  get count() {
    return this.motion.length / 2
  }
}

export function prepareVegetation(
  world: VoxelWorld,
  seed: number,
  mobile: boolean,
): PreparedVegetation {
  const grid = mobile ? GRID.mobile : GRID.desktop
  const random = mulberry32(seed ^ 0x51ed27)
  const layers: VegetationLayer[] = []
  const models = new Map<
    string,
    {
      geometry: VegetationGeometry
      builder: LayerBuilder
      sway: number
      shadow: boolean
      foreground: boolean
    }
  >()
  const model = (
    name: string,
    build: () => VoxelSculpt,
    options: Readonly<{
      sway: number
      shadow: boolean
      relief: number
      bendFrom: number
      foreground?: boolean
    }>,
  ) => {
    let entry = models.get(name)
    if (!entry) {
      entry = {
        geometry: meshSculpt(build(), {
          seed: seed ^ name.length,
          relief: options.relief,
          bendFrom: options.bendFrom,
        }),
        builder: new LayerBuilder(),
        sway: options.sway,
        shadow: options.shadow,
        foreground: options.foreground ?? false,
      }
      models.set(name, entry)
    }
    return entry.builder
  }
  const sculptTree = (kind: TreeKind, variant: number, size: number) => {
    const treeSeed = seed + variant * 7919 + kind.length * 104_729
    if (kind === 'birch') return sculptBirch(treeSeed, size)
    if (kind === 'pine') return sculptPine(treeSeed, size)
    return sculptSpruce(treeSeed, size, variant === 2)
  }
  const tops = columnTops(world)

  for (const tree of world.trees) {
    const xi = Math.round(tree.x * 10),
      zi = Math.round(tree.z * 10)
    const variant = Math.floor(hash(seed, xi, zi, 931) * TREE_VARIANTS[tree.kind])
    const size = grid.tree
    const name = `${tree.kind}-${variant}`
    model(name, () => sculptTree(tree.kind, variant, size), {
      sway: tree.kind === 'birch' ? 0.05 : 0.03,
      shadow: true,
      relief: 0.35,
      bendFrom: 0.4,
    }).place(tree.x, tree.y, tree.z, tree.yaw, tree.scale, hash(seed, xi, zi, 937) * Math.PI * 2)
    // Last Signal's companions: two slots per tree, a bush in about a third of them.
    for (let slot = 0; slot < 2; slot++) {
      if (hash(seed, xi, zi, 941 + slot) > 0.36) continue
      const angle = hash(seed, xi, zi, 947 + slot) * Math.PI * 2
      const distance = (0.6 + hash(seed, xi, zi, 953 + slot) * 0.7) * tree.scale
      const bx = tree.x + Math.sin(angle) * distance,
        bz = tree.z + Math.cos(angle) * distance
      const column = tops.at(bx, bz)
      if (!column?.ground || column.top < tree.y - 0.6 || column.top <= WATER_LEVEL + 0.1) continue
      const bushVariant = slot
      model(`bush-${bushVariant}`, () => sculptBush(seed + 31 + bushVariant, size), {
        sway: 0.04,
        shadow: false,
        relief: 0.35,
        bendFrom: 0,
      }).place(
        bx,
        column.top - 0.04,
        bz,
        angle * 3,
        0.8 + hash(seed, xi, zi, 959 + slot) * 0.5,
        angle,
      )
    }
  }

  // Foreground undergrowth: clumps of grass inside larger patches, a few ferns and flowers.
  const coverCap = mobile ? 220 : 720
  const undergrowth = [...tops.columns.entries()]
    .map(([key, column]) => {
      const [cx, cz] = key.split(':').map(Number)
      return { x: ((cx ?? 0) + 0.5) * COLUMN, z: ((cz ?? 0) + 0.5) * COLUMN, column }
    })
    .filter(
      ({ z, column }) => column.ground && z > GROUND_COVER_Z && column.top > WATER_LEVEL + 0.05,
    )
    // Visit in a seeded scatter order, so the cap thins the whole bank rather than cutting it.
    .map((cell) => ({
      ...cell,
      order: hash(seed, Math.round(cell.x / COLUMN), Math.round(cell.z / COLUMN), 1031),
    }))
    .sort((a, b) => a.order - b.order)
  let placed = 0
  for (const { x, z, column } of undergrowth) {
    if (placed >= coverCap) break
    const xi = Math.round(x / COLUMN),
      zi = Math.round(z / COLUMN)
    const clump = valueNoise(seed, x, z, 1.6, 961)
    const patch = valueNoise(seed, x, z, 8, 967)
    const chance = Math.max(0, Math.min(0.75, (clump - 0.4) * 1.3 + (patch - 0.5) * 0.6))
    if (hash(seed, xi, zi, 971) >= chance) continue
    const pick = hash(seed, xi, zi, 977)
    const px = x + (hash(seed, xi, zi, 983) - 0.5) * COLUMN * 0.8
    const pz = z + (hash(seed, xi, zi, 991) - 0.5) * COLUMN * 0.8
    const yaw = hash(seed, xi, zi, 997) * Math.PI * 2
    const scale = 0.8 + hash(seed, xi, zi, 1009) * 0.5
    const phase = random() * Math.PI * 2
    // Sink everything slightly so nothing floats on the voxel tops.
    const y = column.top - 0.015
    if (pick < 0.07)
      model('fern', () => sculptFern(seed + 101, grid.ground), {
        sway: 0.12,
        shadow: false,
        relief: 0.3,
        bendFrom: 0,
        foreground: true,
      }).place(px, y, pz, yaw, scale, phase)
    else if (pick < 0.1) {
      const yellow = hash(seed, xi, zi, 1013) < 0.3
      model(
        yellow ? 'flower-yellow' : 'flower-white',
        () =>
          sculptFlower(
            seed + (yellow ? 211 : 223),
            grid.ground,
            yellow ? VEGETATION_PALETTE.flowerYellow : VEGETATION_PALETTE.flowerWhite,
          ),
        {
          sway: 0.2,
          shadow: false,
          relief: 0.2,
          bendFrom: 0,
          foreground: true,
        },
      ).place(px, y, pz, yaw, scale, phase)
    } else {
      const variant = Math.floor(hash(seed, xi, zi, 1019) * TUFT_VARIANTS)
      model(`tuft-${variant}`, () => sculptTuft(seed + 307 + variant, grid.ground), {
        sway: 0.28,
        shadow: false,
        relief: 0.25,
        bendFrom: 0,
        foreground: true,
      }).place(px, y, pz, yaw, scale, phase)
    }
    placed++
  }

  for (const [name, entry] of models) {
    if (!entry.builder.count) continue
    layers.push({
      name,
      geometry: entry.geometry,
      matrices: new Float32Array(entry.builder.matrices),
      motion: new Float32Array(entry.builder.motion),
      sway: entry.sway,
      castShadow: entry.shadow,
      mainViewOnly: entry.foreground,
    })
  }
  return { layers }
}

import { CAMERA_REST } from './camera-rig'
import { bakeFoliageAtlas } from './foliage-atlas'
import type { FoliageAtlas } from './foliage-atlas'
import { appendClump } from './grass'
import type { GrassForm } from './grass'
import { WATER_LEVEL } from './lake-bed'
import type { TreeKind, LakeWorld } from './lake-world'
import { sampleHeight, sampleNormal, sampleRock } from './terrain-field'
import { appendFern, appendSprays, appendFlower, MeshBuilder } from './vegetation-meshes'
import type { MeshData } from './vegetation-meshes'
import {
  crownSpheres,
  growBirch,
  growBush,
  growJuniper,
  growPine,
  growSpruce,
  MODEL_DETAIL,
  mixRgb,
  VEGETATION_PALETTE,
} from './vegetation-models'
import type { ModelDetail, TreeModel } from './vegetation-models'

/**
 * The forest as three merged world-space meshes: tube-meshed wood, foliage cards over the
 * botanical atlas, and procedural undergrowth that only the main view draws.
 */
export type PreparedVegetation = Readonly<{
  wood: MeshData
  foliage: MeshData
  undergrowth: MeshData
  atlas: FoliageAtlas
  /** Picking volumes of trees and shrubs: world x, y, z and radius per sphere. */
  pick: Float32Array
}>

/** Undergrowth and shrub budgets per layout. */
const GRID = {
  desktop: { sward: 260_000, density: 1, shrubs: 450 },
  mobile: { sward: 44_000, density: 1, shrubs: 70 },
} as const
const GROUND_COVER_Z = -1.5
/** Mid-ground shrubs: beyond the undergrowth, up to the far shore's haze. */
const SHRUB_FAR_Z = -46
/** Furthest a companion bush stands from its tree: (0.6 + 0.7) × the largest tree scale. */
const COMPANION_REACH = 2.4
/** Trees farther than this from the camera, metres, use the far level of detail. */
const FAR_TREE = 50
const TREE_VARIANTS: Record<TreeKind, number> = { spruce: 6, pine: 5, birch: 5 }
/** Tip travel at full wind as a share of model height (Voxen's `maxTip`). */
const TREE_SWAY: Record<TreeKind, number> = { spruce: 0.03, pine: 0.03, birch: 0.05 }

type Column = { top: number; ground: boolean }
const COLUMN = 0.125

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

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

/** Ground height per 12.5 cm column, and whether it is soft, mossy ground (not rock, gravel or
 * a steep face), limited to the foreground bank and the ground around trees: the whole lake
 * would cost far more. */
function columnTops(world: LakeWorld) {
  const columns = new Map<string, Column>()
  const { field } = world
  // Boulders by 2 m bucket: nothing grows out of a stone.
  const buckets = new Map<string, LakeWorld['boulders'][number][]>()
  for (const boulder of world.boulders) {
    const reach = Math.max(boulder.size[0], boulder.size[2]) + 0.15
    for (
      let bz = Math.floor((boulder.z - reach) / 2);
      bz <= Math.floor((boulder.z + reach) / 2);
      bz++
    )
      for (
        let bx = Math.floor((boulder.x - reach) / 2);
        bx <= Math.floor((boulder.x + reach) / 2);
        bx++
      ) {
        const key = `${bx}:${bz}`
        const list = buckets.get(key)
        if (list) list.push(boulder)
        else buckets.set(key, [boulder])
      }
  }
  const onStone = (x: number, z: number) =>
    (buckets.get(`${Math.floor(x / 2)}:${Math.floor(z / 2)}`) ?? []).some(
      (boulder) =>
        Math.hypot(x - boulder.x, z - boulder.z) <
        Math.max(boulder.size[0], boulder.size[2]) + 0.15,
    )
  const add = (cx: number, cz: number) => {
    const key = `${cx}:${cz}`
    if (columns.has(key)) return
    const x = (cx + 0.5) * COLUMN,
      z = (cz + 0.5) * COLUMN
    const top = sampleHeight(field, x, z)
    if (top <= WATER_LEVEL) return
    const [, up] = sampleNormal(field, x, z)
    columns.set(key, {
      top,
      ground: up > 0.82 && sampleRock(field, x, z) < 0.45 && !onStone(x, z),
    })
  }
  const fieldMaxX = field.minX + (field.columns - 1) * field.cell
  const fieldMaxZ = field.minZ + (field.rows - 1) * field.cell
  for (
    let cz = Math.floor((GROUND_COVER_Z - 0.5) / COLUMN);
    cz <= Math.floor(fieldMaxZ / COLUMN);
    cz++
  )
    for (let cx = Math.ceil(field.minX / COLUMN); cx <= Math.floor(fieldMaxX / COLUMN); cx++)
      add(cx, cz)
  const reach = Math.ceil((COMPANION_REACH + 0.5) / COLUMN)
  for (const tree of world.trees) {
    const tx = Math.floor(tree.x / COLUMN),
      tz = Math.floor(tree.z / COLUMN)
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) add(tx + dx, tz + dz)
  }
  return {
    columns,
    at(x: number, z: number) {
      return columns.get(`${Math.floor(x / COLUMN)}:${Math.floor(z / COLUMN)}`)
    },
  }
}

export function prepareVegetation(
  world: LakeWorld,
  seed: number,
  mobile: boolean,
): PreparedVegetation {
  const grid = mobile ? GRID.mobile : GRID.desktop
  const detail = mobile ? MODEL_DETAIL.mobile : MODEL_DETAIL.desktop
  const wood = new MeshBuilder(false)
  const foliage = new MeshBuilder(true)
  const undergrowth = new MeshBuilder(false)
  const models = new Map<string, TreeModel>()
  const crowns = new Map<TreeModel, Float32Array>()
  const pickSpheres: number[] = []
  const model = (name: string, build: () => TreeModel) => {
    let entry = models.get(name)
    if (!entry) {
      entry = build()
      models.set(name, entry)
    }
    return entry
  }
  // Shrubs of a Nordic shore: bilberry domes, junipers on the drier ground, spruce saplings.
  const shrub = (pick: number, slot: number) => {
    if (pick < 0.55) return model(`bush-${slot}`, () => growBush(seed + 31 + slot, detail))
    if (pick < 0.85) return model(`juniper-${slot}`, () => growJuniper(seed + 41 + slot, detail))
    return model(`sapling-${slot}`, () =>
      growSpruce(seed + 51 + slot, detail, slot === 1, [0.9, 1.6]),
    )
  }
  const farDetail = mobile ? MODEL_DETAIL.mobileFar : MODEL_DETAIL.desktopFar
  const growTree = (kind: TreeKind, variant: number, lod: ModelDetail) => {
    const treeSeed = seed + variant * 7919 + kind.length * 104_729
    if (kind === 'birch') return growBirch(treeSeed, lod)
    if (kind === 'pine') return growPine(treeSeed, lod)
    return growSpruce(treeSeed, lod, variant % 3 === 2)
  }
  const plant = (
    entry: TreeModel,
    at: Readonly<{ x: number; y: number; z: number; yaw: number; scale: number }>,
    sway: number,
    salt: number,
    /** Card size multiplier: sparser far models draw their cards larger to keep coverage. */
    cardScale = 1,
  ) => {
    // Picking spheres follow the drawn crown: yawed, scaled and placed like the model.
    let spheres = crowns.get(entry)
    if (!spheres) {
      spheres = crownSpheres(entry)
      crowns.set(entry, spheres)
    }
    const c = Math.cos(at.yaw),
      sn = Math.sin(at.yaw)
    for (let i = 0; i < spheres.length; i += 4) {
      const x = spheres[i] ?? 0,
        z = spheres[i + 2] ?? 0
      pickSpheres.push(
        at.x + (c * x + sn * z) * at.scale,
        at.y + (spheres[i + 1] ?? 0) * at.scale,
        at.z + (-sn * x + c * z) * at.scale,
        (spheres[i + 3] ?? 0) * at.scale * cardScale,
      )
    }
    const phase = hash(seed, salt, 7, 937) * Math.PI * 2
    const omega = (2 * Math.PI * 1.2) / Math.sqrt(entry.height * at.scale)
    const swayMetres = sway * entry.height * at.scale
    wood.appendWood(entry.wood, at, { phase, omega }, swayMetres)
    // Per-prop size and hue/value jitter.
    const jitter = hash(seed, salt, 11, 941)
    appendSprays(foliage, entry.sprays, at, {
      propFactor: (0.92 + jitter * 0.16) * cardScale,
      propTint: [
        0.94 + jitter * 0.1,
        0.97 + hash(seed, salt, 13, 947) * 0.06,
        0.95 + (1 - jitter) * 0.08,
      ],
      modelHeight: entry.height,
      sway: { phase, omega },
      swayMetres,
      salt,
    })
  }
  const tops = columnTops(world)

  const companions: { x: number; z: number }[] = []
  world.trees.forEach((tree, index) => {
    const xi = Math.round(tree.x * 10),
      zi = Math.round(tree.z * 10)
    const variant = Math.floor(hash(seed, xi, zi, 931) * TREE_VARIANTS[tree.kind])
    // Past 50 m a crown is a few dozen pixels: half its sprays, drawn larger, read the same.
    const far =
      Math.hypot(tree.x - CAMERA_REST.x, tree.y - CAMERA_REST.y, tree.z - CAMERA_REST.z) > FAR_TREE
    const lod = far ? farDetail : detail
    const entry = model(`${tree.kind}-${variant}-${far ? 'far' : 'near'}`, () =>
      growTree(tree.kind, variant, lod),
    )
    plant(
      entry,
      tree,
      TREE_SWAY[tree.kind],
      index * 2 + 1,
      Math.pow(lod.spacing / detail.spacing, 0.4),
    )
    // Last Signal's companions: two slots per tree, a bush in about a third of them.
    for (let slot = 0; slot < 2; slot++) {
      if (hash(seed, xi, zi, 941 + slot) > 0.36) continue
      const angle = hash(seed, xi, zi, 947 + slot) * Math.PI * 2
      const distance = (0.6 + hash(seed, xi, zi, 953 + slot) * 0.7) * tree.scale
      const bx = tree.x + Math.sin(angle) * distance,
        bz = tree.z + Math.cos(angle) * distance
      const column = tops.at(bx, bz)
      if (!column?.ground || column.top < tree.y - 0.6 || column.top <= WATER_LEVEL + 0.1) continue
      // Companions are mostly bilberry and saplings: young growth under a parent tree.
      const pick = hash(seed, xi, zi, 963 + slot)
      const bush = shrub(pick < 0.7 ? pick * 0.75 : 0.86 + (pick - 0.7) * 0.4, slot)
      companions.push({ x: bx, z: bz })
      plant(
        bush,
        {
          x: bx,
          y: column.top - 0.04,
          z: bz,
          yaw: angle * 3,
          scale: 0.8 + hash(seed, xi, zi, 959 + slot) * 0.5,
        },
        0.04,
        index * 2 + 2 + slot * 1000,
      )
    }
  })

  /**
   * Whether a step edge (a neighbour column lower by more than 5 cm, or none) or a wall (higher
   * by more than 5 cm) lies within `reach` columns, and the unit XZ direction toward it when
   * one side dominates.
   */
  const edgeAt = (x: number, z: number, top: number, reach: number) => {
    const cx = Math.floor(x / COLUMN),
      cz = Math.floor(z / COLUMN)
    let ex = 0,
      ez = 0,
      near = false
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) {
        if (!dx && !dz) continue
        const neighbour = tops.columns.get(`${cx + dx}:${cz + dz}`)
        // A slope is not a step: tolerate 5 cm per column of distance.
        if (neighbour && Math.abs(neighbour.top - top) <= 0.05 * Math.hypot(dx, dz)) continue
        near = true
        const weight = 1 / Math.hypot(dx, dz)
        ex += dx * weight
        ez += dz * weight
      }
    const length = Math.hypot(ex, ez)
    return {
      near,
      toward: length > 1e-6 ? ([ex / length, ez / length] as const) : undefined,
    }
  }

  // Mid-ground shrubs (Last Signal's islet and bank cover): grass blades shrink below a pixel
  // past the foreground, so the turf there reads through scattered bush clumps instead. They
  // gather in slow patches and keep off tree trunks, the trees' companion bushes and a step's
  // last column.
  const shrubSpots = [...tops.columns.entries()]
    .map(([key, column]) => {
      const [cx, cz] = key.split(':').map(Number)
      return { cx: cx ?? 0, cz: cz ?? 0, column }
    })
    .filter(
      ({ cx, cz, column }) =>
        column.ground &&
        column.top > WATER_LEVEL + 0.15 &&
        (cz + 0.5) * COLUMN < GROUND_COVER_Z &&
        (cz + 0.5) * COLUMN > SHRUB_FAR_Z &&
        // One candidate per 3 × 3 columns, jittered below, keeps the scan short.
        (((cx % 3) + 3) % 3) + (((cz % 3) + 3) % 3) === 0,
    )
    .map((spot) => ({
      ...spot,
      order: hash(seed, spot.cx, spot.cz, 1201),
    }))
    .sort((a, b) => a.order - b.order)
  const shrubs: { x: number; z: number; r: number }[] = []
  for (const { cx, cz, column } of shrubSpots) {
    if (shrubs.length >= grid.shrubs) break
    const x = (cx + 0.5) * COLUMN + (hash(seed, cx, cz, 1203) - 0.5) * COLUMN * 2,
      z = (cz + 0.5) * COLUMN + (hash(seed, cx, cz, 1207) - 0.5) * COLUMN * 2
    const patch = valueNoise(seed, x, z, 5, 1209)
    if (hash(seed, cx, cz, 1211) > (patch - 0.2) * 1.8) continue
    if (edgeAt(x, z, column.top, 1).near) continue
    const scale = 0.85 + hash(seed, cx, cz, 1213) * 0.6
    const r = 0.4 * scale
    if (world.trees.some((tree) => (tree.x - x) ** 2 + (tree.z - z) ** 2 < (0.7 + r) ** 2)) continue
    if (companions.some((bush) => (bush.x - x) ** 2 + (bush.z - z) ** 2 < (0.5 + r) ** 2)) continue
    if (shrubs.some((other) => (other.x - x) ** 2 + (other.z - z) ** 2 < (other.r + r) ** 2))
      continue
    shrubs.push({ x, z, r })
    const slot = hash(seed, cx, cz, 1217) < 0.5 ? 0 : 1
    const bush = shrub(hash(seed, cx, cz, 1221), slot)
    plant(
      bush,
      { x, y: column.top - 0.04, z, yaw: hash(seed, cx, cz, 1219) * Math.PI * 2, scale },
      0.04,
      500_000 + shrubs.length,
    )
  }

  // Foreground undergrowth (ADR 0107/0112): Bézier grass fans in 1.6 m clumps inside 8 m
  // patches, with a few fern crowns and flowers. Visit in a seeded scatter order so the cap
  // thins the whole bank rather than cutting it.
  const P = VEGETATION_PALETTE
  const candidates = [...tops.columns.entries()]
    .map(([key, column]) => {
      const [cx, cz] = key.split(':').map(Number)
      return { x: ((cx ?? 0) + 0.5) * COLUMN, z: ((cz ?? 0) + 0.5) * COLUMN, column }
    })
    .filter(
      ({ z, column }) => column.ground && z > GROUND_COVER_Z && column.top > WATER_LEVEL + 0.05,
    )
    .map((cell) => ({
      ...cell,
      order: hash(seed, Math.round(cell.x / COLUMN), Math.round(cell.z / COLUMN), 1031),
    }))
    .sort((a, b) => a.order - b.order)
  // The sward as clumps (see `grass.ts`) on a jittered 20 cm lattice: each clump one growth form
  // of the shore, its height, colour and dryness its own, its blades rooted on the ground beneath.
  // Detail falls off with distance (fewer, wider blades), and a triangle budget visited in a
  // seeded scatter order thins the whole bank evenly.
  const camera = [CAMERA_REST.x, CAMERA_REST.y, CAMERA_REST.z] as const
  const ground = (x: number, z: number) => {
    const column = tops.at(x, z)
    // Blades root only clear of the water, so none stands in it.
    return column?.ground && column.top > WATER_LEVEL + 0.03 ? column.top : null
  }
  const SPACING = 0.15
  const sites: { x: number; z: number; key: number; order: number }[] = []
  {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity
    for (const { x, z } of candidates) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    for (let gz = Math.floor(minZ / SPACING); gz <= Math.ceil(maxZ / SPACING); gz++)
      for (let gx = Math.floor(minX / SPACING); gx <= Math.ceil(maxX / SPACING); gx++) {
        const x = (gx + 0.2 + hash(seed, gx, gz, 1301) * 0.6) * SPACING,
          z = (gz + 0.2 + hash(seed, gx, gz, 1303) * 0.6) * SPACING
        const column = tops.at(x, z)
        if (!column?.ground || z <= GROUND_COVER_Z || column.top <= WATER_LEVEL + 0.05) continue
        sites.push({ x, z, key: gx * 7919 + gz, order: hash(seed, gx, gz, 1307) })
      }
  }
  sites.sort((a, b) => a.order - b.order)
  for (const { x, z, key } of sites) {
    if (undergrowth.indexCount / 3 >= grid.sward) break
    const top = ground(x, z) ?? 0
    const r = (stream: number) => hash(seed, key, 0, stream)
    const distance = Math.hypot(x - camera[0], top - camera[1], z - camera[2])
    const species = valueNoise(seed, x, z, 3, 1311)
    const tussock = valueNoise(seed, x, z, 1.6, 961)
    const dryField = Math.max(0, valueNoise(seed, x, z, 8, 1033) - 0.4) * 1.2
    const edge = edgeAt(x, z, top, 1)
    const towardEdge = edgeAt(x, z, top, 2).toward
    const phase = r(1) * Math.PI * 2
    // Ferns and flowers break the sward here and there.
    const pick = r(2)
    if (pick < 0.02 && !edge.near) {
      appendFern(undergrowth, [x, top - 0.01, z], {
        fronds: 5 + Math.floor(r(3) * 3),
        length: 0.32 + r(4) * 0.14,
        colour: P.fern,
        tip: mixRgb(P.fern, P.grassTip, 0.35),
        salt: key,
        phase,
      })
      continue
    }
    if (pick < 0.035 && !edge.near) {
      const yellow = r(5) < 0.3
      appendFlower(undergrowth, [x, top - 0.01, z], {
        height: 0.14 + r(6) * 0.12,
        petal: yellow ? P.flowerYellow : P.flowerWhite,
        heart: P.flowerHeart,
        stem: P.flowerStem,
        salt: key,
        phase,
      })
    }
    // Rushes by the water, flat-leaved tussocks in patches, wiry tufts elsewhere.
    // Short turf closes the ground between the taller clumps.
    const wet = top < WATER_LEVEL + 0.12
    const form: GrassForm =
      wet && r(7) < 0.18
        ? 'rush'
        : r(13) < 0.4
          ? 'turf'
          : species > 0.56 || tussock > 0.7
            ? 'flat'
            : 'wiry'
    const tall = smooth01(0.45, 0.8, tussock)
    const height =
      form === 'rush'
        ? 0.35 + 0.25 * r(8)
        : form === 'turf'
          ? 0.05 + 0.05 * r(8)
          : form === 'flat'
            ? 0.24 + 0.18 * r(8) + 0.1 * tall
            : 0.09 + 0.1 * r(8) + 0.1 * tall
    const radius =
      (form === 'flat'
        ? 0.1 + 0.06 * r(9)
        : form === 'turf'
          ? 0.09 + 0.04 * r(9)
          : 0.07 + 0.05 * r(9)) * (edge.near ? 0.6 : 1)
    const lod = Math.min(1, Math.max(0.15, (4 / distance) ** 1.25))
    appendClump(
      undergrowth,
      {
        x,
        z,
        radius,
        form,
        height: height * (edge.near ? 0.8 : 1),
        dryness: Math.min(1, dryField + r(10) * 0.3),
        value: 0.85 + r(11) * 0.3,
        seeds: r(12) < (form === 'wiry' ? 0.16 : form === 'flat' ? 0.1 : 0),
        ...(towardEdge ? { edge: towardEdge } : {}),
        salt: key,
        phase,
      },
      ground,
      lod * grid.density,
      0.0013 * distance,
    )
  }

  return {
    wood: wood.build(),
    foliage: foliage.build(),
    undergrowth: undergrowth.build(),
    atlas: bakeFoliageAtlas(seed, mobile),
    pick: Float32Array.from(pickSpheres),
  }
}

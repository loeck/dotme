/**
 * Micro-voxel vegetation after Voxen's Last Signal (`pine.model.ts`, `undergrowth.model.ts`,
 * `props.toml`): models are carved from ellipsoid, cone and limb operations on a fine grid,
 * then meshed once with per-corner ambient occlusion and per-voxel tone. Everything here is
 * pure and deterministic so the world worker can prepare it and transfer typed arrays.
 */
export type Rgb = readonly [number, number, number]
export type Point = readonly [number, number, number]

/** Last Signal's linear albedos (`content/materials/resources.ts`, `forest.toml`). */
export const VEGETATION_PALETTE = {
  needles: [0.06, 0.1, 0.05],
  needlesPale: [0.1, 0.145, 0.065],
  spruce: [0.05, 0.085, 0.062],
  bark: [0.1, 0.07, 0.05],
  barkUpper: [0.32, 0.12, 0.045],
  birchBark: [0.5, 0.49, 0.45],
  birchMark: [0.05, 0.05, 0.048],
  birchLeaves: [0.12, 0.15, 0.07],
  birchLeavesDeep: [0.07, 0.1, 0.045],
  shrub: [0.06, 0.11, 0.055],
  shrubDeep: [0.04, 0.075, 0.04],
  grassBase: [0.08, 0.112, 0.056],
  grassTip: [0.19, 0.26, 0.09],
  grassDry: [0.28, 0.23, 0.11],
  fern: [0.07, 0.12, 0.04],
  flowerStem: [0.06, 0.1, 0.04],
  flowerWhite: [0.62, 0.62, 0.56],
  flowerYellow: [0.62, 0.46, 0.08],
  flowerHeart: [0.55, 0.36, 0.05],
} as const satisfies Record<string, Rgb>

const TAU = Math.PI * 2
const GOLDEN_TURN = 0.38196601125
const OFFSET = 512
const SPAN = 1024

/** Deterministic PRNG shared with Voxen's model kit. */
export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}
const between = (random: () => number, min: number, max: number) => min + (max - min) * random()
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

type Colour = Rgb | ((y: number) => Rgb)
/** Wood stays voxels; needles and leaves are foliage masks that cards replace (ADR 0114). */
export type CellKind = 'wood' | 'needle' | 'leaf'
type Cell = Readonly<{ colour: Rgb; kind: CellKind }>

/** A sparse voxel model. Later operations overwrite earlier ones, as in Voxen's model ops. */
export class VoxelSculpt {
  readonly size: number
  readonly cells = new Map<number, Cell>()
  /** Material role of the cells the next operations fill. */
  kind: CellKind = 'wood'
  private top = 0
  constructor(size: number) {
    this.size = size
  }
  private key(ix: number, iy: number, iz: number) {
    return ((ix + OFFSET) * SPAN + (iy + OFFSET)) * SPAN + (iz + OFFSET)
  }
  has(ix: number, iy: number, iz: number) {
    return this.cells.has(this.key(ix, iy, iz))
  }
  isWood(ix: number, iy: number, iz: number) {
    return this.cells.get(this.key(ix, iy, iz))?.kind === 'wood'
  }
  /** Any matter at a model-space point. */
  occupied(point: Point) {
    const s = this.size
    return this.has(Math.floor(point[0] / s), Math.floor(point[1] / s), Math.floor(point[2] / s))
  }
  /** Fill every cell whose centre satisfies `inside`, within a world-space box. */
  private fill(
    min: Point,
    max: Point,
    inside: (x: number, y: number, z: number) => boolean,
    colour: Colour,
    paint: boolean,
  ) {
    const s = this.size
    const [x0, y0, z0] = min.map((v) => Math.floor(v / s))
    const [x1, y1, z1] = max.map((v) => Math.ceil(v / s))
    for (let ix = x0 ?? 0; ix <= (x1 ?? 0); ix++)
      for (let iy = Math.max(y0 ?? 0, -OFFSET + 1); iy <= (y1 ?? 0); iy++)
        for (let iz = z0 ?? 0; iz <= (z1 ?? 0); iz++) {
          const x = (ix + 0.5) * s,
            y = (iy + 0.5) * s,
            z = (iz + 0.5) * s
          if (!inside(x, y, z)) continue
          const key = this.key(ix, iy, iz)
          if (paint && !this.cells.has(key)) continue
          this.cells.set(key, {
            colour: typeof colour === 'function' ? colour(y) : colour,
            kind: this.kind,
          })
          this.top = Math.max(this.top, (iy + 1) * s)
        }
  }
  /** An ellipsoid whose local Z axis points along `yaw` and tips down by `pitch` radians. */
  ellipsoid(center: Point, radii: Point, colour: Colour, yaw = 0, pitch = 0, paint = false) {
    // Thin shapes below one voxel would break into pinholes.
    const r = radii.map((v) => Math.max(v, this.size * 0.75))
    const [rx, ry, rz] = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0]
    const reach = Math.max(rx, ry, rz)
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw),
      cp = Math.cos(pitch),
      sp = Math.sin(pitch)
    this.fill(
      [center[0] - reach, center[1] - reach, center[2] - reach],
      [center[0] + reach, center[1] + reach, center[2] + reach],
      (x, y, z) => {
        const dx = x - center[0],
          dy = y - center[1],
          dz = z - center[2]
        // Undo the yaw about Y, then the pitch about the local X axis.
        const lx = cy * dx - sy * dz
        const lz0 = sy * dx + cy * dz
        const ly = cp * dy + sp * lz0
        const lz = -sp * dy + cp * lz0
        return (lx / rx) ** 2 + (ly / ry) ** 2 + (lz / rz) ** 2 <= 1
      },
      colour,
      paint,
    )
  }
  /** An upright cone from `base` height to `base + height`. */
  cone(base: number, height: number, radius: number, colour: Colour, axisX = 0) {
    this.fill(
      [axisX - radius, base, -radius],
      [axisX + radius, base + height, radius],
      (x, y, z) => {
        const t = (y - base) / height
        return (
          t >= 0 &&
          t <= 1 &&
          Math.hypot(x - axisX, z) <= Math.max(radius * (1 - t), this.size * 0.5)
        )
      },
      colour,
      false,
    )
  }
  /** A tapered round limb between two points. */
  limb(from: Point, to: Point, radius: number, colour: Colour, tipRadius = radius) {
    const reach = Math.max(radius, tipRadius, this.size * 0.5)
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]] as const
    const length2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1
    this.fill(
      [
        Math.min(from[0], to[0]) - reach,
        Math.min(from[1], to[1]) - reach,
        Math.min(from[2], to[2]) - reach,
      ],
      [
        Math.max(from[0], to[0]) + reach,
        Math.max(from[1], to[1]) + reach,
        Math.max(from[2], to[2]) + reach,
      ],
      (x, y, z) => {
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - from[0]) * d[0] + (y - from[1]) * d[1] + (z - from[2]) * d[2]) / length2,
          ),
        )
        const r = Math.max(radius + (tipRadius - radius) * t, this.size * 0.5)
        return (
          (x - from[0] - d[0] * t) ** 2 +
            (y - from[1] - d[1] * t) ** 2 +
            (z - from[2] - d[2] * t) ** 2 <=
          r * r
        )
      },
      colour,
      false,
    )
  }
  /** A single voxel at a world position. */
  voxel(point: Point, colour: Rgb) {
    const s = this.size
    const ix = Math.floor(point[0] / s),
      iy = Math.max(0, Math.floor(point[1] / s)),
      iz = Math.floor(point[2] / s)
    this.cells.set(this.key(ix, iy, iz), { colour, kind: this.kind })
    this.top = Math.max(this.top, (iy + 1) * s)
  }
  get height() {
    return this.top
  }
  /** Iterate cells as integer coordinates. */
  forEach(visit: (ix: number, iy: number, iz: number, colour: Rgb, kind: CellKind) => void) {
    for (const [key, cell] of this.cells) {
      const iz = (key % SPAN) - OFFSET
      const iy = (Math.floor(key / SPAN) % SPAN) - OFFSET
      const ix = Math.floor(key / (SPAN * SPAN)) - OFFSET
      visit(ix, iy, iz, cell.colour, cell.kind)
    }
  }
}

export type VegetationGeometry = Readonly<{
  positions: Float32Array
  normals: Int8Array
  colors: Float32Array
  /** Bend weight per vertex: 0 at the root, 1 at the top. */
  bend: Float32Array
  indices: Uint32Array
  height: number
}>

// BoxGeometry face order: +x, -x, +y, -y, +z, -z. Corners are listed counter-clockwise from outside.
const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
] as const
const AO_LEVELS = [0.42, 0.62, 0.82, 1] as const

function voxelHash(ix: number, iy: number, iz: number, seed: number) {
  let n =
    (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f) ^ seed) >>> 0
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d)
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39)
  return ((n ^ (n >>> 15)) >>> 0) / 0x1_0000_0000
}

/**
 * Mesh exposed faces only. Each corner takes classic voxel ambient occlusion from the three
 * cells in front of it, and each voxel a small hashed tone (Voxen's `surfaceDetail`), so
 * dense foliage reads as depth rather than a flat colour.
 */
export function meshSculpt(
  sculpt: VoxelSculpt,
  options: Readonly<{ seed: number; relief: number; bendFrom: number }>,
): VegetationGeometry {
  const s = sculpt.size
  const positions: number[] = [],
    normals: number[] = [],
    colors: number[] = [],
    bend: number[] = [],
    indices: number[] = []
  const height = Math.max(sculpt.height, s)
  const span = Math.max(height - options.bendFrom, s)
  sculpt.forEach((ix, iy, iz, colour, kind) => {
    if (kind !== 'wood') return
    const tone = 1 + options.relief * (voxelHash(ix, iy, iz, options.seed) - 0.5)
    for (const face of FACES) {
      const [nx, ny, nz] = face.n
      if (sculpt.isWood(ix + nx, iy + ny, iz + nz)) continue
      const base = positions.length / 3
      // The face plane sits on the voxel's positive or negative side.
      const ox = ix + (nx > 0 ? 1 : 0),
        oy = iy + (ny > 0 ? 1 : 0),
        oz = iz + (nz > 0 ? 1 : 0)
      const ao: number[] = []
      for (const [cu, cv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as const) {
        const px = ox + face.u[0] * cu + face.v[0] * cv,
          py = oy + face.u[1] * cu + face.v[1] * cv,
          pz = oz + face.u[2] * cu + face.v[2] * cv
        // Neighbours in the layer in front of the face, around this corner.
        const su = cu === 0 ? -1 : 1,
          sv = cv === 0 ? -1 : 1
        const fx = ix + nx,
          fy = iy + ny,
          fz = iz + nz
        const side1 = sculpt.isWood(fx + face.u[0] * su, fy + face.u[1] * su, fz + face.u[2] * su)
        const side2 = sculpt.isWood(fx + face.v[0] * sv, fy + face.v[1] * sv, fz + face.v[2] * sv)
        const corner = sculpt.isWood(
          fx + face.u[0] * su + face.v[0] * sv,
          fy + face.u[1] * su + face.v[1] * sv,
          fz + face.u[2] * su + face.v[2] * sv,
        )
        const level = side1 && side2 ? 0 : 3 - Number(side1) - Number(side2) - Number(corner)
        const shade = (AO_LEVELS[level] ?? 1) * tone
        ao.push(level)
        positions.push(px * s, py * s, pz * s)
        normals.push(nx * 127, ny * 127, nz * 127)
        colors.push(colour[0] * shade, colour[1] * shade, colour[2] * shade)
        const lift = Math.max(0, py * s - options.bendFrom) / span
        bend.push(Math.min(1, lift * lift))
      }
      // Split along the brighter diagonal so occlusion gradients stay symmetric.
      if ((ao[0] ?? 0) + (ao[2] ?? 0) >= (ao[1] ?? 0) + (ao[3] ?? 0))
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      else indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base)
    }
  })
  return {
    positions: new Float32Array(positions),
    normals: new Int8Array(normals),
    colors: new Float32Array(colors),
    bend: new Float32Array(bend),
    indices: new Uint32Array(indices),
    height,
  }
}

const P = VEGETATION_PALETTE

/** Last Signal `[pine]` conical form: a core cone and seven drooping boughs per tier. */
export function sculptSpruce(seed: number, size: number, spruce: boolean) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  const height = between(random, 2.7, 3.4),
    canopyBase = height * between(random, 0.27, 0.33),
    canopyRadius = height * between(random, 0.26, 0.3),
    layers = 6
  const needles = spruce ? P.spruce : P.needles
  sculpt.limb([0, -0.15, 0], [0, height * 0.9, 0], 0.105, P.bark, 0.035)
  const span = height - canopyBase
  sculpt.kind = 'needle'
  sculpt.cone(canopyBase, span, canopyRadius * 0.2, needles)
  const step = span / (layers + 0.6)
  const phase = random() * TAU
  for (let tier = 0; tier < layers; tier++) {
    const share = tier / (layers - 1)
    const bottom = canopyBase + tier * step
    const radius = canopyRadius * (1 - 0.84 * share)
    const rise = Math.max(step * 0.16, size)
    for (let bough = 0; bough < 7; bough++) {
      const heading = phase + TAU * (tier * GOLDEN_TURN + bough / 7) + between(random, -0.12, 0.12)
      const reach = radius * between(random, 0.9, 1)
      const out = reach * 0.5
      const y = Math.min(
        height - rise,
        bottom + rise + step * ((0.25 * bough) / 7 + between(random, -0.08, 0.08)),
      )
      const colour = random() < 0.15 ? P.needlesPale : needles
      sculpt.ellipsoid(
        [Math.sin(heading) * out, y, Math.cos(heading) * out],
        [reach * 0.26, rise, reach * 0.62],
        colour,
        heading,
        (28 * Math.PI) / 180,
      )
    }
  }
  // A solid spire carries the crown to its tip, so the top tiers do not float apart.
  sculpt.cone(height * 0.66, height * 0.34, canopyRadius * 0.36, needles)
  return sculpt
}

/** Last Signal's mature pine: a tall trunk orange from 55% of the canopy base, an uneven crown. */
export function sculptPine(seed: number, size: number) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  const height = between(random, 3.2, 3.9),
    canopyBase = height * 0.48,
    canopyRadius = height * 0.21
  const orange = canopyBase * 0.55
  sculpt.limb([0, -0.15, 0], [0, orange, 0], 0.18, P.bark, 0.14)
  sculpt.limb([0, orange, 0], [0, height * 0.92, 0], 0.14, P.barkUpper, 0.05)
  // Bark flakes: orange patches scattered over the darker lower trunk.
  for (let flake = 0; flake < 6; flake++) {
    const angle = random() * TAU,
      y = between(random, 0.2, orange)
    sculpt.ellipsoid(
      [Math.sin(angle) * 0.12, y, Math.cos(angle) * 0.12],
      [0.04, between(random, 0.05, 0.1), 0.04],
      P.barkUpper,
      0,
      0,
      true,
    )
  }
  const layers = 6
  const phase = random() * TAU,
    bias = random() * TAU
  const span = height - canopyBase
  // A dense inner mass holds the crown together; the scaffold lobes break its outline.
  sculpt.kind = 'needle'
  sculpt.ellipsoid(
    [0, canopyBase + span * 0.6, 0],
    [canopyRadius * 0.55, span * 0.34, canopyRadius * 0.55],
    P.needles,
  )
  for (let layer = 0; layer < layers; layer++) {
    const share = layer / (layers - 1)
    const heading = phase + layer * TAU * GOLDEN_TURN + between(random, -0.52, 0.52)
    const exposure = 1 + Math.cos(heading - bias) * 0.24
    const out = canopyRadius * between(random, 0.78, 0.94) * exposure * (1 - 0.24 * share)
    const top = canopyBase + span * (0.28 + 0.6 * share + between(random, -0.06, 0.06))
    const attach = canopyBase + (top - canopyBase) * 0.35
    const tip: Point = [Math.sin(heading) * out, top, Math.cos(heading) * out]
    sculpt.kind = 'wood'
    sculpt.limb([0, attach, 0], tip, 0.035, P.barkUpper, size * 0.6)
    sculpt.kind = 'needle'
    // Overlapping terminal masses: flat, wide, slightly lifted at the edges.
    for (let shoot = 0; shoot < 3; shoot++) {
      const yaw = heading + between(random, -0.7, 0.7)
      const r = out * between(random, 0.42, 0.58) + 0.06
      sculpt.ellipsoid(
        [
          tip[0] + Math.sin(yaw) * r * 0.6,
          tip[1] + between(random, -0.05, 0.08),
          tip[2] + Math.cos(yaw) * r * 0.6,
        ],
        [r, r * 0.42, r * 0.85],
        random() < 0.15 ? P.needlesPale : P.needles,
        yaw,
      )
    }
  }
  sculpt.kind = 'needle'
  sculpt.ellipsoid([0, height - 0.12, 0], [0.3, 0.16, 0.3], P.needles)
  return sculpt
}

/** Last Signal's birch: a pale trunk with rotated dark marks and forked leaf sprays. */
export function sculptBirch(seed: number, size: number) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  const height = between(random, 2.6, 3.3)
  const lean = between(random, -0.08, 0.08)
  const top: Point = [lean * height, height * 0.95, 0]
  sculpt.limb([0, -0.15, 0], top, 0.09, P.birchBark, 0.03)
  for (let mark = 0; mark < 9; mark++) {
    const y = between(random, 0.15, height * 0.7)
    const angle = mark * ((47 * Math.PI) / 180) + random()
    sculpt.ellipsoid(
      [lean * y + Math.sin(angle) * 0.08, y, Math.cos(angle) * 0.08],
      [0.05, size * 0.6, 0.03],
      P.birchMark,
      angle,
      0,
      true,
    )
  }
  const phase = random() * TAU
  // The deep inner crown keeps the sprays from reading as separate floating clouds.
  sculpt.kind = 'leaf'
  sculpt.ellipsoid(
    [lean * height * 0.72, height * 0.72, 0],
    [height * 0.15, height * 0.19, height * 0.15],
    P.birchLeavesDeep,
  )
  for (let scaffold = 0; scaffold < 5; scaffold++) {
    const share = scaffold / 4
    const y = height * (0.5 + 0.34 * share)
    const heading = phase + scaffold * TAU * GOLDEN_TURN
    const reach = height * (0.2 - 0.08 * share) * between(random, 0.85, 1.1)
    const from: Point = [lean * y, y, 0]
    const fork: Point = [
      from[0] + Math.sin(heading) * reach,
      y + reach * 0.55,
      Math.cos(heading) * reach,
    ]
    sculpt.kind = 'wood'
    sculpt.limb(from, fork, 0.025, P.birchBark, size * 0.5)
    sculpt.kind = 'leaf'
    for (let spray = 0; spray < 4; spray++) {
      const yaw = heading + between(random, -0.9, 0.9)
      const r = between(random, 0.27, 0.38) * (1 - 0.25 * share)
      sculpt.ellipsoid(
        [
          fork[0] + Math.sin(yaw) * r * 0.5,
          fork[1] + between(random, -0.08, 0.12),
          fork[2] + Math.cos(yaw) * r * 0.5,
        ],
        [r, r * 0.7, r * 0.9],
        random() < 0.35 ? P.birchLeavesDeep : P.birchLeaves,
        yaw,
      )
    }
    // Birch twigs hang: a deep curtain under each lower fork rounds the crown's underside,
    // which otherwise sits flat on the scaffolds like an umbrella.
    if (scaffold < 4) {
      const r = height * 0.1 * between(random, 0.9, 1.15)
      sculpt.ellipsoid(
        [
          fork[0] + Math.sin(heading) * r * 0.6,
          fork[1] - r * 0.9,
          fork[2] + Math.cos(heading) * r * 0.6,
        ],
        [r * 0.8, r * 1.1, r * 0.8],
        P.birchLeavesDeep,
        heading,
      )
    }
  }
  return sculpt
}

/** Last Signal's shrub: a dozen overlapping clumps, the deep tone inside. */
export function sculptBush(seed: number, size: number) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  sculpt.kind = 'leaf'
  const radius = between(random, 0.32, 0.45),
    height = radius * 0.65
  for (let clump = 0; clump < 12; clump++) {
    const angle = random() * TAU,
      out = radius * Math.sqrt(random()) * 0.7
    const r = radius * between(random, 0.3, 0.5)
    sculpt.ellipsoid(
      [Math.sin(angle) * out, height * between(random, 0.35, 0.7), Math.cos(angle) * out],
      [r, r * 0.8, r],
      clump < 4 ? P.shrubDeep : P.shrub,
    )
  }
  return sculpt
}

/** One foliage clump: Voxen's seed of a step-cube block of uncovered foliage cells. */
export type FoliageSeed = Readonly<{
  /** Model-space centroid, metres. */
  center: Point
  /** Unit direction toward open air, from probes 1–3 pitches out in 26 directions. */
  open: Point
  /** Share of empty probes: 1 at an isolated tuft, low deep inside a crown. */
  openness: number
  colour: Rgb
  leaf: boolean
  /** Hash shared by the clumps of a 3-pitch cluster, for a common scale and value. */
  cluster: number
  /** Height of the centroid as a share of the model height. */
  height: number
}>

const NEIGHBOURS: Point[] = []
for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++)
    for (let z = -1; z <= 1; z++) {
      if (x === 0 && y === 0 && z === 0) continue
      const length = Math.hypot(x, y, z)
      NEIGHBOURS.push([x / length, y / length, z / length])
    }

/**
 * Reduce foliage cells to one seed per `pitch`-cell block that has an exposed face, as Voxen's
 * clump planner does: centroid, majority role, mean colour, and the local crown shape probed
 * at the 26 neighbour directions one, two and three pitches out.
 */
export function foliageSeeds(sculpt: VoxelSculpt, pitch: number): FoliageSeed[] {
  type Block = {
    x: number
    y: number
    z: number
    count: number
    r: number
    g: number
    b: number
    leaves: number
    surface: boolean
    key: readonly [number, number, number]
  }
  const blocks = new Map<string, Block>()
  sculpt.forEach((ix, iy, iz, colour, kind) => {
    if (kind === 'wood') return
    const bx = Math.floor(ix / pitch),
      by = Math.floor(iy / pitch),
      bz = Math.floor(iz / pitch)
    const name = `${bx}:${by}:${bz}`
    let block = blocks.get(name)
    if (!block) {
      block = {
        x: 0,
        y: 0,
        z: 0,
        count: 0,
        r: 0,
        g: 0,
        b: 0,
        leaves: 0,
        surface: false,
        key: [bx, by, bz],
      }
      blocks.set(name, block)
    }
    block.x += ix
    block.y += iy
    block.z += iz
    block.count++
    block.r += colour[0]
    block.g += colour[1]
    block.b += colour[2]
    if (kind === 'leaf') block.leaves++
    if (!block.surface)
      for (const face of FACES)
        if (!sculpt.has(ix + face.n[0], iy + face.n[1], iz + face.n[2])) {
          block.surface = true
          break
        }
  })
  const s = sculpt.size,
    step = pitch * s,
    height = Math.max(sculpt.height, s)
  const seeds: FoliageSeed[] = []
  for (const block of blocks.values()) {
    if (!block.surface) continue
    const center: Point = [
      (block.x / block.count + 0.5) * s,
      (block.y / block.count + 0.5) * s,
      (block.z / block.count + 0.5) * s,
    ]
    let ox = 0,
      oy = 0,
      oz = 0,
      empty = 0
    for (const d of NEIGHBOURS)
      for (let k = 1; k <= 3; k++) {
        if (
          sculpt.occupied([
            center[0] + d[0] * k * step,
            center[1] + d[1] * k * step,
            center[2] + d[2] * k * step,
          ])
        )
          continue
        empty++
        ox += d[0] / k
        oy += d[1] / k
        oz += d[2] / k
      }
    const length = Math.hypot(ox, oy, oz)
    const [cx, cy, cz] = block.key.map((v) => Math.floor(v / 3))
    seeds.push({
      center,
      open: length > 1e-6 ? [ox / length, oy / length, oz / length] : [0, 1, 0],
      openness: empty / (NEIGHBOURS.length * 3),
      colour: [block.r / block.count, block.g / block.count, block.b / block.count],
      leaf: block.leaves * 2 > block.count,
      cluster: voxelHash(cx ?? 0, cy ?? 0, cz ?? 0, 0x5eed),
      height: center[1] / height,
    })
  }
  return seeds
}

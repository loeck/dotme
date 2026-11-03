/**
 * Micro-voxel vegetation after Voxen's Last Signal (`pine.model.ts`, `undergrowth.model.ts`,
 * `props.toml`): models are carved from ellipsoid, cone and limb operations on a fine grid,
 * then meshed once with per-corner ambient occlusion and per-voxel tone. Everything here is
 * pure and deterministic so the world worker can prepare it and transfer typed arrays.
 */
type Rgb = readonly [number, number, number]
type Point = readonly [number, number, number]

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
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

type Colour = Rgb | ((y: number) => Rgb)

/** A sparse voxel model. Later operations overwrite earlier ones, as in Voxen's model ops. */
export class VoxelSculpt {
  readonly size: number
  readonly cells = new Map<number, Rgb>()
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
          this.cells.set(key, typeof colour === 'function' ? colour(y) : colour)
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
    this.cells.set(this.key(ix, iy, iz), colour)
    this.top = Math.max(this.top, (iy + 1) * s)
  }
  get height() {
    return this.top
  }
  /** Iterate cells as integer coordinates. */
  forEach(visit: (ix: number, iy: number, iz: number, colour: Rgb) => void) {
    for (const [key, colour] of this.cells) {
      const iz = (key % SPAN) - OFFSET
      const iy = (Math.floor(key / SPAN) % SPAN) - OFFSET
      const ix = Math.floor(key / (SPAN * SPAN)) - OFFSET
      visit(ix, iy, iz, colour)
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
  sculpt.forEach((ix, iy, iz, colour) => {
    const tone = 1 + options.relief * (voxelHash(ix, iy, iz, options.seed) - 0.5)
    for (const face of FACES) {
      const [nx, ny, nz] = face.n
      if (sculpt.has(ix + nx, iy + ny, iz + nz)) continue
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
        const side1 = sculpt.has(fx + face.u[0] * su, fy + face.u[1] * su, fz + face.u[2] * su)
        const side2 = sculpt.has(fx + face.v[0] * sv, fy + face.v[1] * sv, fz + face.v[2] * sv)
        const corner = sculpt.has(
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
    canopyBase = height * between(random, 0.1, 0.16),
    canopyRadius = height * between(random, 0.26, 0.3),
    layers = 6
  const needles = spruce ? P.spruce : P.needles
  sculpt.limb([0, -0.15, 0], [0, height * 0.9, 0], 0.07, P.bark, 0.03)
  const span = height - canopyBase
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
  sculpt.limb([0, height * 0.85, 0], [0, height, 0], size, needles)
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
  sculpt.limb([0, -0.15, 0], [0, orange, 0], 0.11, P.bark, 0.095)
  sculpt.limb([0, orange, 0], [0, height * 0.92, 0], 0.095, P.barkUpper, 0.045)
  // Bark flakes: orange patches scattered over the darker lower trunk.
  for (let flake = 0; flake < 6; flake++) {
    const angle = random() * TAU,
      y = between(random, 0.2, orange)
    sculpt.ellipsoid(
      [Math.sin(angle) * 0.08, y, Math.cos(angle) * 0.08],
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
    sculpt.limb([0, attach, 0], tip, 0.035, P.barkUpper, size * 0.6)
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
  sculpt.limb([0, -0.15, 0], top, 0.06, P.birchBark, 0.025)
  for (let mark = 0; mark < 9; mark++) {
    const y = between(random, 0.15, height * 0.7)
    const angle = mark * ((47 * Math.PI) / 180) + random()
    sculpt.ellipsoid(
      [lean * y + Math.sin(angle) * 0.05, y, Math.cos(angle) * 0.05],
      [0.05, size * 0.6, 0.03],
      P.birchMark,
      angle,
      0,
      true,
    )
  }
  const phase = random() * TAU
  // The deep inner crown keeps the sprays from reading as separate floating clouds.
  sculpt.ellipsoid(
    [lean * height * 0.68, height * 0.68, 0],
    [height * 0.15, height * 0.22, height * 0.15],
    P.birchLeavesDeep,
  )
  for (let scaffold = 0; scaffold < 5; scaffold++) {
    const share = scaffold / 4
    const y = height * (0.42 + 0.4 * share)
    const heading = phase + scaffold * TAU * GOLDEN_TURN
    const reach = height * (0.2 - 0.08 * share) * between(random, 0.85, 1.1)
    const from: Point = [lean * y, y, 0]
    const fork: Point = [
      from[0] + Math.sin(heading) * reach,
      y + reach * 0.55,
      Math.cos(heading) * reach,
    ]
    sculpt.limb(from, fork, 0.025, P.birchBark, size * 0.5)
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
  }
  return sculpt
}

/** Last Signal's shrub: a dozen overlapping clumps, the deep tone inside. */
export function sculptBush(seed: number, size: number) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
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

/** A grass tuft: one-voxel blades leaning out of a clump, tinted from root to dry tip. */
export function sculptTuft(seed: number, size: number) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  const blades = 7 + Math.floor(random() * 6)
  const tallest = between(random, 0.2, 0.32)
  const dryness = between(random, 0, 0.35)
  const tip = mixRgb(P.grassTip, P.grassDry, dryness)
  for (let blade = 0; blade < blades; blade++) {
    const angle = random() * TAU
    const root = between(random, 0, 0.05)
    const h = tallest * between(random, 0.55, 1)
    const leanOut = between(random, 0.06, 0.16)
    const base: Point = [Math.sin(angle) * root, 0, Math.cos(angle) * root]
    // Two segments make an arc: nearly upright at the root, bending out toward the tip.
    const mid: Point = [
      base[0] + Math.sin(angle) * leanOut * 0.3,
      h * 0.6,
      base[2] + Math.cos(angle) * leanOut * 0.3,
    ]
    const end: Point = [base[0] + Math.sin(angle) * leanOut, h, base[2] + Math.cos(angle) * leanOut]
    // Groundtint at the root, brighter and drier toward the tip (`[[grass]]` in forest.toml).
    const shade = (y: number) => mixRgb(P.grassBase, tip, Math.min(1, y / h) ** 0.8)
    sculpt.limb(base, mid, size * 0.5, shade)
    sculpt.limb(mid, end, size * 0.5, shade)
  }
  return sculpt
}

/** A fern: five arching fronds with alternating leaflets. */
export function sculptFern(seed: number, size: number) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  const phase = random() * TAU
  for (let frond = 0; frond < 5; frond++) {
    const heading = phase + (frond / 5) * TAU + between(random, -0.2, 0.2)
    const length = between(random, 0.3, 0.42)
    const steps = Math.ceil(length / size)
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const along = length * t
      const y = 0.03 + 0.2 * Math.sin(Math.PI * t * 0.85) - 0.05 * t
      const cx = Math.sin(heading) * along,
        cz = Math.cos(heading) * along
      sculpt.voxel([cx, y, cz], P.fern)
      if (step % 2 === 0 && t > 0.15 && t < 0.95) {
        const leaf = (1 - t) * 0.09 + size
        for (const side of [-1, 1]) {
          const sx = Math.cos(heading) * side,
            sz = -Math.sin(heading) * side
          for (let k = 1; k * size <= leaf; k++)
            sculpt.voxel([cx + sx * k * size, y - k * size * 0.3, cz + sz * k * size], P.fern)
        }
      }
    }
  }
  return sculpt
}

/** A small flower: a stem and a petal cross around a warm heart. */
export function sculptFlower(seed: number, size: number, petal: Rgb) {
  const random = mulberry32(seed)
  const sculpt = new VoxelSculpt(size)
  const stems = 1 + Math.floor(random() * 3)
  for (let stem = 0; stem < stems; stem++) {
    const angle = random() * TAU,
      out = stem === 0 ? 0 : between(random, 0.03, 0.07)
    const h = between(random, 0.14, 0.26)
    const top: Point = [Math.sin(angle) * out, h, Math.cos(angle) * out]
    sculpt.limb([top[0] * 0.3, 0, top[2] * 0.3], top, size * 0.5, P.flowerStem)
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      sculpt.voxel([top[0] + dx * size, top[1] + size, top[2] + dz * size], petal)
    sculpt.voxel([top[0], top[1] + size, top[2]], P.flowerHeart)
  }
  return sculpt
}

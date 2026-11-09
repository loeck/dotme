/**
 * Procedural trees and shrubs of a temperate lake in summer: oak and beech, silver birch, leafy
 * shrubs, and the Norway spruce and Scots pine of the former boreal shore (spruce saplings still
 * grow at the wood's edge). Each model grows a branch skeleton by its species' habit, meshes
 * its wood as smooth tapered tubes and clothes its twigs with foliage cards from the botanical
 * atlas (`foliage-atlas.ts`). Everything is pure and deterministic, so the world worker can prepare
 * it and transfer typed arrays.
 */
import { ATLAS_TILES } from './foliage-atlas'
import type { AtlasTile } from './foliage-atlas'
import { clamp, smoothstep as smooth01 } from './math'

export type Rgb = readonly [number, number, number]
export type Point = readonly [number, number, number]

/**
 * Linear albedos, in measured ranges for bark, needles and leaves in visible light: conifer
 * needles reflect little red and blue (about 0.03 and 0.02) against 0.06–0.09 green; sunlit, the
 * haze and sky light already desaturate them, so the albedo keeps their full green.
 */
export const VEGETATION_PALETTE = {
  needles: [0.034, 0.078, 0.022],
  needlesPale: [0.048, 0.094, 0.03],
  spruce: [0.024, 0.06, 0.028],
  sprucePale: [0.034, 0.074, 0.036],
  bark: [0.075, 0.06, 0.048],
  barkSpruce: [0.09, 0.075, 0.062],
  barkUpper: [0.24, 0.1, 0.045],
  barkDead: [0.11, 0.1, 0.09],
  birchBark: [0.42, 0.41, 0.38],
  birchMark: [0.045, 0.043, 0.04],
  birchLeaves: [0.068, 0.135, 0.03],
  birchLeavesDeep: [0.05, 0.1, 0.026],
  // Summer broadleaves: an oak's leaves darker and a little bluer, a beech's or a lime's fresher.
  oakLeaves: [0.06, 0.126, 0.026],
  oakLeavesDeep: [0.036, 0.084, 0.02],
  beechLeaves: [0.082, 0.16, 0.032],
  beechLeavesDeep: [0.05, 0.11, 0.024],
  oakBark: [0.075, 0.062, 0.048],
  beechBark: [0.16, 0.148, 0.128],
  shrub: [0.06, 0.12, 0.035],
  juniper: [0.035, 0.058, 0.042],
  juniperPale: [0.05, 0.072, 0.052],
  shrubDeep: [0.038, 0.08, 0.026],
  grassBase: [0.05, 0.085, 0.022],
  grassTip: [0.13, 0.2, 0.045],
  grassDry: [0.24, 0.2, 0.09],
  fern: [0.07, 0.13, 0.035],
  flowerStem: [0.06, 0.11, 0.03],
  flowerWhite: [0.62, 0.62, 0.56],
  // Meadow buttercup: a glossy, saturated yellow.
  flowerYellow: [0.7, 0.52, 0.03],
  flowerHeart: [0.55, 0.36, 0.05],
} as const satisfies Record<string, Rgb>

const TAU = Math.PI * 2
const GOLDEN_TURN = 0.38196601125

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
const scaleRgb = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]

const add = (a: Point, b: Point, k = 1): Point => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
]
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (v: Point): Point => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}
/** Unit direction from a heading about Y (0 = +Z) and an elevation above the horizon. */
const heading = (yaw: number, elevation: number): Point => [
  Math.sin(yaw) * Math.cos(elevation),
  Math.sin(elevation),
  Math.cos(yaw) * Math.cos(elevation),
]

export type VegetationGeometry = Readonly<{
  positions: Float32Array
  normals: Int8Array
  colors: Float32Array
  /** Bark coordinates: integer wraps around each tube, metres along its centreline. */
  uvs: Float32Array
  /** Species-specific furrow strength, independent of the bark palette and dark marks. */
  furrows: number
  /** Fine horizontal lenticel marks, used by silver birch. */
  lenticels: number
  /** Bend weight per vertex: 0 at the root, 1 at the top. */
  bend: Float32Array
  indices: Uint32Array
  height: number
}>

/**
 * One foliage card in model space: centred at `center`, spanning `width` along `t` and
 * `height` along `b` (the atlas's up), lit with `normal`. `shade` darkens cards deep inside the
 * crown, where little sky reaches them.
 */
export type Spray = Readonly<{
  center: Point
  t: Point
  b: Point
  width: number
  height: number
  normal: Point
  colour: Rgb
  shade: number
  tile: AtlasTile
}>

export type TreeModel = Readonly<{
  wood: VegetationGeometry
  sprays: readonly Spray[]
  height: number
}>

/** Mesh detail: tube sides for trunks and limbs, and the spacing factor between sprays. */
export type ModelDetail = Readonly<{ trunkSides: number; limbSides: number; spacing: number }>
export const MODEL_DETAIL = {
  desktop: { trunkSides: 8, limbSides: 4, spacing: 1 },
  mobile: { trunkSides: 6, limbSides: 3, spacing: 1.35 },
  /** Trees far from the camera: half the sprays (drawn larger) and lighter wood. */
  desktopFar: { trunkSides: 5, limbSides: 3, spacing: 2.3 },
  mobileFar: { trunkSides: 4, limbSides: 3, spacing: 2.4 },
} as const satisfies Record<string, ModelDetail>

/** Wood as generalized cylinders: rings along a path with parallel-transported frames. */
export class WoodBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly colors: number[] = []
  private readonly uvs: number[] = []
  private readonly indices: number[] = []
  private reference: Point = [1, 0, 0]
  private readonly furrows: number
  private readonly lenticels: number

  constructor(furrows = 1, lenticels = 0) {
    this.furrows = furrows
    this.lenticels = lenticels
  }

  /**
   * A tube through `points` with a radius per point. `colour(s, angle)` paints a vertex from
   * its share of the length and its angle around the tube.
   */
  tube(
    points: readonly Point[],
    radii: readonly number[],
    sides: number,
    colour: (s: number, angle: number) => Rgb,
    cut?: Rgb,
  ) {
    if (points.length < 2) return
    const first = this.positions.length / 3
    // Integer wraps join the repeating scan at the seam. A duplicated seam vertex keeps
    // triangles from interpolating backwards across the whole texture.
    const stride = sides + 1
    const wraps = Math.max(1, Math.round(Math.max(...radii) * TAU * 1.4))
    const origin = points[0] ?? [0, 0, 0]
    const offsetU = origin[0] * 1.73 + origin[2] * 0.91
    const offsetV = origin[1] * 0.83 + origin[0] * 0.37
    let normal: Point | null = null
    let length = 0
    const lengths = [0]
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(...sub(points[i] ?? [0, 0, 0], points[i - 1] ?? [0, 0, 0]))
      lengths.push(length)
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i] ?? [0, 0, 0]
      const before = points[Math.max(0, i - 1)] ?? p
      const after = points[Math.min(points.length - 1, i + 1)] ?? p
      const tangent = normalize(sub(after, before))
      // Parallel transport: carry the previous ring's normal across, so tubes never twist.
      const guess: Point = normal ?? this.reference
      let n = sub(guess, scale(tangent, dot(guess, tangent)))
      if (Math.hypot(...n) < 1e-4) n = cross(tangent, [0, 0, 1])
      if (Math.hypot(...n) < 1e-4) n = cross(tangent, [1, 0, 0])
      normal = normalize(n)
      const binormal = cross(tangent, normal)
      const radius = radii[i] ?? 0
      const s = length > 0 ? (lengths[i] ?? 0) / length : 0
      // Elliptical growth and shallow lobes share the seam's periodicity. Smooth species
      // keep rounder stems; older fissured bark follows stronger, slowly changing ribs.
      const irregularity = 0.025 + this.furrows * 0.075
      const phase = offsetU * 2.1
      const swell = 1 + irregularity * 0.45 * Math.sin(s * 8 + phase)
      const taper =
        ((radii[Math.min(i + 1, radii.length - 1)] ?? radius) -
          (radii[Math.max(0, i - 1)] ?? radius)) /
        Math.max(0.001, Math.hypot(...sub(after, before)))
      for (let side = 0; side <= sides; side++) {
        const angle = (side / sides) * TAU
        const out = add(scale(normal, Math.cos(angle)), binormal, Math.sin(angle))
        const lobes = Math.cos(angle * 2 + phase) * 0.65 + Math.sin(angle * 3 - s * 1.2) * 0.35
        const shape = swell * (1 + irregularity * lobes)
        const derivative =
          (irregularity *
            (-1.3 * Math.sin(angle * 2 + phase) + 1.05 * Math.cos(angle * 3 - s * 1.2))) /
          (1 + irregularity * lobes)
        const around = add(scale(normal, -Math.sin(angle)), binormal, Math.cos(angle))
        const outward = normalize(add(add(out, around, -derivative), tangent, -taper))
        const q = add(p, out, radius * shape)
        this.positions.push(q[0], q[1], q[2])
        this.normals.push(outward[0], outward[1], outward[2])
        const c = colour(s, angle)
        this.colors.push(c[0], c[1], c[2])
        this.uvs.push((side / sides) * wraps + offsetU, (lengths[i] ?? 0) + offsetV)
      }
    }
    for (let i = 0; i < points.length - 1; i++)
      for (let side = 0; side < sides; side++) {
        const a = first + i * stride + side
        const b = a + 1
        const c = a + stride,
          d = b + stride
        // Counter-clockwise from outside: (ring i, a), (ring i, a + 1), (ring i + 1, a).
        this.indices.push(a, b, c, b, d, c)
      }
    if (cut) {
      const end = points[points.length - 1] ?? origin
      const tangent = normalize(sub(end, points[points.length - 2] ?? origin))
      const centre = this.positions.length / 3
      this.positions.push(...end)
      this.normals.push(...tangent)
      this.colors.push(...cut)
      this.uvs.push(0.5, 0.5)
      for (let side = 0; side <= sides; side++) {
        const source = (first + (points.length - 1) * stride + side) * 3
        this.positions.push(...this.positions.slice(source, source + 3))
        this.normals.push(...tangent)
        this.colors.push(...scaleRgb(cut, 0.64))
        const angle = (side / sides) * TAU
        this.uvs.push(0.5 + Math.cos(angle) * 0.45, 0.5 + Math.sin(angle) * 0.45)
        if (side < sides) this.indices.push(centre, centre + side + 1, centre + side + 2)
      }
    }
  }

  /** An extra shoulder ring rounds the branch collar without changing its outer path. */
  branch(
    points: readonly Point[],
    radii: readonly number[],
    sides: number,
    colour: (s: number, angle: number) => Rgb,
  ) {
    const from = points[0],
      next = points[1]
    if (!from || !next) return
    const radius = radii[0] ?? 0
    const distance = Math.hypot(...sub(next, from))
    const t = Math.min(0.35, radius / Math.max(distance, 0.001))
    this.tube(
      [from, add(from, sub(next, from), t), ...points.slice(1)],
      [radius * 1.45, radius * 1.18, ...radii.slice(1)],
      sides,
      colour,
    )
  }

  build(bendFrom: number): VegetationGeometry {
    let height = 0.1
    for (let i = 1; i < this.positions.length; i += 3)
      height = Math.max(height, this.positions[i] ?? 0)
    const span = Math.max(height - bendFrom, 0.1)
    const bend = new Float32Array(this.positions.length / 3)
    for (let i = 0; i < bend.length; i++) {
      const lift = Math.max(0, (this.positions[i * 3 + 1] ?? 0) - bendFrom) / span
      bend[i] = Math.min(1, lift * lift)
    }
    return {
      positions: new Float32Array(this.positions),
      normals: new Int8Array(this.normals.map((v) => Math.round(v * 127))),
      colors: new Float32Array(this.colors),
      uvs: new Float32Array(this.uvs),
      furrows: this.furrows,
      lenticels: this.lenticels,
      bend,
      indices: new Uint32Array(this.indices),
      height,
    }
  }
}

/** Points along a limb that leaves `from` along `direction`, sags and lifts its tip. */
function limbPath(
  from: Point,
  direction: Point,
  length: number,
  segments: number,
  sag: number,
  lift: number,
): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= segments; i++) {
    const s = i / segments
    const p = add(from, direction, length * s)
    points.push([p[0], p[1] + length * (-sag * s * s + lift * s * s * s), p[2]])
  }
  return points
}

/** Position and unit tangent at a share `s` of a polyline's length. */
function along(points: readonly Point[], s: number): { p: Point; tangent: Point } {
  const segments = points.length - 1
  const x = clamp(s, 0, 1) * segments
  const i = Math.min(segments - 1, Math.floor(x))
  const a = points[i] ?? [0, 0, 0],
    b = points[i + 1] ?? a
  const f = x - i
  return { p: add(a, sub(b, a), f), tangent: normalize(sub(b, a)) }
}

/** A gently wandering trunk: points from below the ground to the top. */
function trunkPath(random: () => number, height: number, segments: number, wander: number) {
  const lean = heading(random() * TAU, 0)
  const leanAmount = between(random, 0, wander)
  const phase = random() * TAU,
    turn = random() * TAU
  const points: Point[] = []
  for (let i = 0; i <= segments; i++) {
    const s = i / segments
    const y = -0.15 + (height + 0.15) * s
    const sway = Math.sin(s * 5 + phase) * wander * 0.25 * s
    points.push([
      lean[0] * leanAmount * s * height + Math.cos(turn) * sway,
      y,
      lean[2] * leanAmount * s * height + Math.sin(turn) * sway,
    ])
  }
  return points
}

/** Cards spanning a horizontal-ish shoot and hanging from it, rolled about the shoot. */
function hangingCard(
  center: Point,
  shoot: Point,
  width: number,
  height: number,
  roll: number,
  colour: Rgb,
  tile: AtlasTile,
): Spray {
  let t = normalize([shoot[0], shoot[1] * 0.35, shoot[2]])
  if (Math.hypot(t[0], t[2]) < 0.2) t = [1, 0, 0]
  // The atlas's up runs from the hanging branchlets to the shoot: start upright, then roll.
  let b = normalize(sub([0, 1, 0], scale(t, t[1])))
  const n = cross(t, b)
  b = normalize(add(scale(b, Math.cos(roll)), n, Math.sin(roll)))
  return {
    center: add(center, b, -height * 0.32),
    t,
    b,
    width,
    height,
    normal: cross(t, b),
    colour,
    shade: 1,
    tile,
  }
}

/** A card standing about upright, turned to `yaw` and tipped back by `tilt`. */
function uprightCard(
  center: Point,
  yaw: number,
  tilt: number,
  width: number,
  height: number,
  colour: Rgb,
  tile: AtlasTile,
): Spray {
  const t: Point = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const facing: Point = [Math.sin(yaw), 0, Math.cos(yaw)]
  const b = normalize(add([0, Math.cos(tilt), 0], facing, -Math.sin(tilt)))
  return { center, t, b, width, height, normal: cross(t, b), colour, shade: 1, tile }
}

/** A card's 0.5 m band of height, for the crown's envelope. */
const crownBand = (y: number) => Math.floor(y / 0.5)

/**
 * Light the cards as one crown: normals lean toward the crown's outside (from an axis through
 * its centre), and cards deep inside, near the trunk, darken where little sky reaches them.
 */
function shapeCrown(sprays: Spray[], centreHeight: number, axisLean: Point = [0, 0, 0]): Spray[] {
  if (!sprays.length) return sprays
  // Envelope: the farthest card from the axis, per 0.5 m band of height (`crownBand`).
  const axisAt = (y: number): Point => [axisLean[0] * y, y, axisLean[2] * y]
  const reach = new Map<number, number>()
  for (const spray of sprays) {
    const axis = axisAt(spray.center[1])
    const r = Math.hypot(spray.center[0] - axis[0], spray.center[2] - axis[2])
    const key = crownBand(spray.center[1])
    reach.set(key, Math.max(reach.get(key) ?? 0, r))
  }
  const centre = axisAt(centreHeight)
  const topHeight = Math.max(...sprays.map((spray) => spray.center[1]), 0.1)
  return sprays.map((spray) => {
    const y = spray.center[1]
    const axis = axisAt(y)
    const r = Math.hypot(spray.center[0] - axis[0], spray.center[2] - axis[2])
    const envelope = Math.max(
      reach.get(crownBand(y)) ?? 0,
      reach.get(crownBand(y) - 1) ?? 0,
      reach.get(crownBand(y) + 1) ?? 0,
      0.2,
    )
    const outside = clamp(r / envelope, 0, 1)
    // The upward part is damped: crown tops lit straight from the sky read as a pale lid.
    const out = sub(spray.center, centre)
    const radial = normalize([out[0], out[1] > 0 ? out[1] * 0.35 : out[1], out[2]])
    let normal = normalize(spray.normal)
    if (dot(normal, radial) < 0) normal = scale(normal, -1)
    return {
      ...spray,
      normal: normalize(add(scale(normal, 0.35), radial, 0.65)),
      // A crown is dark inside: cards near the trunk keep a third of their value, and the
      // lower crown, shaded by the upper, a little less than the top.
      shade:
        spray.shade *
        (0.32 + 0.68 * Math.pow(outside, 1.1)) *
        (0.8 + 0.2 * smooth01(0, topHeight, spray.center[1])),
    }
  })
}

const P = VEGETATION_PALETTE

/**
 * Norway spruce: a straight trunk with whorls of branches that leave level, sag and lift their
 * tips, longest at the bottom of a narrow cone; combed branchlets hang from each branch, and a
 * slim leader carries the spire.
 */
export function growSpruce(
  seed: number,
  detail: ModelDetail,
  dark: boolean,
  heights: readonly [number, number] = [5.6, 7],
): TreeModel {
  const random = mulberry32(seed)
  const wood = new WoodBuilder()
  const sprays: Spray[] = []
  const height = between(random, heights[0], heights[1])
  // Saplings keep a mature tree's habit at their own size.
  const youth = Math.min(1, height / 6)
  const crownBase = height * between(random, 0.1, 0.17)
  const crownRadius = height * between(random, 0.17, 0.19)
  const needles = dark ? P.spruce : P.needles
  const pale = dark ? P.sprucePale : P.needlesPale
  const trunk = trunkPath(random, height, 12, 0.02)
  const trunkRadius = 0.03 + height * 0.01
  wood.tube(
    trunk,
    trunk.map((_, i) => trunkRadius * (1 - (0.94 * i) / 12)),
    youth > 0.5 ? detail.trunkSides : 5,
    (s, angle) =>
      scaleRgb(P.barkSpruce, (0.85 + 0.15 * Math.sin(angle * 3 + s * 20)) * (0.8 + 0.25 * s)),
  )
  // Internodes are shorter on a young tree.
  const whorls = Math.round((height - crownBase) / (0.3 * Math.max(0.5, youth)))
  const phase = random() * TAU
  for (let whorl = 0; whorl < whorls; whorl++) {
    const t = whorl / whorls
    const y = crownBase + (height - crownBase) * t + between(random, -0.05, 0.05)
    const whorlCentre = along(trunk, (y + 0.15) / (height + 0.15)).p
    // A narrow cone, its bottom whorls a little shorter where older branches have died back.
    const length =
      (crownRadius * Math.pow(1 - t, 0.95) + 0.12) * (0.75 + 0.25 * smooth01(0, 0.12, t))
    // A whorl of main branches, then smaller internodal ones between it and the next.
    const main = 4 + Math.floor(random() * 3)
    const count = main + 2 + Math.floor(random() * 2)
    for (let branch = 0; branch < count; branch++) {
      const internodal = branch >= main
      const yaw = internodal
        ? random() * TAU
        : phase + TAU * (whorl * GOLDEN_TURN + branch / main) + between(random, -0.2, 0.2)
      const reach = length * between(random, 0.8, 1.1) * (internodal ? 0.6 : 1)
      const centre = internodal
        ? along(trunk, (y + 0.15 * (0.3 + random() * 0.4) + 0.15) / (height + 0.15)).p
        : whorlCentre
      const elevation = ((-12 + 30 * t) * Math.PI) / 180
      const sag = (0.32 - 0.22 * t) * between(random, 0.8, 1.2)
      const path = limbPath(centre, heading(yaw, elevation), reach, 3, sag, 0.22)
      // Only main branches carry wood: the foliage hides the thin internodal ones entirely, and
      // a sapling's branches, the short upper ones and a far tree's altogether.
      if (!internodal && youth > 0.5 && t < 0.7 && detail.spacing < 2)
        wood.tube(
          path,
          path.map((_, i) => (0.006 + reach * 0.016) * (1 - i / 3.4)),
          3,
          () => scaleRgb(P.barkSpruce, 0.75),
        )
      // Sprays along the branch's outer two thirds; the spacing shrinks with the branch.
      const step = 0.09 * detail.spacing
      const shoots = Math.max(1, Math.round((reach * 0.7) / step))
      for (let shoot = 0; shoot < shoots; shoot++) {
        const s = 0.32 + (0.68 * (shoot + 0.5)) / shoots
        const { p, tangent } = along(path, s)
        // Sprays shrink toward the branch tip and up the crown, so the cone stays pointed.
        const size =
          (0.28 * Math.max(0.4, youth) + reach * 0.42) *
          between(random, 0.85, 1.15) *
          (1.1 - 0.35 * s)
        const colour = random() < 0.1 ? pale : needles
        const tile = random() < 0.5 ? ATLAS_TILES.spruceA : ATLAS_TILES.spruceB
        sprays.push(
          hangingCard(p, tangent, size, size * 0.85, between(random, -0.45, 0.45), colour, tile),
        )
        // Some sprays turn across the branch, so a branch pointing at the viewer still shows.
        if (random() < 0.9)
          sprays.push(
            hangingCard(
              p,
              cross([0, 1, 0], tangent),
              size * 0.8,
              size * 0.7,
              between(random, -0.5, 0.5),
              needles,
              tile,
            ),
          )
      }
    }
    // A dark core around the trunk, where the shaded inner branches have shed most needles.
    // Dense sprays now hide most of the inside, so cores only fill every third whorl, smaller:
    // large cards stacked deep in a crown cost far more fill than they add.
    if (whorl % 3 === 0 && t < 0.8) {
      const core = crownRadius * (1 - t) * 0.6 + 0.15 * youth
      sprays.push({
        ...uprightCard(
          whorlCentre,
          random() * TAU,
          0,
          core,
          core * 0.7,
          scaleRgb(needles, 0.55),
          ATLAS_TILES.disc,
        ),
        shade: 0.6,
      })
    }
  }
  // The leader: a slim, dense spire of upright sprays over the last whorls, so the tip reads
  // as solid needles against the sky rather than a few cards the sky shows through.
  for (let k = 0; k < 10; k++) {
    const y = height * (0.8 + 0.018 * k)
    sprays.push(
      uprightCard(
        along(trunk, (y + 0.15) / (height + 0.15)).p,
        k * TAU * GOLDEN_TURN + phase,
        0,
        (0.42 - 0.025 * k) * youth,
        0.55 * youth,
        needles,
        k % 2 === 0 ? ATLAS_TILES.spruceA : ATLAS_TILES.pineA,
      ),
    )
  }
  return {
    wood: wood.build(0.4),
    sprays: shapeCrown(sprays, crownBase + (height - crownBase) * 0.35),
    height,
  }
}

/**
 * Scots pine: a tall trunk, grey-brown and furrowed below and orange and flaking above, bare up
 * to the crown but for a few dead stubs; a few scaffold limbs rise and fork, and each fork ends
 * in a flattish cloud of needle tufts.
 */
export function growPine(seed: number, detail: ModelDetail): TreeModel {
  const random = mulberry32(seed)
  const wood = new WoodBuilder()
  const sprays: Spray[] = []
  const height = between(random, 6, 7.5)
  const crownBase = height * between(random, 0.55, 0.65)
  const trunk = trunkPath(random, height, 14, 0.04)
  const trunkRadius = 0.035 + height * 0.009
  const orangeFrom = 0.45 + random() * 0.1
  wood.tube(
    trunk,
    trunk.map((_, i) => trunkRadius * (1 - (0.85 * i) / 14) * (i === 0 ? 1.25 : 1)),
    detail.trunkSides,
    (s, angle) => {
      const plates = 0.82 + 0.18 * Math.sin(angle * 4 + s * 31)
      return scaleRgb(
        mixRgb(P.bark, P.barkUpper, smooth01(orangeFrom - 0.08, orangeFrom + 0.1, s)),
        plates,
      )
    },
  )
  // Dead stubs where shaded lower limbs broke off.
  for (let stub = 0; stub < 4; stub++) {
    const y = between(random, height * 0.25, crownBase * 0.95)
    const from = along(trunk, (y + 0.15) / (height + 0.15)).p
    const path = limbPath(
      from,
      heading(random() * TAU, between(random, -0.3, 0.2)),
      between(random, 0.15, 0.35),
      1,
      0,
      0,
    )
    wood.tube(path, [0.022, 0.012], 3, () => P.barkDead)
  }
  const tuftCloud = (tip: Point, direction: Point, size: number) => {
    // A rounded, uneven clump of tufts round the tip, domed toward the light: a Scots pine's
    // crown is clumps, not flat plates.
    const tufts = Math.max(5, Math.round((21 * size) / detail.spacing))
    const yaw0 = Math.atan2(direction[0], direction[2])
    for (let tuft = 0; tuft < tufts; tuft++) {
      const angle = yaw0 + between(random, -1.6, 1.6)
      const out = size * Math.sqrt(random()) * 0.7
      // Higher near the clump's middle, drooping at its rim.
      const dome = 1 - (out / (size * 0.7)) ** 2
      const center: Point = [
        tip[0] + Math.sin(angle) * out,
        tip[1] + (between(random, -0.12, 0.1) + 0.22 * dome) * size,
        tip[2] + Math.cos(angle) * out,
      ]
      const width = size * between(random, 0.55, 0.8)
      const colour = random() < 0.2 ? P.needlesPale : P.needles
      const tile = random() < 0.5 ? ATLAS_TILES.pineA : ATLAS_TILES.pineB
      sprays.push(
        uprightCard(
          center,
          random() * TAU,
          between(random, 0, 0.5),
          width,
          width * 0.75,
          colour,
          tile,
        ),
      )
    }
    // A clump seen from below: one card tipped back toward the sky, smaller than the clump so
    // its straight edge never shows.
    sprays.push(
      uprightCard(
        add(tip, [0, 0.08 * size, 0]),
        yaw0,
        0.7,
        size * 0.6,
        size * 0.5,
        scaleRgb(P.needles, 0.8),
        ATLAS_TILES.pineA,
      ),
    )
  }
  const limbs = 10 + Math.floor(random() * 4)
  const phase = random() * TAU
  for (let limb = 0; limb < limbs; limb++) {
    const t = limb / (limbs - 1)
    const y = crownBase + (height * 0.93 - crownBase) * t
    const from = along(trunk, (y + 0.15) / (height + 0.15)).p
    const yaw = phase + limb * TAU * GOLDEN_TURN + between(random, -0.4, 0.4)
    const reach = height * (0.24 - 0.13 * t) * between(random, 0.8, 1.2)
    const elevation = ((15 + 30 * t) * Math.PI) / 180 + between(random, -0.15, 0.15)
    const path = limbPath(from, heading(yaw, elevation), reach, 3, 0.12, 0.08)
    const base = trunkRadius * (0.32 - 0.14 * t)
    wood.tube(
      path,
      path.map((_, i) => base * (1 - i / 3.6)),
      detail.limbSides,
      (s) => scaleRgb(P.barkUpper, 0.85 - 0.2 * s),
    )
    // Forks from the outer half, each ending in a cloud.
    const forks = 2 + Math.floor(random() * 2)
    for (let fork = 0; fork < forks; fork++) {
      const { p } = along(path, between(random, 0.5, 0.85))
      const forkYaw = yaw + between(random, -1.1, 1.1)
      const forkReach = reach * between(random, 0.35, 0.55)
      const twig = limbPath(
        p,
        heading(forkYaw, elevation + between(random, -0.2, 0.3)),
        forkReach,
        2,
        0.05,
        0.15,
      )
      wood.tube(twig, [base * 0.5, base * 0.35, base * 0.2], 3, () => scaleRgb(P.barkUpper, 0.7))
      tuftCloud(twig[twig.length - 1] ?? p, normalize(sub(twig[2] ?? p, p)), 0.55 + 0.4 * (1 - t))
    }
    tuftCloud(path[path.length - 1] ?? from, heading(yaw, 0), 0.65 + 0.35 * (1 - t))
  }
  // The crown's top.
  tuftCloud(trunk[trunk.length - 1] ?? [0, height, 0], [1, 0, 0], 0.7)
  return {
    wood: wood.build(crownBase * 0.5),
    sprays: shapeCrown(sprays, crownBase + (height - crownBase) * 0.55),
    height,
  }
}

/**
 * Weeping birch: a slender white trunk, dark and fissured at its foot, with black lenticel
 * bands; limbs rise steeply and arch over, and long twigs hang from them in curtains of small
 * leaves.
 */
export function growBirch(seed: number, detail: ModelDetail): TreeModel {
  const random = mulberry32(seed)
  const wood = new WoodBuilder(0.14, 1)
  const sprays: Spray[] = []
  const height = between(random, 5, 6.5)
  const trunk = trunkPath(random, height, 22, 0.07)
  const trunkRadius = 0.03 + height * 0.008
  const marks = Array.from({ length: 24 }, () => random())
  wood.tube(
    trunk,
    trunk.map((_, i) => trunkRadius * (1 - (0.9 * i) / 22) * (i === 0 ? 1.25 : 1)),
    detail.trunkSides,
    (s, angle) => {
      const ring = Math.floor(s * 24)
      // Broad tone variation and a dark foot; fine lenticels are shaded per fragment.
      const dash = (marks[ring] ?? 0) < 0.4 && Math.sin(angle * 2 + ring * 1.7) > 0.2
      const foot = 1 - smooth01(0.03, 0.12, s)
      const colour = scaleRgb(P.birchBark, dash ? 0.94 : 1)
      return mixRgb(colour, P.birchMark, foot * 0.85)
    },
  )
  const limbs = 13 + Math.floor(random() * 4)
  const phase = random() * TAU
  for (let limb = 0; limb < limbs; limb++) {
    const t = limb / (limbs - 1)
    const y = height * (0.36 + 0.54 * t)
    const from = along(trunk, (y + 0.15) / (height + 0.15)).p
    const yaw = phase + limb * TAU * GOLDEN_TURN + between(random, -0.3, 0.3)
    // Longest mid-crown, for an ovoid outline; rising, then arching over.
    const reach =
      height * (0.2 + 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.2))) * between(random, 0.8, 1.15)
    // Limbs rise steeply and only their outer part arches: an ovoid crown, not a willow's.
    const elevation = ((62 - 24 * t) * Math.PI) / 180
    const path = limbPath(from, heading(yaw, elevation), reach, 4, 0.42, -0.12)
    const base = trunkRadius * (0.35 - 0.15 * t)
    wood.branch(
      path,
      path.map((_, i) => base * (1 - i / 4.6)),
      detail.limbSides,
      () => mixRgb(P.birchBark, P.birchMark, 0.55),
    )
    // Curtains of hanging twigs along the limb's outer part and at its end.
    const twigs = Math.max(3, Math.round((reach * 16) / detail.spacing))
    for (let twig = 0; twig < twigs; twig++) {
      const s = 0.25 + (0.75 * (twig + 0.5)) / twigs
      const at = along(path, s)
      const tangent = at.tangent
      // Twigs spread off the limb on both sides, so curtains overlap into one crown.
      const off = between(random, -0.3, 0.3)
      const p = add(at.p, normalize(cross([0, 1, 0], tangent)), off)
      const size = between(random, 0.7, 0.98) * (1 - 0.2 * t)
      const colour = random() < 0.35 ? P.birchLeavesDeep : P.birchLeaves
      const tile = random() < 0.5 ? ATLAS_TILES.birchA : ATLAS_TILES.birchB
      // Twigs hang only partly: some cards hang from the limb, others turn every way.
      if (random() < 0.45) {
        const across = random() < 0.5 ? tangent : cross([0, 1, 0], tangent)
        sprays.push(
          hangingCard(
            p,
            across,
            size * 0.85,
            size * 0.85,
            between(random, -0.5, 0.5),
            colour,
            tile,
          ),
        )
      } else
        sprays.push(
          uprightCard(
            add(p, [0, -size * 0.15, 0]),
            random() * TAU,
            between(random, -0.4, 0.6),
            size * 0.85,
            size * 0.75,
            colour,
            tile,
          ),
        )
    }
  }
  // An inner crown of deeper leaves keeps the curtains from reading as separate clouds.
  for (let k = 0; k < 4; k++) {
    const y = height * between(random, 0.5, 0.88)
    sprays.push(
      uprightCard(
        along(trunk, (y + 0.15) / (height + 0.15)).p,
        random() * TAU,
        0,
        height * 0.2,
        height * 0.18,
        P.birchLeavesDeep,
        random() < 0.5 ? ATLAS_TILES.birchA : ATLAS_TILES.birchB,
      ),
    )
  }
  const top = trunk[trunk.length - 1] ?? [0, height, 0]
  return {
    wood: wood.build(0.4),
    sprays: shapeCrown(sprays, height * 0.68, [top[0] / height, 0, top[2] / height]),
    height,
  }
}

export type BroadleafHabit = 'oak' | 'beech'

/**
 * A temperate broadleaf in the open: a stout bole, scaffold limbs that rise and fork, and every
 * fork ending in a domed clump of leafy sprays, so the crown is a mass of rounded billows with
 * deep shade between them. An oak's crown is broad and lumpy, low on a short, dark, furrowed
 * bole; a beech's (or a lime's) taller and ovoid, on smooth grey bark with brighter leaves.
 */
export function growBroadleaf(
  seed: number,
  detail: ModelDetail,
  habit: BroadleafHabit,
  heights: readonly [number, number] = habit === 'oak' ? [6, 7.8] : [6.6, 8.4],
): TreeModel {
  const random = mulberry32(seed)
  const oak = habit === 'oak'
  const wood = new WoodBuilder(oak ? 1 : 0.22)
  const sprays: Spray[] = []
  const height = between(random, heights[0], heights[1])
  const youth = Math.min(1, height / 5)
  const crownBase = height * (oak ? between(random, 0.18, 0.28) : between(random, 0.24, 0.34))
  // Crown half-width: an oak's spreads about as wide as it is tall above its bole.
  const crownRadius = height * (oak ? between(random, 0.36, 0.42) : between(random, 0.27, 0.32))
  const crownCentre = crownBase + (height - crownBase) * (oak ? 0.5 : 0.48)
  const trunk = trunkPath(random, height * 0.92, 12, oak ? 0.06 : 0.03)
  const trunkRadius = (oak ? 0.06 : 0.045) + height * (oak ? 0.016 : 0.012)
  const bark = oak ? P.oakBark : P.beechBark
  wood.tube(
    trunk,
    trunk.map((_, i) => trunkRadius * (1 - (0.8 * i) / 12) * (i === 0 ? 1.55 : i === 1 ? 1.08 : 1)),
    youth > 0.5 ? detail.trunkSides : 5,
    (s, angle) =>
      oak
        ? scaleRgb(bark, (0.72 + 0.28 * Math.abs(Math.sin(angle * 5 + s * 9))) * (0.85 + 0.2 * s))
        : scaleRgb(bark, (0.92 + 0.08 * Math.sin(angle * 2 + s * 4)) * (0.8 + 0.25 * s)),
  )
  if (detail.spacing < 2 && height > 4) {
    // A separate stream preserves the crown's established scatter. Short healed stubs
    // leave a dark collar and a smaller exposed heartwood face below the live crown.
    const scars = mulberry32(seed ^ 0x48f17)
    for (let stub = 0; stub < (oak ? 2 : 1); stub++) {
      const from = along(trunk, 0.09 + ((scars() * crownBase) / height) * 0.65).p
      const direction = heading(scars() * TAU, 0.12 + scars() * 0.35)
      const radius = trunkRadius * (0.28 + scars() * 0.15)
      wood.tube(
        [
          from,
          add(from, direction, trunkRadius * 1.6),
          add(from, direction, trunkRadius * (2.4 + scars())),
        ],
        [radius * 1.6, radius, radius * 0.62],
        detail.trunkSides,
        () => scaleRgb(bark, 0.72),
        [0.22, 0.15, 0.082],
      )
    }
  }
  const leaves = oak ? [P.oakLeaves, P.oakLeavesDeep] : [P.beechLeaves, P.beechLeavesDeep]
  const tiles = oak ? [ATLAS_TILES.oakA, ATLAS_TILES.oakB] : [ATLAS_TILES.limeA, ATLAS_TILES.limeB]
  /** A domed clump of sprays round `centre`, fuller toward the light and the crown's outside. */
  const clump = (centre: Point, radius: number, outward: Point) => {
    // Alpha-tested cards cost fill, not triangles: fewer, slightly smaller cards keep a clump
    // closed at about two thirds of the overdraw.
    const cards = Math.max(5, Math.round((17 * radius * radius) / detail.spacing))
    for (let card = 0; card < cards; card++) {
      // Points on the clump's outer shell, mostly on its upper and outward side.
      const yaw = random() * TAU
      const elevation = Math.asin(between(random, -0.45, 1))
      let direction = heading(yaw, elevation)
      direction = normalize(add(direction, outward, 0.45))
      const out = radius * between(random, 0.45, 1)
      const p = add(centre, direction, out)
      const size = radius * between(random, 0.7, 0.95) * (oak ? 1 : 1.08)
      // Each clump shades as one billow: its sunlit top keeps the fresh leaves, its underside
      // and inside the deeper ones, rather than a random patchwork of tones.
      const top = smooth01(-0.35, 0.55, direction[1])
      const colour = mixRgb(
        leaves[1] ?? P.oakLeavesDeep,
        leaves[0] ?? P.oakLeaves,
        clamp(top * 0.8 + between(random, 0, 0.25), 0, 1),
      )
      const inner = 0.72 + 0.28 * smooth01(0.45, 0.95, out / radius)
      sprays.push({
        ...uprightCard(
          p,
          Math.atan2(direction[0], direction[2]) + between(random, -0.7, 0.7),
          // Tipped back a little at most: cards facing the sky light up as a pale lid.
          between(random, -0.15, 0.45),
          size,
          size * 0.9,
          colour,
          tiles[random() < 0.5 ? 0 : 1] ?? ATLAS_TILES.oakA,
        ),
        shade: inner * (0.82 + 0.18 * top),
      })
    }
  }
  const limbs = (oak ? 7 : 6) + Math.floor(random() * 3)
  const phase = random() * TAU
  for (let limb = 0; limb < limbs; limb++) {
    const t = limb / (limbs - 1)
    const y = crownBase + (crownCentre - crownBase) * 1.1 * t
    const from = along(trunk, (y + 0.15) / (height * 0.92 + 0.15)).p
    const yaw = phase + limb * TAU * GOLDEN_TURN + between(random, -0.3, 0.3)
    // Low limbs spread wide; higher ones rise steeply toward the crown's top.
    const elevation = (((oak ? 28 : 40) + (oak ? 34 : 30) * t) * Math.PI) / 180
    const reach =
      crownRadius * (oak ? 1.05 - 0.35 * t : 0.95 - 0.3 * t) * between(random, 0.85, 1.1)
    const path = limbPath(from, heading(yaw, elevation), reach, 4, oak ? 0.18 : 0.08, 0.12)
    const base = trunkRadius * (0.48 - 0.18 * t)
    // Past 50 m the crown hides all but the lowest limbs: a far tree keeps only those in wood.
    if (detail.spacing < 2 || t < 0.4)
      wood.branch(
        path,
        path.map((_, i) => base * (1 - i / 4.8)),
        detail.limbSides,
        (s) => scaleRgb(bark, 0.85 - 0.15 * s),
      )
    // A clump part way along the limb fills the crown's inside, then two or three forks from
    // the outer half, each ending in a clump, and one at the limb's end.
    const middle = along(path, between(random, 0.45, 0.6)).p
    clump(
      middle,
      crownRadius * between(random, 0.28, 0.36),
      normalize(sub(middle, [0, crownCentre, 0])),
    )
    const forks = 2 + Math.floor(random() * 2)
    for (let fork = 0; fork < forks; fork++) {
      const { p } = along(path, between(random, 0.45, 0.85))
      const forkYaw = yaw + between(random, -1, 1)
      const forkReach = reach * between(random, 0.35, 0.55)
      const twig = limbPath(
        p,
        heading(forkYaw, elevation + between(random, -0.1, 0.35)),
        forkReach,
        2,
        0.05,
        0.1,
      )
      // Forks carry no wood: their clump hides them, and they cost a fifth of the forest's wood.
      const end = twig[twig.length - 1] ?? p
      clump(
        end,
        crownRadius * between(random, 0.32, 0.42),
        normalize(sub(end, [0, crownCentre, 0])),
      )
    }
    const end = path[path.length - 1] ?? from
    clump(end, crownRadius * between(random, 0.38, 0.48), normalize(sub(end, [0, crownCentre, 0])))
  }
  // The leader's top and a few billows filling the crown's upper middle.
  const top = trunk[trunk.length - 1] ?? [0, height, 0]
  clump(add(top, [0, height * 0.02, 0]), crownRadius * 0.5, [0, 1, 0])
  for (let k = 0; k < 3; k++) {
    const yaw = random() * TAU
    const centre: Point = [
      top[0] + Math.sin(yaw) * crownRadius * 0.45,
      crownCentre + (height - crownCentre) * between(random, 0.35, 0.7),
      top[2] + Math.cos(yaw) * crownRadius * 0.45,
    ]
    clump(centre, crownRadius * 0.4, normalize(sub(centre, [0, crownCentre, 0])))
  }
  // Inner cores: the crown shows shaded leaves, not sky, through its gaps.
  for (let k = 0; k < 3; k++) {
    const y = crownCentre + (height - crownCentre) * between(random, -0.5, 0.4)
    sprays.push({
      ...uprightCard(
        along(trunk, clamp((y + 0.15) / (height * 0.92 + 0.15), 0, 1)).p,
        random() * TAU,
        0,
        crownRadius * 0.75,
        crownRadius * 0.6,
        leaves[1] ?? P.oakLeavesDeep,
        ATLAS_TILES.disc,
      ),
      shade: 0.8,
    })
  }
  // Clumps reach past the nominal height: report the crown's true top.
  const crownTop = Math.max(height, ...sprays.map((spray) => spray.center[1] + spray.height * 0.45))
  return {
    wood: wood.build(crownBase * 0.6),
    sprays: shapeCrown(sprays, crownCentre),
    height: crownTop,
  }
}

/**
 * Common juniper: a dark, blue-green column a metre or so tall, as it grows on dry, rocky
 * shore ground, made of two or three irregular stems of upright needle sprays.
 */
export function growJuniper(seed: number, detail: ModelDetail): TreeModel {
  const random = mulberry32(seed)
  const wood = new WoodBuilder()
  const sprays: Spray[] = []
  const height = between(random, 0.7, 1.3)
  const stems = 2 + Math.floor(random() * 2)
  for (let stem = 0; stem < stems; stem++) {
    const angle = random() * TAU
    const offset = between(random, 0.05, 0.16)
    const stemHeight = height * between(random, 0.7, 1)
    const radius = height * between(random, 0.16, 0.22)
    const cards = Math.max(6, Math.round(18 / detail.spacing))
    for (let card = 0; card < cards; card++) {
      const t = (card + random()) / cards
      // Widest a third of the way up, rounded at the top.
      const r = radius * Math.sin(Math.PI * Math.min(1, 0.25 + t * 0.85)) * between(random, 0.5, 1)
      const around = random() * TAU
      const size = height * between(random, 0.3, 0.42) * (1 - 0.4 * t)
      sprays.push(
        uprightCard(
          [
            Math.sin(angle) * offset + Math.sin(around) * r,
            stemHeight * t * 0.92 + size * 0.3,
            Math.cos(angle) * offset + Math.cos(around) * r,
          ],
          around + between(random, -0.5, 0.5),
          between(random, 0, 0.35),
          size,
          size * 1.1,
          random() < 0.3 ? P.juniperPale : P.juniper,
          random() < 0.5 ? ATLAS_TILES.pineA : ATLAS_TILES.pineB,
        ),
      )
    }
  }
  return { wood: wood.build(0), sprays: shapeCrown(sprays, height * 0.4), height }
}

/** A low shrub (bilberry, young growth): a dome of leafy cards round a few short stems. */
export function growBush(seed: number, detail: ModelDetail): TreeModel {
  const random = mulberry32(seed)
  const wood = new WoodBuilder()
  const sprays: Spray[] = []
  // Hazel and hawthorn at a wood's edge: leafy domes up to a metre or so across.
  const radius = between(random, 0.38, 0.6)
  const cards = Math.round(11 / detail.spacing)
  for (let card = 0; card < cards; card++) {
    const angle = (card / cards) * TAU + between(random, -0.3, 0.3)
    const out = radius * between(random, 0.15, 0.6)
    const size = radius * between(random, 1.1, 1.5)
    sprays.push(
      uprightCard(
        [Math.sin(angle) * out, size * 0.36, Math.cos(angle) * out],
        angle + between(random, -0.6, 0.6),
        between(random, 0, 0.4),
        size,
        size * 0.75,
        card < cards / 3 ? P.shrubDeep : P.shrub,
        card % 3 === 2 ? ATLAS_TILES.limeA : ATLAS_TILES.bush,
      ),
    )
  }
  return { wood: wood.build(0), sprays: shapeCrown(sprays, radius * 0.25), height: radius * 0.8 }
}

/**
 * A crown as a stack of spheres in model space (x, y, z, radius per sphere), for picking: one per
 * 0.8 m band of the sprays, centred on the band's spray centroid and reaching its farthest card.
 */
export function crownSpheres(model: TreeModel): Float32Array {
  const bands = new Map<number, { x: number; z: number; y: number; n: number; reach: number }>()
  for (const spray of model.sprays) {
    const key = Math.floor(spray.center[1] / 0.8)
    const band = bands.get(key) ?? { x: 0, z: 0, y: 0, n: 0, reach: 0 }
    band.x += spray.center[0]
    band.z += spray.center[2]
    band.y += spray.center[1]
    band.n++
    bands.set(key, band)
  }
  const spheres: number[] = []
  for (const [key, band] of [...bands].toSorted((a, b) => a[0] - b[0])) {
    const cx = band.x / band.n,
      cz = band.z / band.n
    let reach = 0
    for (const spray of model.sprays) {
      if (Math.floor(spray.center[1] / 0.8) !== key) continue
      reach = Math.max(
        reach,
        Math.hypot(spray.center[0] - cx, spray.center[2] - cz) +
          Math.max(spray.width, spray.height) * 0.4,
      )
    }
    // Most of a band's cards lie well inside its farthest one: pick a little inside it.
    spheres.push(cx, (key + 0.5) * 0.8, cz, Math.max(0.25, reach * 0.85))
  }
  return Float32Array.from(spheres)
}

/**
 * World-space vegetation geometry. After Voxen (ADR 0107, 0112, 0114), only wood stays voxels:
 * foliage masks become clumps of atlas cards, and undergrowth is procedural geometry (Bézier
 * grass ribbons, leaflet-cut fern fronds, small flowers). Everything is baked once in the world
 * worker and merged per material, so the whole forest costs three draws.
 */
import { ATLAS_TILES, atlasRect } from './foliage-atlas'
import type { AtlasTile } from './foliage-atlas'
import { mixRgb } from './vegetation-models'
import type { FoliageSeed, Point, Rgb, VegetationGeometry } from './vegetation-models'

export type MeshData = Readonly<{
  positions: Float32Array
  normals: Int8Array
  colors: Float32Array
  /** Atlas coordinates; empty for untextured geometry. */
  uvs: Float32Array
  /** Per vertex: bend (metres of tip travel at full wind), phase, flutter (metres), ω (rad/s). */
  wind: Float32Array
  indices: Uint32Array
}>

/** Placement of a model: rotation about Y, uniform scale, then translation. */
export type Placement = Readonly<{ x: number; y: number; z: number; yaw: number; scale: number }>
export type Sway = Readonly<{ phase: number; omega: number }>

const UP: Point = [0, 1, 0]
const normalize = (v: Point): Point => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const add = (a: Point, b: Point, k = 1): Point => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
]
const rotateY = (v: Point, yaw: number): Point => {
  const c = Math.cos(yaw),
    s = Math.sin(yaw)
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]
}
const place = (p: Point, at: Placement): Point => {
  const r = rotateY(p, at.yaw)
  return [at.x + r[0] * at.scale, at.y + r[1] * at.scale, at.z + r[2] * at.scale]
}
function hash(a: number, b: number, stream: number) {
  let n = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ stream) >>> 0
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d)
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b)
  return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000
}

export class MeshBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly colors: number[] = []
  private readonly uvs: number[] = []
  private readonly wind: number[] = []
  private readonly indices: number[] = []
  private readonly textured: boolean
  constructor(textured: boolean) {
    this.textured = textured
  }
  get vertexCount() {
    return this.positions.length / 3
  }
  vertex(
    p: Point,
    n: Point,
    colour: Rgb,
    wind: readonly [number, number, number, number],
    uv: readonly [number, number] = [0, 0],
  ) {
    this.positions.push(p[0], p[1], p[2])
    const m = normalize(n)
    this.normals.push(Math.round(m[0] * 127), Math.round(m[1] * 127), Math.round(m[2] * 127))
    this.colors.push(colour[0], colour[1], colour[2])
    if (this.textured) this.uvs.push(uv[0], uv[1])
    this.wind.push(wind[0], wind[1], wind[2], wind[3])
    return this.vertexCount - 1
  }
  triangle(a: number, b: number, c: number) {
    this.indices.push(a, b, c)
  }
  quad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, c, a, c, d)
  }
  /** Append a meshed voxel model at a placement; its bend scales to `swayMetres`. */
  appendVoxels(geometry: VegetationGeometry, at: Placement, sway: Sway, swayMetres: number) {
    const base = this.vertexCount
    const { positions, normals, colors, bend, indices } = geometry
    for (let i = 0; i < bend.length; i++) {
      const p: Point = [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0]
      const n: Point = [normals[i * 3] ?? 0, normals[i * 3 + 1] ?? 0, normals[i * 3 + 2] ?? 0]
      this.vertex(
        place(p, at),
        rotateY(n, at.yaw),
        [colors[i * 3] ?? 0, colors[i * 3 + 1] ?? 0, colors[i * 3 + 2] ?? 0],
        [(bend[i] ?? 0) * swayMetres, sway.phase, 0, sway.omega],
      )
    }
    for (const index of indices) this.indices.push(base + index)
  }
  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Int8Array(this.normals),
      colors: new Float32Array(this.colors),
      uvs: new Float32Array(this.uvs),
      wind: new Float32Array(this.wind),
      indices: new Uint32Array(this.indices),
    }
  }
}

/** A textured card centred at `centre` in the plane of `t` (width) and `b` (height). */
function card(
  builder: MeshBuilder,
  centre: Point,
  t: Point,
  b: Point,
  width: number,
  height: number,
  normal: Point,
  colour: Rgb,
  tile: AtlasTile,
  wind: (corner: Point) => readonly [number, number, number, number],
) {
  const [u0, v0, u1, v1] = atlasRect(tile)
  const corners: [number, number, number, number][] = [
    [-0.5, -0.5, u0, v0],
    [0.5, -0.5, u1, v0],
    [0.5, 0.5, u1, v1],
    [-0.5, 0.5, u0, v1],
  ]
  const ids = corners.map(([x, y, u, v]) => {
    const p = add(add(centre, t, x * width), b, y * height)
    return builder.vertex(p, normal, colour, wind(p), [u, v])
  })
  builder.quad(ids[0] ?? 0, ids[1] ?? 0, ids[2] ?? 0, ids[3] ?? 0)
}

export type ClumpOptions = Readonly<{
  /** Camera position the first card of each clump loosely faces. */
  camera: Point
  /** Clump pitch in model metres. */
  pitch: number
  /** Minimum card edge in model metres. */
  length: number
  /** Per-prop size factor in [0.85, 1.2] and hue/value jitter. */
  propFactor: number
  propTint: Rgb
  modelHeight: number
  sway: Sway
  /** Tip travel at full wind, metres, for a vertex at the model top. */
  swayMetres: number
  salt: number
}>

/**
 * Last Signal's clumps (host README, "Internal prop foliage"): three to five atlas cards per seed
 * facing its open direction, the first loosely toward the camera; an opaque core disc behind
 * clumps with openness under 0.6; cluster scales in [0.85, 1.45], isolated tufts at 0.6, far
 * clumps up to 1.25× from 15 to 55 m; normals blended 90% toward the open direction; albedo
 * with a cluster value hash, a cool-underside to warm-top ramp and an openness/height shade.
 */
export function appendClumps(
  builder: MeshBuilder,
  seeds: readonly FoliageSeed[],
  at: Placement,
  options: ClumpOptions,
) {
  seeds.forEach((seed, index) => {
    const random = (stream: number) => hash(index, options.salt, stream)
    const centre = place(seed.center, at)
    const open = normalize(rotateY(seed.open, at.yaw))
    const toCamera = normalize(add(options.camera, centre, -1))
    const distance = Math.hypot(
      options.camera[0] - centre[0],
      options.camera[1] - centre[1],
      options.camera[2] - centre[2],
    )
    const far = 1 + 0.25 * Math.max(0, Math.min(1, (distance - 15) / 40))
    const isolated = seed.openness > 0.8 ? 0.6 : 1
    // Cards on a crown's underside stay small and do not drop below it, so trunks stay visible.
    const under = Math.max(0, -open[1])
    // Clumps opening straight up (a spire's tip, a crown's top) stay on the crown instead of
    // being pushed above it, and lose some of their top light, or they read as a pale lid
    // hovering over the tree.
    const lid = Math.max(0, open[1] - 0.6) / 0.4
    const outward: Point = [open[0], Math.max(open[1], -0.1) * (1 - lid), open[2]]
    const edge =
      Math.max(options.length, 2 * options.pitch) *
      at.scale *
      (0.85 + seed.cluster * 0.6) *
      options.propFactor *
      isolated *
      far *
      (1 - 0.4 * under)
    const ramp = mixRgb([0.88, 0.96, 1.04], [1.06, 1.02, 0.9], open[1] * 0.5 + 0.5)
    const value =
      (0.88 + seed.cluster * 0.24) *
      (0.62 + 0.38 * seed.openness) *
      (0.8 + 0.2 * seed.height) *
      (1 - 0.2 * lid)
    const colour: Rgb = [
      seed.colour[0] * ramp[0] * options.propTint[0] * value,
      seed.colour[1] * ramp[1] * options.propTint[1] * value,
      seed.colour[2] * ramp[2] * options.propTint[2] * value,
    ]
    const bendAt = (p: Point) => {
      const lift = Math.max(0, Math.min(1, (p[1] - at.y) / (options.modelHeight * at.scale)))
      return lift * lift * options.swayMetres
    }
    const flutter = edge * 0.035
    const wind = (p: Point) =>
      [bendAt(p), options.sway.phase + random(9) * 2, flutter, options.sway.omega] as const
    if (seed.openness < 0.6) {
      const t = normalize(cross(UP, toCamera))
      const b = cross(toCamera, t)
      card(
        builder,
        add(centre, toCamera, -options.pitch * at.scale * 0.4),
        t,
        b,
        edge * 0.62,
        edge * 0.62,
        open,
        [colour[0] * 0.5, colour[1] * 0.5, colour[2] * 0.5],
        ATLAS_TILES.disc,
        (p) => [bendAt(p), options.sway.phase, 0, options.sway.omega],
      )
    }
    const cards = 3 + Math.floor(random(1) * 3)
    for (let c = 0; c < cards; c++) {
      let facing: Point
      if (c === 0) facing = normalize(add(open, toCamera))
      else {
        const turn = (c % 2 === 0 ? 1 : -1) * (0.55 + random(10 + c) * 0.7)
        const sideways = rotateY(open, turn)
        facing = normalize([sideways[0], sideways[1] + 0.2 + random(20 + c) * 0.3, sideways[2]])
      }
      // Keep cards near vertical: a low camera sees flat cards on a crown's top edge-on, as
      // pale slivers floating over a gap instead of foliage.
      facing = uprightCard(facing, toCamera)
      let t = cross(UP, facing)
      if (Math.hypot(t[0], t[1], t[2]) < 1e-3) t = [1, 0, 0]
      t = normalize(t)
      let b = cross(facing, t)
      // Sprays tip upward toward their outer end; leaf clusters hang.
      const roll = seed.leaf ? (random(30 + c) - 0.5) * 0.4 : 0.15 + random(30 + c) * 0.25
      const cr = Math.cos(roll),
        sr = Math.sin(roll)
      const t2: Point = add([t[0] * cr, t[1] * cr, t[2] * cr], b, sr)
      b = add([b[0] * cr, b[1] * cr, b[2] * cr], t, -sr)
      t = t2
      const width = edge
      const height = seed.leaf ? edge * 0.85 : edge * 0.6
      const offset = add(
        add(centre, outward, options.pitch * at.scale * 0.35),
        [random(40 + c) - 0.5, random(50 + c) - 0.5, random(60 + c) - 0.5],
        options.pitch * at.scale * 0.5,
      )
      const centreOfCard = seed.leaf ? add(offset, UP, -height * 0.15) : offset
      const tile = seed.leaf
        ? random(70 + c) < 0.5
          ? ATLAS_TILES.leafA
          : ATLAS_TILES.leafB
        : random(70 + c) < 0.5
          ? ATLAS_TILES.needleA
          : ATLAS_TILES.needleB
      // Normals lean toward the open direction, with its upward part damped: crown tops lit
      // straight from above read as a pale lid over the crown.
      const normal = normalize(
        add([open[0] * 0.9, open[1] * (open[1] > 0 ? 0.55 : 0.9), open[2] * 0.9], facing, 0.25),
      )
      card(builder, centreOfCard, t, b, width, height, normal, colour, tile, wind)
    }
  })
}

/** Limits a card's tilt to about 30° from vertical, turning flat-facing cards toward the camera. */
function uprightCard(facing: Point, toCamera: Point): Point {
  const flat = Math.hypot(facing[0], facing[2])
  const lift = Math.max(-0.5, Math.min(0.5, facing[1]))
  const horizontal: Point =
    flat > 0.35
      ? [facing[0] / flat, 0, facing[2] / flat]
      : normalize([toCamera[0] + facing[0], 0, toCamera[2] + facing[2]])
  return normalize([horizontal[0], lift, horizontal[2]])
}

/** Tuft palette after Last Signal's `[[grass]]` rows (forest.toml). */
export type GrassColours = Readonly<{ root: Rgb; tip: Rgb }>

/** Blades sway at most about 1.3 Hz, the buffet's fastest sine then near 2 Hz. */
const MAX_BLADE_OMEGA = 2 * Math.PI * 1.3

/** Row positions along a blade and their width share (ADR 0107). */
const BLADE_ROWS = [
  [0, 0.55],
  [0.33, 1],
  [0.66, 0.5],
  [0.9, 0.12],
] as const
const SHORT_BLADE_ROWS = [
  [0, 0.7],
  [0.5, 0.6],
] as const

/**
 * A sparse fan of pointed, arching ribbons (ADR 0107): each blade is a quadratic Bézier with
 * four rows of widths 0.55, 1, 0.5 and 0.12 and a pointed tip, tinted from the ground to a
 * drier tip. Normals lean toward the sky so blades read lit from both sides.
 */
export function appendTuft(
  builder: MeshBuilder,
  root: Point,
  options: Readonly<{
    blades: number
    height: number
    width: number
    colours: GrassColours
    salt: number
    phase: number
    /** `short`: ground-cover blades of two rows and a tip, three triangles each. */
    profile?: 'full' | 'short'
    /** Unit XZ direction toward a nearby step edge or wall: blades turn away from it and lean less. */
    edge?: readonly [number, number]
  }>,
) {
  const rows = options.profile === 'short' ? SHORT_BLADE_ROWS : BLADE_ROWS
  // 1.2/√H Hz, capped: a short blade's true rate (4 Hz at 10 cm) reads as trembling on screen.
  const omega = Math.min(
    (2 * Math.PI * 1.2) / Math.sqrt(Math.max(options.height, 0.05)),
    MAX_BLADE_OMEGA,
  )
  for (let blade = 0; blade < options.blades; blade++) {
    const r = (stream: number) => hash(blade, options.salt, stream)
    const angle = r(1) * Math.PI * 2
    const spread = r(2) * 0.04
    const h = options.height * (0.55 + r(3) * 0.45)
    let dir: Point = [Math.sin(angle), 0, Math.cos(angle)]
    const edge = options.edge
    // Mirror blades heading toward an edge so none hangs over a drop or into a wall.
    const toward = edge ? dir[0] * edge[0] + dir[2] * edge[1] : 0
    if (edge && toward > 0) dir = [dir[0] - 2 * toward * edge[0], 0, dir[2] - 2 * toward * edge[1]]
    const lean = (0.25 + r(4) * 0.55) * (edge ? 0.6 : 1)
    const side: Point = [Math.cos(angle + r(5) * 0.6), 0, -Math.sin(angle + r(5) * 0.6)]
    const p0 = add(root, dir, spread)
    const p1 = add(add(p0, UP, h * 0.55), dir, lean * h * 0.25)
    const p2 = add(add(p0, UP, h * (1 - 0.3 * lean * lean)), dir, lean * h)
    const at = (t: number): Point => {
      const a = (1 - t) * (1 - t),
        b = 2 * (1 - t) * t,
        c = t * t
      return [
        p0[0] * a + p1[0] * b + p2[0] * c,
        p0[1] * a + p1[1] * b + p2[1] * c,
        p0[2] * a + p1[2] * b + p2[2] * c,
      ]
    }
    const tangentAt = (t: number) =>
      normalize([
        2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]),
        2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]),
        2 * (1 - t) * (p1[2] - p0[2]) + 2 * t * (p2[2] - p1[2]),
      ])
    const ids: number[] = []
    for (const [t, w] of rows) {
      const p = at(t)
      let n = cross(side, tangentAt(t))
      if (n[1] < 0) n = [-n[0], -n[1], -n[2]]
      n = normalize(add(n, UP, 0.45))
      const colour = mixRgb(options.colours.root, options.colours.tip, Math.pow(t, 0.9))
      const wind = [t * t * h * 0.45, options.phase + r(6), t * 0.01, omega] as const
      const half = (options.width * w) / 2
      ids.push(
        builder.vertex(add(p, side, -half), n, colour, wind),
        builder.vertex(add(p, side, half), n, colour, wind),
      )
    }
    for (let row = 0; row < rows.length - 1; row++)
      builder.quad(
        ids[row * 2] ?? 0,
        ids[row * 2 + 1] ?? 0,
        ids[row * 2 + 3] ?? 0,
        ids[row * 2 + 2] ?? 0,
      )
    const tip = builder.vertex(p2, add(UP, dir, 0.3), options.colours.tip, [
      h * 0.45,
      options.phase + r(6),
      0.01,
      omega,
    ])
    const last = (rows.length - 1) * 2
    builder.triangle(ids[last] ?? 0, ids[last + 1] ?? 0, tip)
  }
}

/**
 * A fern crown (ADR 0112): a ring of tapered rachis strips that arch and droop, cut into
 * alternating leaflets that shorten toward the tip.
 */
export function appendFern(
  builder: MeshBuilder,
  root: Point,
  options: Readonly<{
    fronds: number
    length: number
    colour: Rgb
    tip: Rgb
    salt: number
    phase: number
  }>,
) {
  const omega = 2 * Math.PI * 1.1
  for (let frond = 0; frond < options.fronds; frond++) {
    const r = (stream: number) => hash(frond, options.salt, stream)
    const heading = (frond / options.fronds) * Math.PI * 2 + (r(1) - 0.5) * 0.5
    const length = options.length * (0.75 + r(2) * 0.3)
    const dir: Point = [Math.sin(heading), 0, Math.cos(heading)]
    const side: Point = [Math.cos(heading), 0, -Math.sin(heading)]
    const at = (s: number): Point =>
      add(
        add(root, dir, length * s),
        UP,
        0.03 + length * (0.5 * Math.sin(Math.PI * s * 0.85) - 0.18 * s),
      )
    const steps = 10
    const ids: number[] = []
    for (let i = 0; i <= steps; i++) {
      const s = i / steps
      const p = at(s)
      const width = 0.012 * (1 - s * 0.8)
      const colour = mixRgb(options.colour, options.tip, s)
      const wind = [s * s * length * 0.3, options.phase + r(3), 0.006 * s, omega] as const
      ids.push(
        builder.vertex(add(p, side, -width / 2), UP, colour, wind),
        builder.vertex(add(p, side, width / 2), UP, colour, wind),
      )
    }
    for (let i = 0; i < steps; i++)
      builder.quad(ids[i * 2] ?? 0, ids[i * 2 + 1] ?? 0, ids[i * 2 + 3] ?? 0, ids[i * 2 + 2] ?? 0)
    for (let k = 0; k < 11; k++) {
      const s = 0.12 + k * 0.078
      const p = at(s)
      const leaflet = (0.24 * (1 - s) + 0.06) * length * 0.42
      const colour = mixRgb(options.colour, options.tip, s * 0.8)
      const wind = [s * s * length * 0.3, options.phase + r(3), 0.008 + 0.01 * s, omega] as const
      for (const sign of [-1, 1]) {
        const out = normalize([side[0] * sign + dir[0] * 0.5, -0.35, side[2] * sign + dir[2] * 0.5])
        const a = builder.vertex(add(p, dir, -0.011), UP, colour, wind)
        const b = builder.vertex(add(p, dir, 0.011), UP, colour, wind)
        const c = builder.vertex(add(p, out, leaflet), UP, colour, [
          wind[0],
          wind[1],
          wind[2] * 1.5,
          wind[3],
        ])
        builder.triangle(a, b, c)
      }
    }
  }
}

/** A small flower: a thin stem and five cupped petals around a warm heart. */
export function appendFlower(
  builder: MeshBuilder,
  root: Point,
  options: Readonly<{
    height: number
    petal: Rgb
    heart: Rgb
    stem: Rgb
    salt: number
    phase: number
  }>,
) {
  const omega = 2 * Math.PI * 1.6
  const r = (stream: number) => hash(1, options.salt, stream)
  const lean: Point = [(r(1) - 0.5) * 0.04, 0, (r(2) - 0.5) * 0.04]
  const top = add(add(root, UP, options.height), lean)
  const side: Point = [1, 0, 0]
  const windAt = (y: number) =>
    [
      ((y - root[1]) / options.height) ** 2 * options.height * 0.4,
      options.phase,
      0.004,
      omega,
    ] as const
  const s0 = builder.vertex(add(root, side, -0.003), [0, 0, 1], options.stem, windAt(root[1]))
  const s1 = builder.vertex(add(root, side, 0.003), [0, 0, 1], options.stem, windAt(root[1]))
  const s2 = builder.vertex(add(top, side, 0.002), [0, 0, 1], options.stem, windAt(top[1]))
  const s3 = builder.vertex(add(top, side, -0.002), [0, 0, 1], options.stem, windAt(top[1]))
  builder.quad(s0, s1, s2, s3)
  const wind = windAt(top[1])
  for (let petal = 0; petal < 5; petal++) {
    const angle = (petal / 5) * Math.PI * 2 + r(3)
    const out: Point = [Math.sin(angle), 0.35, Math.cos(angle)]
    const across: Point = [Math.cos(angle), 0, -Math.sin(angle)]
    const a = builder.vertex(add(top, across, -0.006), UP, options.petal, wind)
    const b = builder.vertex(add(top, across, 0.006), UP, options.petal, wind)
    const c = builder.vertex(add(add(top, out, 0.024), across, 0.008), UP, options.petal, wind)
    const d = builder.vertex(add(add(top, out, 0.024), across, -0.008), UP, options.petal, wind)
    builder.quad(a, b, c, d)
  }
  const h0 = builder.vertex(add(add(top, UP, 0.004), [-0.006, 0, -0.006]), UP, options.heart, wind)
  const h1 = builder.vertex(add(add(top, UP, 0.004), [0.006, 0, -0.006]), UP, options.heart, wind)
  const h2 = builder.vertex(add(add(top, UP, 0.004), [0.006, 0, 0.006]), UP, options.heart, wind)
  const h3 = builder.vertex(add(add(top, UP, 0.004), [-0.006, 0, 0.006]), UP, options.heart, wind)
  builder.quad(h0, h1, h2, h3)
}

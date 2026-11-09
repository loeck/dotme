import { latticeHash } from './hash'
/**
 * A Nordic lake-shore sward as clumps, after Ghost of Tsushima's procedural grass (Wohllaib,
 * GDC 2021): a clump, not a blade, sets height, facing, lean, colour and dryness, so the bank
 * reads as tufts rather than combed hair. Each clump is one of the shore's growth forms:
 *
 * - short turf (bents, fescues kept low): a dense layer of fine leaves closing the ground;
 * - wiry tufts (wavy hair-grass, sheep's fescue): many needle-thin rolled leaves in a fountain;
 * - flat-leaved tussocks (purple moor-grass, sedges): fewer, wider blades that arch, twist and
 *   droop at the tip;
 * - rushes: round, upright, dark stems;
 * - seed stalks over some tufts: a bare culm with a narrow, purplish-brown panicle.
 *
 * Every clump carries dead material, mostly low and bent: straw blades, and litter lying almost
 * flat at its base (often a third of what one sees in a real sward). Albedos follow field
 * measurements (green leaves about 0.05 in visible light; Majasalmi & Bright 2019): blades
 * darken toward the root with h^1.5 (the shade of their neighbours, as AMD's mesh-shader grass)
 * and do not brighten at the tip. Normals round across each blade (±0.12π, as open Tsushima
 * reimplementations) and blend half way toward up, so a blade shades as a curved strip.
 */
import type { MeshBuilder } from './vegetation-meshes'
import type { Point, Rgb } from './vegetation-models'

export type GrassForm = 'turf' | 'wiry' | 'flat' | 'rush'

export type Clump = Readonly<{
  /** Root centre; blades root within `radius` of it, at `ground(x, z)`. */
  x: number
  z: number
  radius: number
  form: GrassForm
  /** Typical blade height, metres; each blade takes 80% of it from the clump. */
  height: number
  /** 0..1: the share of dead and straw blades, and how pale the living ones are. */
  dryness: number
  /** Value multiplier of the clump's living blades. */
  value: number
  /** Whether a few seed stalks stand above it. */
  seeds: boolean
  /** Unit XZ direction toward a nearby step edge or wall, if any: blades turn away from it. */
  edge?: readonly [number, number]
  salt: number
  phase: number
}>

/**
 * Linear albedos of a summer meadow sward: fresh, yellow-green leaves (cocksfoot, meadow
 * foxtail, ryegrass) near 0.06–0.08 green, straw near 0.2, litter grey-brown.
 */
const GRASS = {
  root: [0.016, 0.028, 0.008],
  wiry: [0.06, 0.105, 0.022],
  wiryTip: [0.1, 0.155, 0.032],
  flat: [0.05, 0.1, 0.024],
  flatTip: [0.085, 0.145, 0.03],
  rush: [0.03, 0.06, 0.02],
  straw: [0.22, 0.185, 0.1],
  strawTip: [0.27, 0.23, 0.13],
  litter: [0.12, 0.1, 0.07],
  panicle: [0.13, 0.095, 0.085],
  panicleSilver: [0.2, 0.19, 0.16],
} as const satisfies Record<string, Rgb>

const MAX_OMEGA = 8
const ROUND = 0.12 * Math.PI

const add = (a: Point, b: Point, k = 1): Point => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
]
const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k, a[2] * k]
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (v: Point): Point => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
const scaleRgb = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]
/** Rotate `v` about the unit axis `k` by `angle` (Rodrigues). */
const rotate = (v: Point, k: Point, angle: number): Point => {
  const c = Math.cos(angle),
    s = Math.sin(angle)
  const d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2]
  const kv = cross(k, v)
  return [
    v[0] * c + kv[0] * s + k[0] * d * (1 - c),
    v[1] * c + kv[1] * s + k[1] * d * (1 - c),
    v[2] * c + kv[2] * s + k[2] * d * (1 - c),
  ]
}

/** The shared lattice hash without a seed: placements carry their own streams. */
const hash = (a: number, b: number, stream: number) => latticeHash(0, a, b, stream)

type Blade = Readonly<{
  root: Point
  /** Unit XZ heading the blade leans toward. */
  heading: Point
  height: number
  width: number
  /** 0 upright .. 1 lying along the ground. */
  lean: number
  /** How far the tip falls back below its highest point, as a share of the height. */
  droop: number
  /** Turns of the blade's flat face about its axis from root to tip, radians. */
  twist: number
  /** Width profile per row, root to tip; the last row is the tip. */
  rows: readonly (readonly [number, number])[]
  rootColour: Rgb
  mid: Rgb
  tip: Rgb
  /** Round stems shade the same all round: no rounding across the width. */
  round: boolean
}>

/** Rows (share of the length, share of the width) for each level of detail. */
const ROWS = {
  near: [
    [0, 0.9],
    [0.25, 1],
    [0.5, 0.85],
    [0.75, 0.55],
    [0.92, 0.22],
  ],
  far: [
    [0, 0.9],
    [0.45, 0.85],
    [0.85, 0.3],
  ],
} as const

function appendBlade(builder: MeshBuilder, blade: Blade, phase: number, omega: number) {
  const { root, heading, height } = blade
  // A cubic: up from the root, out toward the heading, the tip falling back by `droop`.
  const rise = height * (1 - 0.55 * blade.lean)
  const reach = height * (0.15 + 0.85 * blade.lean)
  const p1 = add(root, [0, rise * 0.45, 0])
  const p2 = add(add(root, [0, rise * (0.95 + 0.1 * blade.droop), 0]), heading, reach * 0.55)
  const p3 = add(add(root, [0, rise * (1 - blade.droop), 0]), heading, reach)
  const at = (t: number): Point => {
    const k = 1 - t
    const a = k * k * k,
      b = 3 * k * k * t,
      c = 3 * k * t * t,
      d = t * t * t
    return [
      root[0] * a + p1[0] * b + p2[0] * c + p3[0] * d,
      root[1] * a + p1[1] * b + p2[1] * c + p3[1] * d,
      root[2] * a + p1[2] * b + p2[2] * c + p3[2] * d,
    ]
  }
  const tangent = (t: number) =>
    normalize(add(at(Math.min(1, t + 0.02)), at(Math.max(0, t - 0.02)), -1))
  // The blade's flat face looks along the heading's side, then twists.
  const side0 = normalize(cross([0, 1, 0], heading))
  const ids: number[] = []
  const rows = blade.rows
  for (let row = 0; row < rows.length; row++) {
    const [t, w] = rows[row] ?? [0, 1]
    const p = at(t)
    const axis = tangent(t)
    const side = normalize(rotate(side0, axis, blade.twist * t))
    let face = normalize(cross(side, axis))
    if (face[1] < 0) face = scale(face, -1)
    // Root darkness from the neighbours' shade: h^1.5; living colour runs root → mid → tip.
    const shade = Math.pow(t, 1.5)
    const colour =
      t < 0.6
        ? mixRgb(blade.rootColour, blade.mid, Math.min(1, shade / Math.pow(0.6, 1.5)))
        : mixRgb(blade.mid, blade.tip, (t - 0.6) / 0.4)
    const wind = [t * t * height * 0.45, phase, t * 0.008, omega] as const
    const half = (blade.width * w) / 2
    for (const sign of [-1, 1]) {
      const rounded = blade.round ? face : rotate(face, axis, sign * ROUND)
      const n = normalize(add(rounded, [0, 1, 0], 1))
      ids.push(builder.vertex(add(p, side, sign * half), n, colour, wind))
    }
  }
  for (let row = 0; row < rows.length - 1; row++)
    builder.quad(
      ids[row * 2] ?? 0,
      ids[row * 2 + 1] ?? 0,
      ids[row * 2 + 3] ?? 0,
      ids[row * 2 + 2] ?? 0,
    )
  const last = (rows.length - 1) * 2
  const tipPoint = at(1)
  const tip = builder.vertex(tipPoint, add([0, 1, 0], heading, 0.3), blade.tip, [
    height * 0.45,
    phase,
    0.008,
    omega,
  ])
  builder.triangle(ids[last] ?? 0, ids[last + 1] ?? 0, tip)
}

/**
 * Append one clump. `lod` in (0, 1] keeps that share of its blades and widens them in
 * proportion, so distant grass covers the same screen area with fewer triangles; `minWidth`
 * is about two pixels at the clump's distance.
 */
export function appendClump(
  builder: MeshBuilder,
  clump: Clump,
  ground: (x: number, z: number) => number | null,
  lod: number,
  minWidth: number,
) {
  const r = (blade: number, stream: number) => hash(blade, clump.salt, stream)
  const omega = Math.min((2 * Math.PI * 1.2) / Math.sqrt(Math.max(clump.height, 0.05)), MAX_OMEGA)
  const near = lod > 0.6
  const rows = near ? ROWS.near : ROWS.far
  const counts = { turf: 26, wiry: 28, flat: 12, rush: 6 } as const
  const blades = Math.max(2, Math.round(counts[clump.form] * lod))
  const widen = 1 / Math.sqrt(lod)
  for (let i = 0; i < blades; i++) {
    // Roots crowd the clump's centre.
    const angle = r(i, 1) * Math.PI * 2
    const out = Math.sqrt(r(i, 2)) * clump.radius
    const x = clump.x + Math.sin(angle) * out,
      z = clump.z + Math.cos(angle) * out
    const y = ground(x, z)
    if (y === null) continue
    // Blades lean outward from the clump's centre, more at its rim: a fountain, not a comb.
    let heading: Point = [
      Math.sin(angle + (r(i, 3) - 0.5) * 0.8),
      0,
      Math.cos(angle + (r(i, 3) - 0.5) * 0.8),
    ]
    const edge = clump.edge
    const toward = edge ? heading[0] * edge[0] + heading[2] * edge[1] : 0
    if (edge && toward > 0)
      heading = normalize([heading[0] - 2 * toward * edge[0], 0, heading[2] - 2 * toward * edge[1]])
    const rim = out / Math.max(clump.radius, 1e-3)
    // Dead blades: straw standing or bent, and litter lying low at the base.
    const dead = r(i, 4) < (clump.form === 'turf' ? 0.06 : 0.1) + 0.35 * clump.dryness
    const litter = dead && r(i, 5) < 0.45
    const height = clump.height * (0.8 + 0.4 * r(i, 6)) * (litter ? 0.55 : dead ? 0.8 : 1)
    const value = clump.value * (0.92 + 0.16 * r(i, 7))
    let blade: Blade
    if (clump.form === 'rush' && !dead) {
      blade = {
        root: [x, y - 0.01, z],
        heading,
        height: height * (0.85 + 0.3 * r(i, 8)),
        width: Math.max(0.0035 * widen, minWidth),
        lean: 0.04 + 0.08 * r(i, 9),
        droop: 0,
        twist: 0,
        rows,
        rootColour: GRASS.root,
        mid: scaleRgb(GRASS.rush, value),
        tip: scaleRgb(mixRgb(GRASS.rush, GRASS.straw, 0.35), value),
        round: true,
      }
    } else {
      const flat = clump.form === 'flat'
      const baseWidth = flat ? 0.004 + 0.003 * r(i, 8) : 0.0016 + 0.0012 * r(i, 8)
      const living = scaleRgb(
        mixRgb(flat ? GRASS.flat : GRASS.wiry, GRASS.straw, clump.dryness * 0.3),
        value,
      )
      const livingTip = scaleRgb(
        mixRgb(flat ? GRASS.flatTip : GRASS.wiryTip, GRASS.strawTip, clump.dryness * 0.4),
        value,
      )
      blade = {
        root: [x, y - 0.01, z],
        heading,
        height,
        width: Math.max(baseWidth * widen, minWidth),
        lean: litter
          ? 0.75 + 0.2 * r(i, 9)
          : (flat ? 0.3 : clump.form === 'turf' ? 0.25 : 0.15) +
            (0.25 + 0.3 * rim) * r(i, 9) +
            (dead ? 0.2 : 0),
        // Flat leaves arch over and droop; wiry ones mostly stand; dead tips break off blunt.
        droop: flat ? 0.15 + 0.35 * r(i, 10) : 0.05 * r(i, 10),
        twist: (r(i, 11) - 0.5) * (flat ? 2.2 : 0.6),
        rows: dead && r(i, 12) < 0.4 ? rows.slice(0, rows.length - 1) : rows,
        rootColour: dead ? GRASS.litter : GRASS.root,
        mid: dead ? scaleRgb(litter ? GRASS.litter : GRASS.straw, value) : living,
        tip: dead ? scaleRgb(litter ? GRASS.litter : GRASS.strawTip, value) : livingTip,
        round: false,
      }
    }
    appendBlade(builder, blade, clump.phase + r(i, 13) * 0.6, omega)
  }
  // Seed stalks: bare culms over the leaves, each carrying a narrow panicle.
  if (clump.seeds && clump.form !== 'rush') {
    const stalks = Math.max(1, Math.round((2 + r(99, 1) * 3) * Math.max(lod, 0.5)))
    for (let i = 0; i < stalks; i++) {
      const angle = r(100 + i, 1) * Math.PI * 2
      const out = Math.sqrt(r(100 + i, 2)) * clump.radius * 0.6
      const x = clump.x + Math.sin(angle) * out,
        z = clump.z + Math.cos(angle) * out
      const y = ground(x, z)
      if (y === null) continue
      const heading: Point = [Math.sin(angle), 0, Math.cos(angle)]
      const height = clump.height * (1.5 + 0.6 * r(100 + i, 3))
      const head = r(100 + i, 4) < 0.5 ? GRASS.panicle : GRASS.panicleSilver
      appendBlade(
        builder,
        {
          root: [x, y - 0.01, z],
          heading,
          height,
          width: Math.max(0.0012 * widen, minWidth * 0.7),
          lean: 0.08 + 0.12 * r(100 + i, 5),
          droop: 0.04,
          twist: 0,
          rows: [
            [0, 1],
            [0.7, 1],
            [0.78, 2.6],
            [0.92, 2],
          ],
          rootColour: GRASS.root,
          mid: mixRgb(GRASS.straw, GRASS.wiry, 0.4),
          tip: head,
          round: true,
        },
        clump.phase + r(100 + i, 6),
        omega,
      )
    }
  }
}

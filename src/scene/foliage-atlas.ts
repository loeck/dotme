/**
 * A procedural botanical atlas, drawn once in the world worker: Norway spruce sprays with their
 * hanging branchlets, Scots pine needle tufts, weeping birch twigs, shrub foliage and a lobed
 * core disc. Each RGBA8 texel stores a palette-relative tone in R and cutout coverage in A; tone
 * darkens toward the bottom of a card and varies needle to needle and leaf to leaf, so crowns
 * read as foliage rather than flat paint.
 */
/** Tile edge in texels: phones draw smaller trees, so they bake a quarter of the texels. */
export const atlasTile = (mobile: boolean) => (mobile ? 128 : 256)
export const ATLAS_COLUMNS = 4
export const ATLAS_ROWS = 2
export const ATLAS_TILES = {
  spruceA: 0,
  spruceB: 1,
  pineA: 2,
  pineB: 3,
  birchA: 4,
  birchB: 5,
  bush: 6,
  disc: 7,
} as const
export type AtlasTile = (typeof ATLAS_TILES)[keyof typeof ATLAS_TILES]

export type FoliageAtlas = Readonly<{ width: number; height: number; data: Uint8Array }>

/** UV rectangle [u0, v0, u1, v1] of a tile, v up, inset 1.5 texels of the smaller atlas. */
export function atlasRect(tile: AtlasTile): readonly [number, number, number, number] {
  const column = tile % ATLAS_COLUMNS,
    row = Math.floor(tile / ATLAS_COLUMNS)
  const inset = 1.5 / atlasTile(true)
  return [
    (column + inset) / ATLAS_COLUMNS,
    (row + inset) / ATLAS_ROWS,
    (column + 1 - inset) / ATLAS_COLUMNS,
    (row + 1 - inset) / ATLAS_ROWS,
  ]
}

function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

class TileCanvas {
  readonly size: number
  readonly tone: Float32Array
  readonly alpha: Float32Array
  constructor(size: number) {
    this.size = size
    this.tone = new Float32Array(size * size)
    this.alpha = new Float32Array(size * size)
  }
  /** Stamp a primitive whose signed distance (in tile units, 0..1) is `distance`. */
  stamp(
    box: readonly [number, number, number, number],
    distance: (u: number, v: number) => number,
    tone: (u: number, v: number) => number,
  ) {
    const n = this.size
    const [u0, v0, u1, v1] = box
    const px = 1 / n
    for (
      let y = Math.max(0, Math.floor(v0 * n) - 1);
      y <= Math.min(n - 1, Math.ceil(v1 * n) + 1);
      y++
    )
      for (
        let x = Math.max(0, Math.floor(u0 * n) - 1);
        x <= Math.min(n - 1, Math.ceil(u1 * n) + 1);
        x++
      ) {
        const u = (x + 0.5) / n,
          v = (y + 0.5) / n
        const d = distance(u, v)
        // One-texel antialiased edge.
        const cover = Math.max(0, Math.min(1, 0.5 - d / px))
        if (cover <= 0) continue
        const index = y * n + x
        const previous = this.alpha[index] ?? 0
        if (cover >= previous) this.tone[index] = tone(u, v)
        this.alpha[index] = Math.max(previous, cover)
      }
  }
  /** A tapered stroke between two points with radii r0 and r1. */
  stroke(
    a: readonly [number, number],
    b: readonly [number, number],
    r0: number,
    r1: number,
    tone: (u: number, v: number) => number,
  ) {
    const dx = b[0] - a[0],
      dy = b[1] - a[1]
    // Long, thin strokes split into short pieces, so each scans a small box, not a diagonal's.
    const pieces = Math.ceil(Math.hypot(dx, dy) / (6 / this.size))
    if (pieces > 1) {
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces,
          t1 = (k + 1) / pieces
        this.stroke(
          [a[0] + dx * t0, a[1] + dy * t0],
          [a[0] + dx * t1, a[1] + dy * t1],
          r0 + (r1 - r0) * t0,
          r0 + (r1 - r0) * t1,
          tone,
        )
      }
      return
    }
    const length2 = dx * dx + dy * dy || 1e-9
    const reach = Math.max(r0, r1)
    this.stamp(
      [
        Math.min(a[0], b[0]) - reach,
        Math.min(a[1], b[1]) - reach,
        Math.max(a[0], b[0]) + reach,
        Math.max(a[1], b[1]) + reach,
      ],
      (u, v) => {
        const t = Math.max(0, Math.min(1, ((u - a[0]) * dx + (v - a[1]) * dy) / length2))
        const ex = u - a[0] - dx * t,
          ey = v - a[1] - dy * t
        return Math.sqrt(ex * ex + ey * ey) - (r0 + (r1 - r0) * t)
      },
      tone,
    )
  }
  /** A pointed leaf: an ellipse-like lens from `base` along `angle`. */
  leaf(
    base: readonly [number, number],
    angle: number,
    length: number,
    width: number,
    tone: (u: number, v: number) => number,
  ) {
    const c = Math.cos(angle),
      s = Math.sin(angle)
    const reach = length
    this.stamp(
      [base[0] - reach, base[1] - reach, base[0] + reach, base[1] + reach],
      (u, v) => {
        const lx = (u - base[0]) * c + (v - base[1]) * s
        const ly = -(u - base[0]) * s + (v - base[1]) * c
        const t = lx / length
        if (t < 0 || t > 1)
          return Math.sqrt(Math.min(lx * lx, (lx - length) * (lx - length)) + ly * ly)
        // Lens profile: widest at 40%, pointed at both ends.
        const half = width * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.75))
        return Math.abs(ly) - half
      },
      tone,
    )
  }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
type Uv = readonly [number, number]

/** Points along a quadratic curve from `a` through control `c` to `b`. */
function bend(a: Uv, c: Uv, b: Uv, count: number): Uv[] {
  const points: Uv[] = []
  for (let i = 0; i <= count; i++) {
    const t = i / count,
      k = 1 - t
    points.push([
      k * k * a[0] + 2 * k * t * c[0] + t * t * b[0],
      k * k * a[1] + 2 * k * t * c[1] + t * t * b[1],
    ])
  }
  return points
}

/**
 * Norway spruce spray seen from the side: a shoot across the top of the card, combed
 * branchlets hanging from it, every shoot clothed in short needles angled toward its tip.
 */
function spruceSpray(seed: number, size: number) {
  const tile = new TileCanvas(size)
  const random = prng(seed)
  const shade = (base: number) => (_u: number, v: number) =>
    clamp01(base * (0.55 + 0.55 * v) + (random() - 0.5) * 0.16)
  const clothe = (points: readonly Uv[], length: number, density: number, base = 1) => {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i] ?? [0, 0],
        b = points[i + 1] ?? [0, 0]
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0])
      const span = Math.hypot(b[0] - a[0], b[1] - a[1])
      const count = Math.max(2, Math.round(span * density))
      for (let k = 0; k < count; k++) {
        const t = (k + random()) / count
        const p: Uv = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        for (const side of [-1, 1]) {
          const angle = heading + side * (0.7 + random() * 0.5)
          const l = length * (0.7 + random() * 0.6)
          tile.stroke(
            p,
            [p[0] + Math.cos(angle) * l, p[1] + Math.sin(angle) * l],
            0.0042,
            0.0018,
            shade(base * (0.85 + random() * 0.3)),
          )
        }
      }
    }
  }
  const arch = 0.04 + random() * 0.05
  const shoot = bend(
    [0.03, 0.8 + random() * 0.04],
    [0.5, 0.84 + arch],
    [0.97, 0.78 + random() * 0.08],
    10,
  ).map(([u, v], i) => [u, v + (i > 0 && i < 10 ? (random() - 0.5) * 0.025 : 0)] as const)
  for (let i = 0; i < shoot.length - 1; i++)
    tile.stroke(shoot[i] ?? [0, 0], shoot[i + 1] ?? [0, 0], 0.007, 0.006, () => 0.3)
  clothe(shoot, 0.045, 150)
  // Combed branchlets: longest mid-spray, hanging and swinging slightly toward the tip.
  for (let k = 0; k < 15; k++) {
    const t = 0.05 + (k / 14) * 0.9 + (random() - 0.5) * 0.04
    const from = shoot[Math.min(shoot.length - 1, Math.round(t * (shoot.length - 1)))] ?? [0.5, 0.8]
    const length = (0.32 + 0.4 * Math.sin(Math.PI * t)) * (0.75 + random() * 0.4)
    const swing = 0.05 + random() * 0.1
    const to: Uv = [from[0] + swing, Math.max(0.03, from[1] - length)]
    const points = bend(from, [from[0] + swing * 0.2, from[1] - length * 0.55], to, 5)
    for (let i = 0; i < points.length - 1; i++)
      tile.stroke(points[i] ?? [0, 0], points[i + 1] ?? [0, 0], 0.0045, 0.003, () => 0.3)
    // Each branchlet its own shade, so the comb reads as separate shoots rather than a fill.
    clothe(points, 0.034, 150, 0.6 + random() * 0.55)
  }
  // Short shoots standing above the main one break the spray's upper edge.
  for (let k = 0; k < 7; k++) {
    const from = shoot[1 + Math.floor(random() * (shoot.length - 2))] ?? [0.5, 0.85]
    const to: Uv = [
      from[0] + (random() - 0.3) * 0.12,
      Math.min(0.99, from[1] + 0.05 + random() * 0.07),
    ]
    tile.stroke(from, to, 0.004, 0.003, () => 0.3)
    clothe([from, to], 0.035, 170)
  }
  return tile
}

/** Scots pine: brush-like tufts of long, paired needles on short twigs, pointing up and out. */
function pineTufts(seed: number, size: number) {
  const tile = new TileCanvas(size)
  const random = prng(seed)
  const shade = (base: number) => (_u: number, v: number) =>
    clamp01(base * (0.6 + 0.5 * v) + (random() - 0.5) * 0.18)
  const tufts = 6
  for (let tuft = 0; tuft < tufts; tuft++) {
    const base: Uv = [0.14 + (0.72 * tuft) / (tufts - 1) + (random() - 0.5) * 0.08, 0.14]
    const tip: Uv = [base[0] + (random() - 0.5) * 0.16, 0.3 + random() * 0.18]
    tile.stroke(base, tip, 0.008, 0.006, () => 0.28)
    // Needles grow along the last half of the twig, the newest at its tip.
    for (let needle = 0; needle < 110; needle++) {
      const t = 0.3 + random() * 0.7
      const from: Uv = [base[0] + (tip[0] - base[0]) * t, base[1] + (tip[1] - base[1]) * t]
      const angle = Math.PI / 2 + (random() - 0.5) * 2.6 * (0.55 + 0.45 * t)
      const length = (0.16 + random() * 0.14) * (0.7 + 0.3 * t)
      const to: Uv = [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length]
      tile.stroke(from, to, 0.0038, 0.0012, shade(0.8 + random() * 0.4))
    }
  }
  return tile
}

/** Weeping birch: slender twigs hanging from the top, with small toothed, ovate leaves. */
function birchTwigs(seed: number, size: number) {
  const tile = new TileCanvas(size)
  const random = prng(seed)
  const shade = (base: number) => (_u: number, v: number) =>
    clamp01(base * (0.62 + 0.45 * v) + (random() - 0.5) * 0.12)
  const twigs = 9
  for (let twig = 0; twig < twigs; twig++) {
    const from: Uv = [0.08 + (0.84 * twig) / (twigs - 1) + (random() - 0.5) * 0.05, 0.96]
    const drop = 0.65 + random() * 0.28
    const drift = (random() - 0.5) * 0.22
    const points = bend(
      from,
      [from[0] + drift * 1.4, from[1] - drop * 0.35],
      [from[0] + drift, from[1] - drop],
      8,
    )
    for (let i = 0; i < points.length - 1; i++)
      tile.stroke(points[i] ?? [0, 0], points[i + 1] ?? [0, 0], 0.0035, 0.0022, () => 0.3)
    // Alternate leaves on short stalks, angled down and out, smaller toward the twig's end.
    for (let leaf = 0; leaf < 22; leaf++) {
      const t = 0.05 + (leaf / 22) * 0.93
      const at = points[Math.min(points.length - 1, Math.round(t * (points.length - 1)))] ?? from
      const side = leaf % 2 === 0 ? 1 : -1
      const angle = -Math.PI / 2 + side * (0.45 + random() * 0.75)
      const leafSize = (0.055 + random() * 0.025) * (1 - 0.3 * t)
      tile.leaf(at, angle, leafSize, leafSize * 0.72, shade(0.75 + random() * 0.5))
    }
  }
  return tile
}

/** Low shrub foliage: a dome of small leaves over a few twigs, as bilberry and young growth. */
function shrubLeaves(seed: number, size: number) {
  const tile = new TileCanvas(size)
  const random = prng(seed)
  const shade = (base: number) => (_u: number, v: number) =>
    clamp01(base * (0.5 + 0.6 * v) + (random() - 0.5) * 0.14)
  for (let twig = 0; twig < 7; twig++) {
    const from: Uv = [0.5 + (random() - 0.5) * 0.2, 0.02]
    const to: Uv = [0.1 + random() * 0.8, 0.35 + random() * 0.4]
    tile.stroke(from, to, 0.006, 0.003, () => 0.28)
  }
  for (let leaf = 0; leaf < 420; leaf++) {
    const u = 0.06 + random() * 0.88
    // A dome: tallest at the centre, open at the lower corners.
    const roof = 0.18 + 0.72 * Math.sqrt(Math.max(0, 1 - ((u - 0.5) / 0.46) ** 2))
    const v = 0.04 + random() * (roof - 0.04)
    const leafSize = 0.035 + random() * 0.03
    tile.leaf(
      [u, v],
      random() * Math.PI * 2,
      leafSize,
      leafSize * 0.6,
      shade(0.7 + random() * 0.55),
    )
  }
  return tile
}

/** Lobed, dark core disc that shows foliage rather than sky through gaps inside a crown. */
function coreDisc(seed: number, size: number) {
  const tile = new TileCanvas(size)
  const random = prng(seed)
  const lobes = Array.from({ length: 7 }, () => random() * Math.PI * 2)
  tile.stamp(
    [0, 0, 1, 1],
    (u, v) => {
      const angle = Math.atan2(v - 0.5, u - 0.5)
      const wobble = lobes.reduce(
        (sum, phase, k) => sum + Math.sin(angle * (k + 2) + phase) * 0.02,
        0,
      )
      return Math.hypot(u - 0.5, v - 0.5) - (0.42 + wobble)
    },
    (_u, v) => 0.55 + 0.25 * v,
  )
  return tile
}

export function bakeFoliageAtlas(seed: number, mobile = false): FoliageAtlas {
  const size = atlasTile(mobile)
  const width = size * ATLAS_COLUMNS,
    height = size * ATLAS_ROWS
  const data = new Uint8Array(width * height * 4)
  const tiles: [AtlasTile, TileCanvas][] = [
    [ATLAS_TILES.spruceA, spruceSpray(seed + 1, size)],
    [ATLAS_TILES.spruceB, spruceSpray(seed + 2, size)],
    [ATLAS_TILES.pineA, pineTufts(seed + 3, size)],
    [ATLAS_TILES.pineB, pineTufts(seed + 4, size)],
    [ATLAS_TILES.birchA, birchTwigs(seed + 5, size)],
    [ATLAS_TILES.birchB, birchTwigs(seed + 6, size)],
    [ATLAS_TILES.bush, shrubLeaves(seed + 7, size)],
    [ATLAS_TILES.disc, coreDisc(seed + 8, size)],
  ]
  for (const [index, tile] of tiles) {
    const ox = (index % ATLAS_COLUMNS) * size,
      oy = Math.floor(index / ATLAS_COLUMNS) * size
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const source = y * size + x
        const target = ((oy + y) * width + ox + x) * 4
        const alpha = tile.alpha[source] ?? 0
        data[target] = Math.round((alpha > 0 ? (tile.tone[source] ?? 0) : 0.5) * 255)
        data[target + 1] = 0
        data[target + 2] = 0
        data[target + 3] = Math.round(alpha * 255)
      }
  }
  return { width, height, data }
}

/** Fraction of covered texels in a tile, used by tests and coverage calibration. */
export function tileCoverage(atlas: FoliageAtlas, tile: AtlasTile) {
  const size = atlas.width / ATLAS_COLUMNS
  const ox = (tile % ATLAS_COLUMNS) * size,
    oy = Math.floor(tile / ATLAS_COLUMNS) * size
  let covered = 0
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((atlas.data[((oy + y) * atlas.width + ox + x) * 4 + 3] ?? 0) >= 128) covered++
  return covered / (size * size)
}

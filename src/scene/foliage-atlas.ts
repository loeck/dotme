/**
 * A small procedural botanical atlas after Voxen's foliage atlas (`foliage_atlas.zig`): bough
 * sprays for needle clumps, hanging leaf clusters for leaf clumps and a lobed core disc. Each
 * RGBA8 texel stores a palette-relative tone in R and cutout coverage in A. Tone darkens toward
 * the bottom of a card and lightens toward its top, as in Last Signal's atlas.
 */
export const ATLAS_TILE = 128
export const ATLAS_COLUMNS = 4
export const ATLAS_ROWS = 2
export const ATLAS_TILES = {
  needleA: 0,
  needleB: 1,
  leafA: 2,
  leafB: 3,
  disc: 4,
} as const
export type AtlasTile = (typeof ATLAS_TILES)[keyof typeof ATLAS_TILES]

export type FoliageAtlas = Readonly<{ width: number; height: number; data: Uint8Array }>

/** UV rectangle [u0, v0, u1, v1] of a tile, v up, with a half-texel inset against bleeding. */
export function atlasRect(tile: AtlasTile): readonly [number, number, number, number] {
  const width = ATLAS_TILE * ATLAS_COLUMNS,
    height = ATLAS_TILE * ATLAS_ROWS
  const column = tile % ATLAS_COLUMNS,
    row = Math.floor(tile / ATLAS_COLUMNS)
  const inset = 1.5
  return [
    (column * ATLAS_TILE + inset) / width,
    (row * ATLAS_TILE + inset) / height,
    ((column + 1) * ATLAS_TILE - inset) / width,
    ((row + 1) * ATLAS_TILE - inset) / height,
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
  readonly tone = new Float32Array(ATLAS_TILE * ATLAS_TILE)
  readonly alpha = new Float32Array(ATLAS_TILE * ATLAS_TILE)
  /** Stamp a primitive whose signed distance (in tile units, 0..1) is `distance`. */
  stamp(
    box: readonly [number, number, number, number],
    distance: (u: number, v: number) => number,
    tone: (u: number, v: number) => number,
  ) {
    const n = ATLAS_TILE
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
        return Math.hypot(u - a[0] - dx * t, v - a[1] - dy * t) - (r0 + (r1 - r0) * t)
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
        if (t < 0 || t > 1) return Math.min(Math.hypot(lx, ly), Math.hypot(lx - length, ly))
        // Lens profile: widest at 40%, pointed at both ends.
        const half = width * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.75))
        return Math.abs(ly) - half
      },
      tone,
    )
  }
}

/** Bough spray: a drooping twig tipped upward, side shoots, and dense serrated needles. */
function needleSpray(seed: number) {
  const tile = new TileCanvas()
  const random = prng(seed)
  // Darker underside, lighter crown of the spray, with fine needle-to-needle variation.
  const shade = (base: number) => (_u: number, v: number) =>
    Math.max(0, Math.min(1, base * (0.62 + 0.5 * v) + (random() - 0.5) * 0.12))
  const twig = (u: number) => 0.5 - 0.12 * Math.sin(Math.PI * u * 0.9) + 0.18 * u * u
  const needles = (
    from: readonly [number, number],
    to: readonly [number, number],
    count: number,
    length: number,
  ) => {
    for (let k = 0; k < count; k++) {
      const t = (k + random() * 0.6) / count
      const p: [number, number] = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
      const heading = Math.atan2(to[1] - from[1], to[0] - from[0])
      for (const side of [-1, 1]) {
        const angle = heading + side * (0.75 + random() * 0.45) - 0.12
        const l = length * (0.75 + random() * 0.5) * (1 - 0.35 * t)
        tile.stroke(
          p,
          [p[0] + Math.cos(angle) * l, p[1] + Math.sin(angle) * l],
          0.0075,
          0.003,
          shade(0.92 + 0.08 * side),
        )
      }
    }
  }
  const points: [number, number][] = []
  for (let i = 0; i <= 8; i++) {
    const u = 0.06 + (0.88 * i) / 8
    points.push([u, twig(u)])
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] ?? [0, 0],
      b = points[i + 1] ?? [0, 0]
    tile.stroke(a, b, 0.012 * (1 - i / 10), 0.01 * (1 - i / 10), () => 0.35)
    needles(a, b, 10, 0.2)
  }
  // Side shoots break the silhouette into a serrated spray.
  for (let shoot = 0; shoot < 8; shoot++) {
    const i = 1 + Math.floor(random() * 6)
    const from = points[i] ?? [0.5, 0.5]
    const side = shoot % 2 === 0 ? 1 : -1
    const to: [number, number] = [
      from[0] + 0.14 + random() * 0.12,
      from[1] + side * (0.12 + random() * 0.12),
    ]
    tile.stroke(from, to, 0.008, 0.005, () => 0.35)
    needles(from, to, 7, 0.15)
  }
  return tile
}

/** Hanging leaf cluster: a few drooping stems carrying pointed leaves, about 70% coverage. */
function leafCluster(seed: number) {
  const tile = new TileCanvas()
  const random = prng(seed)
  const shade = (base: number) => (u: number, v: number) =>
    Math.max(
      0,
      Math.min(
        1,
        base * (0.6 + 0.48 * v) * (0.92 + 0.16 * Math.abs(u - 0.5)) + (random() - 0.5) * 0.1,
      ),
    )
  for (let stem = 0; stem < 8; stem++) {
    const start: [number, number] = [0.5 + (random() - 0.5) * 0.2, 0.88]
    const angle = -Math.PI / 2 + (stem - 3.5) * 0.27 + (random() - 0.5) * 0.25
    const length = 0.55 + random() * 0.25
    const end: [number, number] = [
      start[0] + Math.cos(angle) * length,
      start[1] + Math.sin(angle) * length,
    ]
    tile.stroke(start, end, 0.006, 0.003, () => 0.3)
    for (let leaf = 0; leaf < 7; leaf++) {
      const t = 0.15 + (leaf / 7) * 0.85
      const base: [number, number] = [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ]
      const side = leaf % 2 === 0 ? 1 : -1
      const leafAngle = angle + side * (0.5 + random() * 0.5)
      tile.leaf(
        base,
        leafAngle,
        0.2 + random() * 0.08,
        0.12 + random() * 0.04,
        shade(0.85 + random() * 0.25),
      )
    }
  }
  return tile
}

/** Lobed, dark core disc that shows foliage rather than sky through gaps inside a crown. */
function coreDisc(seed: number) {
  const tile = new TileCanvas()
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

export function bakeFoliageAtlas(seed: number): FoliageAtlas {
  const width = ATLAS_TILE * ATLAS_COLUMNS,
    height = ATLAS_TILE * ATLAS_ROWS
  const data = new Uint8Array(width * height * 4)
  const tiles: [AtlasTile, TileCanvas][] = [
    [ATLAS_TILES.needleA, needleSpray(seed + 1)],
    [ATLAS_TILES.needleB, needleSpray(seed + 2)],
    [ATLAS_TILES.leafA, leafCluster(seed + 3)],
    [ATLAS_TILES.leafB, leafCluster(seed + 4)],
    [ATLAS_TILES.disc, coreDisc(seed + 5)],
  ]
  for (const [index, tile] of tiles) {
    const ox = (index % ATLAS_COLUMNS) * ATLAS_TILE,
      oy = Math.floor(index / ATLAS_COLUMNS) * ATLAS_TILE
    for (let y = 0; y < ATLAS_TILE; y++)
      for (let x = 0; x < ATLAS_TILE; x++) {
        const source = y * ATLAS_TILE + x
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
  const ox = (tile % ATLAS_COLUMNS) * ATLAS_TILE,
    oy = Math.floor(tile / ATLAS_COLUMNS) * ATLAS_TILE
  let covered = 0
  for (let y = 0; y < ATLAS_TILE; y++)
    for (let x = 0; x < ATLAS_TILE; x++)
      if ((atlas.data[((oy + y) * atlas.width + ox + x) * 4 + 3] ?? 0) >= 128) covered++
  return covered / (ATLAS_TILE * ATLAS_TILE)
}

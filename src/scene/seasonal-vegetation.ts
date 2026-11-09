import {
  attribute,
  float,
  floor,
  fract,
  max,
  mix,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { Season } from './season'

/**
 * The season's palette for the forest, as uniforms: the season is set once per visit (or by
 * `?season=`), so every season shares the same shader programs.
 */
export class SeasonTint {
  readonly spring = uniform(0)
  readonly autumn = uniform(0)
  readonly winter = uniform(0)

  set(season: Season) {
    this.spring.value = season.spring
    this.autumn.value = season.autumn
    this.winter.value = season.winter
  }
}

const hash = (x: Node<'float'>) => fract(sin(x).mul(43758.5453))
/** 1 where `value` lies in [low, high), for the integer tile rows and columns. */
const within = (value: Node<'float'>, low: number, high: number) =>
  step(low, value).mul(float(1).sub(step(high, value)))

/** Autumn leaves in linear albedo: a birch's yellow, a beech's copper, an oak's russet. */
const AUTUMN_YELLOW = vec3(0.25, 0.175, 0.026)
const AUTUMN_ORANGE = vec3(0.25, 0.105, 0.02)
const AUTUMN_DEEP = vec3(0.15, 0.052, 0.022)
/** A bare crown's twig haze and the dead leaves a young beech or oak holds: grey-brown. */
const WINTER_LEAVES = vec3(0.08, 0.068, 0.058)

/**
 * Seasonal foliage: a separate multiply/blend on the cards' base colour and a thinning of their
 * coverage, keyed on the atlas tile (row 0 holds the spruce and pine sprays: conifers keep their
 * needles all year) and on the per-tree sway frequency (constant over one tree, seeded by its
 * placement), so each tree turns its own colour and at its own pace, deterministically per seed.
 */
export function seasonalFoliage(tint: SeasonTint, base: Node<'vec3'>, coverage: Node<'float'>) {
  const wind = attribute<'vec4'>('wind')
  const tree = hash(wind.w.mul(97.31).add(1.7))
  const lag = hash(wind.w.mul(41.17).add(5.3))
  const card = hash(wind.y.mul(12.9898).add(wind.w.mul(78.233)))
  const shed = hash(wind.y.mul(39.346).add(wind.w.mul(11.135)))
  const atlas = uv()
  const column = floor(atlas.x.mul(4)),
    row = floor(atlas.y.mul(3))
  const middle = within(row, 1, 2)
  const birch = middle.mul(within(column, 0, 2))
  const bush = middle.mul(within(column, 2, 3))
  const core = middle.mul(step(3, column))
  const oak = step(2, row).mul(within(column, 0, 2))
  const beech = step(2, row).mul(step(2, column))
  // The core disc is shared: a spruce's shaded cores keep their bluer needle tone.
  const needleCore = core.mul(step(0.265, base.b.div(max(base.g, 0.0001))))
  const deciduous = float(1)
    .sub(within(row, 0, 1))
    .sub(needleCore)

  // Hue from yellow (0) through copper (0.5) to russet (1): species set the bias, trees vary.
  const bias = float(0.42)
    .sub(birch.mul(0.4))
    .add(bush.mul(0.3))
    .add(oak.mul(0.2))
    .sub(beech.mul(0.06))
  const hue = bias.add(tree.sub(0.5).mul(0.55)).clamp(0, 1)
  const turned = mix(
    mix(AUTUMN_YELLOW, AUTUMN_ORANGE, smoothstep(0, 0.5, hue)),
    AUTUMN_DEEP,
    smoothstep(0.5, 1, hue),
  )
  // Keep the crown's billows: sunlit tops stay lighter than the shaded undersides.
  const value = base.g.div(0.11).clamp(0.45, 1.4)
  const autumnColour = turned.mul(value).mul(card.mul(0.3).add(0.85))
  // One tree in six lags and is still mostly green at the peak.
  const turn = tint.autumn
    .mul(mix(1, 0.3, step(0.84, lag)))
    .mul(card.mul(0.25).add(0.75))
    .mul(deciduous)
  const winterColour = WINTER_LEAVES.mul(value).mul(card.mul(0.4).add(0.8))

  const fresh = mix(base, base.mul(vec3(1.16, 1.1, 0.86)), tint.spring.mul(deciduous))
  const albedo = mix(mix(fresh, autumnColour, turn), winterColour, tint.winter.mul(deciduous))
  // Winter strips most cards (a birch almost all, a beech keeps its dead leaves longest) and
  // every shaded core, so the crowns thin to a haze of twigs.
  const keep = float(0.12)
    .sub(birch.mul(0.09))
    .add(beech.mul(0.1))
    .add(oak.mul(0.02))
    .mul(float(1).sub(core))
  const kept = step(shed, mix(float(1), keep, tint.winter.mul(deciduous)))
  return { albedo, coverage: coverage.mul(kept) }
}

/**
 * Seasonal undergrowth as a factor three multiplies by the vertex colour: a fresh spring sward,
 * the summer palette as built, autumn's olive and straw with the flowers going over, and a
 * brown, flowerless winter bank. Flowers are the only bright vertex colours (above 0.3).
 */
export function seasonalUndergrowth(tint: SeasonTint, base: Node<'vec3'>) {
  const flower = smoothstep(0.28, 0.42, max(base.r, base.g))
  const grass = mix(
    mix(mix(vec3(1), vec3(1.05, 1.12, 0.9), tint.spring), vec3(1.75, 1.0, 0.8), tint.autumn),
    vec3(1.6, 0.8, 0.75),
    tint.winter,
  )
  const faded = mix(vec3(1), vec3(0.3, 0.26, 0.21), max(tint.autumn.mul(0.8), tint.winter))
  return mix(grass, faded, flower)
}

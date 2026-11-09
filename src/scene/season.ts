import { smoothstep as smooth } from './math'
/**
 * The season of the visit, from the date and the latitude: four weights that sum to one, so the
 * landscape can blend through the transitions (late September is mostly summer turning to
 * autumn). Pure: no clock is read here, the caller passes the date.
 */
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const
export type SeasonName = (typeof SEASONS)[number]

export const isSeasonName = (value: unknown): value is SeasonName =>
  typeof value === 'string' && SEASONS.some((season) => season === value)

export type Season = Readonly<{
  /** The dominant season. */
  name: SeasonName
  spring: number
  summer: number
  autumn: number
  winter: number
}>

const YEAR = 365.25

/**
 * Transitions in a temperate northern year as days of the year (0 = 1 January), after the
 * phenology of a western European wood: leaves break in late March and April, darken by late
 * June, turn from mid-September and are down by early December.
 */
const TRANSITIONS: readonly (readonly [number, number, SeasonName, SeasonName])[] = [
  [68, 105, 'winter', 'spring'],
  [145, 172, 'spring', 'summer'],
  [253, 283, 'summer', 'autumn'],
  [319, 340, 'autumn', 'winter'],
]

/** Day of the year in the date's own calendar, 0 on 1 January. */
export function dayOfYear(date: Date) {
  const start = Date.UTC(date.getFullYear(), 0, 1)
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((day - start) / 86_400_000)
}

const weights = (name: SeasonName, amount = 1, other?: SeasonName): Season => {
  const season = { name, spring: 0, summer: 0, autumn: 0, winter: 0 }
  season[name] = amount
  if (other) season[other] += 1 - amount
  return season
}

/** A pure season, for the `?season=` override. */
export function namedSeason(name: SeasonName): Season {
  return weights(name)
}

/** Season weights for a northern-hemisphere day of the year. */
function northernSeason(day: number): Season {
  const d = ((day % YEAR) + YEAR) % YEAR
  for (const [start, end, from, to] of TRANSITIONS) {
    if (d < start || d >= end) continue
    const t = smooth(start, end, d)
    return t < 0.5 ? weights(from, 1 - t, to) : weights(to, t, from)
  }
  if (d < 68 || d >= 340) return weights('winter')
  if (d < 145) return weights('spring')
  if (d < 253) return weights('summer')
  return weights('autumn')
}

/**
 * The season at `latitude` on `date`. The southern hemisphere runs half a year apart; toward
 * the tropics the year flattens into a long green summer.
 */
export function seasonAt(date: Date, latitude: number): Season {
  const lat = Number.isFinite(latitude) ? Math.max(-90, Math.min(90, latitude)) : 0
  const day = dayOfYear(date) + (lat < 0 ? YEAR / 2 : 0)
  const season = northernSeason(day)
  const strength = smooth(12, 28, Math.abs(lat))
  if (strength >= 1) return season
  const blended = {
    spring: season.spring * strength,
    summer: season.summer * strength + (1 - strength),
    autumn: season.autumn * strength,
    winter: season.winter * strength,
  }
  const name = SEASONS.reduce((best, key) => (blended[key] > blended[best] ? key : best))
  return { name, ...blended }
}

/** The override when given, otherwise the season at the visitor's date and latitude. */
export function resolveSeason(override: SeasonName | undefined, date: Date, latitude: number) {
  return override ? namedSeason(override) : seasonAt(date, latitude)
}

/**
 * How the season shapes the living landscape, as multipliers and 0–1 shares. Birds stay all
 * year but fewer flocks cross a winter sky; fireflies glow in late spring and summer nights;
 * insects need the warm half of the year; autumn sheds leaves on its
 * own, without waiting for a gust.
 */
export function seasonalLife(season: Season) {
  const { spring, summer, autumn, winter } = season
  return {
    /** Share of the flock size and of the rate flocks cross the sky. */
    birds: 1 - 0.5 * winter - 0.15 * autumn,
    fireflies: summer + 0.5 * spring,
    insects: summer + 0.6 * spring + 0.3 * autumn,
    /** Multiplier on how readily a gust strips the crowns. */
    leafFall: 1 + 2.5 * autumn - 0.6 * winter,
    /** Share of the autumn trickle: leaves letting go in a light breeze, no gust needed. */
    leafTrickle: autumn,
    /** A typical afternoon temperature, °C, for when no measurement is known. */
    temperature: 5 * winter + 15 * spring + 23 * summer + 14 * autumn,
  }
}
export type SeasonalLife = ReturnType<typeof seasonalLife>

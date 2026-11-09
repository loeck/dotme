import { describe, expect, it } from 'vitest'

import {
  dayOfYear,
  isSeasonName,
  namedSeason,
  resolveSeason,
  seasonalLife,
  seasonAt,
  SEASONS,
} from './season'
import type { Season } from './season'

const PARIS = 48.86
const SYDNEY = -33.87
const date = (month: number, day: number) => new Date(2026, month - 1, day, 12)
const total = (season: Season) => season.spring + season.summer + season.autumn + season.winter

describe('season', () => {
  it('counts days from the first of January', () => {
    expect(dayOfYear(date(1, 1))).toBe(0)
    expect(dayOfYear(date(2, 1))).toBe(31)
    expect(dayOfYear(date(12, 31))).toBe(364)
    expect(dayOfYear(new Date(2028, 11, 31))).toBe(365)
  })

  it('follows a temperate northern year', () => {
    expect(seasonAt(date(1, 15), PARIS).name).toBe('winter')
    expect(seasonAt(date(5, 1), PARIS).name).toBe('spring')
    expect(seasonAt(date(7, 15), PARIS).name).toBe('summer')
    expect(seasonAt(date(10, 25), PARIS).name).toBe('autumn')
    // Early November keeps its colours; mid-December is bare.
    expect(seasonAt(date(11, 9), PARIS).autumn).toBe(1)
    expect(seasonAt(date(12, 15), PARIS).winter).toBe(1)
  })

  it('blends smoothly and keeps the weights normalised', () => {
    let previous = seasonAt(date(1, 1), PARIS)
    for (let day = 1; day < 366; day++) {
      const season = seasonAt(new Date(2026, 0, 1 + day, 12), PARIS)
      expect(total(season)).toBeCloseTo(1, 9)
      for (const key of SEASONS) expect(Math.abs(season[key] - previous[key])).toBeLessThan(0.1)
      previous = season
    }
    const turning = seasonAt(date(9, 25), PARIS)
    expect(turning.summer).toBeGreaterThan(0.1)
    expect(turning.autumn).toBeGreaterThan(0.1)
  })

  it('flips the southern hemisphere and flattens the tropics into summer', () => {
    expect(seasonAt(date(1, 15), SYDNEY).name).toBe('summer')
    expect(seasonAt(date(7, 15), SYDNEY).name).toBe('winter')
    expect(seasonAt(date(4, 25), SYDNEY).name).toBe('autumn')
    const equator = seasonAt(date(1, 15), 1)
    expect(equator.summer).toBe(1)
    expect(total(equator)).toBeCloseTo(1, 9)
    expect(seasonAt(date(1, 15), Number.NaN).name).toBe('summer')
  })

  it('honours an explicit season', () => {
    expect(isSeasonName('autumn')).toBe(true)
    for (const value of ['Autumn', 'fall', '', '__proto__', null])
      expect(isSeasonName(value)).toBe(false)
    expect(resolveSeason('winter', date(7, 15), PARIS)).toEqual(namedSeason('winter'))
    expect(resolveSeason(undefined, date(7, 15), PARIS).name).toBe('summer')
  })

  it('shapes the living landscape by season', () => {
    const [spring, summer, autumn, winter] = SEASONS.map((name) => seasonalLife(namedSeason(name)))
    if (!spring || !summer || !autumn || !winter) throw new Error('missing season')
    expect(winter.birds).toBeLessThan(summer.birds)
    expect(winter.fireflies).toBe(0)
    expect(autumn.fireflies).toBe(0)
    expect(summer.fireflies).toBe(1)
    expect(winter.insects).toBe(0)
    expect(winter.bats).toBe(0)
    expect(autumn.leafFall).toBeGreaterThan(summer.leafFall)
    expect(winter.leafFall).toBeLessThan(summer.leafFall)
    expect(summer.temperature).toBeGreaterThan(spring.temperature)
    expect(winter.temperature).toBeLessThan(autumn.temperature)
  })
})

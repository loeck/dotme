import { Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { flockRandom } from './bird-flock'
import { BATS, batActivity, batBeats, DuskBats, stepBat } from './dusk-bats'
import type { Bat } from './dusk-bats'
import { INSECTS, stepDragonfly } from './lake-insects'
import type { Dragonfly } from './lake-insects'
import { namedSeason, seasonalLife } from './season'
import { faunaConditions } from './seasonal-fauna'
import type { FaunaWeather } from './seasonal-fauna'

const SOLAR = { sunrise: 6 * 3600, sunset: 18 * 3600 }
const at = (hours: number, minutes = 0) => hours * 3600 + minutes * 60
const fine: FaunaWeather = {
  rain: 0,
  windSpeed: 2,
  fog: 0,
  snow: 0,
  storm: false,
  temperature: 21,
}
const summer = seasonalLife(namedSeason('summer'))

describe('dusk bats', () => {
  it('come out after sunset and again before dawn', () => {
    expect(batActivity(at(12), SOLAR)).toBe(0)
    expect(batActivity(at(18, 5), SOLAR)).toBe(0)
    expect(batActivity(at(18, 40), SOLAR)).toBe(1)
    expect(batActivity(at(19, 50), SOLAR)).toBe(0)
    expect(batActivity(at(0), SOLAR)).toBe(0)
    expect(batActivity(at(5, 0), SOLAR)).toBe(1)
    expect(batActivity(at(5, 55), SOLAR)).toBe(0)
    expect(batActivity(at(7), SOLAR)).toBe(0)
    // A summer evening in Paris: sunset at 21:58.
    expect(batActivity(at(22, 40), { sunrise: at(5, 47), sunset: at(21, 58) })).toBe(1)
  })

  it('hunt through midnight without a jump when the sun sets late or rises early', () => {
    // A far-north summer: sunset at 23:40, so the evening's hunt runs past midnight.
    const north = { sunrise: at(3, 10), sunset: at(23, 40) }
    expect(batActivity(at(0, 10), north)).toBe(1)
    expect(batActivity(at(24, 10), north)).toBe(1)
    expect(batActivity(at(-1, 0) + 86_400 * 2, north)).toBe(batActivity(at(23), north))
    // Dawn feeding a sunrise at 00:50 begins on the previous day's clock.
    expect(batActivity(at(23, 50), { sunrise: at(0, 50), sunset: at(20) })).toBe(1)
    // Minute by minute across midnight the activity never jumps.
    let previous = batActivity(at(23), north)
    for (let minute = 1; minute <= 120; minute++) {
      const next = batActivity(at(23, minute), north)
      expect(Math.abs(next - previous)).toBeLessThan(0.15)
      previous = next
    }
  })

  it('zigzag inside their beat, quick and never still', () => {
    const [beat] = batBeats(42, 1)
    if (!beat) throw new Error('missing beat')
    const bat: Bat = {
      beat,
      position: beat.centre.clone(),
      velocity: new Vector3(),
      target: beat.centre.clone(),
      speed: BATS.speed[0],
      retargetIn: 0,
      glideFor: 0,
      phase: 0,
      rate: 1,
      flap: 1,
      presence: 1,
      threshold: 0,
      bank: 0,
    }
    const random = flockRandom(7)
    let turns = 0
    let previous = 0
    for (let i = 0; i < 600; i++) {
      stepBat(bat, 1 / 60, random)
      const heading = Math.atan2(bat.velocity.x, bat.velocity.z)
      if (
        i > 0 &&
        Math.abs(Math.atan2(Math.sin(heading - previous), Math.cos(heading - previous))) > 0.05
      )
        turns++
      previous = heading
      expect(bat.position.distanceTo(beat.centre)).toBeLessThan(beat.radius + 6)
    }
    expect(turns).toBeGreaterThan(60)
    expect(bat.velocity.length()).toBeGreaterThan(1)
  })

  it('are seeded: the same seed gives the same beats', () => {
    expect(batBeats(9, 4)).toEqual(batBeats(9, 4))
    expect(batBeats(9, 4)).not.toEqual(batBeats(10, 4))
  })

  it('appear one by one with activity and leave again', () => {
    const bats = new DuskBats(4, 3)
    bats.update(0, 1 / 60, 0)
    expect(bats.visible).toBe(false)
    for (let t = 0; t < 3; t += 1 / 60) bats.update(t, 1 / 60, 1)
    expect(bats.visible).toBe(true)
    for (let t = 3; t < 6; t += 1 / 60) bats.update(t, 1 / 60, 0)
    expect(bats.visible).toBe(false)
    bats.dispose()
  })
})

describe('dragonflies', () => {
  it('hover, then dart a metre or more and hover again near home', () => {
    const home = new Vector3(0, 0, 0)
    const fly: Dragonfly = {
      home,
      position: new Vector3(0, 0.6, 0),
      from: new Vector3(0, 0.6, 0),
      to: new Vector3(0, 0.6, 0),
      left: 0.5,
      dart: 0,
      phase: 0,
      heading: 0,
    }
    const random = flockRandom(5)
    let darts = 0
    let fastest = 0
    let last = fly.position.clone()
    for (let i = 0; i < 1200; i++) {
      const before = fly.dart
      stepDragonfly(fly, i / 60, 1 / 60, random)
      if (before === 0 && fly.dart > 0) darts++
      fastest = Math.max(fastest, fly.position.distanceTo(last) * 60)
      last = fly.position.clone()
      expect(Math.hypot(fly.position.x, fly.position.z)).toBeLessThan(3.6)
      expect(fly.position.y).toBeGreaterThan(0.3)
    }
    // Twenty seconds hold several darts, each far quicker than the hover's tremble.
    expect(darts).toBeGreaterThan(20 / (INSECTS.hover[1] + INSECTS.dart[1]) - 1)
    expect(fastest).toBeGreaterThan(4)
  })
})

describe('fauna conditions', () => {
  it('keeps bats to dry, calm evenings in the warm half of the year', () => {
    expect(faunaConditions(summer, fine, 0, 1).bats).toBe(1)
    for (const weather of [
      { ...fine, rain: 0.5 },
      { ...fine, fog: 0.8 },
      { ...fine, snow: 0.5 },
      { ...fine, storm: true },
      { ...fine, windSpeed: 14 },
      { ...fine, temperature: -2 },
    ])
      expect(faunaConditions(summer, weather, 0, 1).bats).toBe(0)
    const winter = seasonalLife(namedSeason('winter'))
    expect(faunaConditions(winter, fine, 0, 1).bats).toBe(0)
  })

  it('brings insects out on warm, dry, calm days only', () => {
    expect(faunaConditions(summer, fine, 1, 0).insects).toBe(1)
    expect(faunaConditions(summer, fine, 0, 0).insects).toBe(0)
    expect(faunaConditions(summer, { ...fine, temperature: 10 }, 1, 0).insects).toBe(0)
    expect(faunaConditions(summer, { ...fine, windSpeed: 8 }, 1, 0).insects).toBe(0)
    expect(faunaConditions(summer, { ...fine, rain: 0.3 }, 1, 0).insects).toBe(0)
    const winter = seasonalLife(namedSeason('winter'))
    expect(faunaConditions(winter, fine, 1, 0).insects).toBe(0)
  })
})

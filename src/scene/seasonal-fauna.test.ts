import { Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { flockRandom } from './bird-flock'
import { INSECTS, stepDragonfly } from './lake-insects'
import type { Dragonfly } from './lake-insects'
import { namedSeason, seasonalLife } from './season'
import { faunaConditions } from './seasonal-fauna'
import type { FaunaWeather } from './seasonal-fauna'

const fine: FaunaWeather = {
  rain: 0,
  windSpeed: 2,
  fog: 0,
  snow: 0,
  storm: false,
  temperature: 21,
}
const summer = seasonalLife(namedSeason('summer'))

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
  it('brings insects out on warm, dry, calm days only', () => {
    expect(faunaConditions(summer, fine, 1).insects).toBe(1)
    expect(faunaConditions(summer, fine, 0).insects).toBe(0)
    expect(faunaConditions(summer, { ...fine, temperature: 10 }, 1).insects).toBe(0)
    expect(faunaConditions(summer, { ...fine, windSpeed: 8 }, 1).insects).toBe(0)
    expect(faunaConditions(summer, { ...fine, rain: 0.3 }, 1).insects).toBe(0)
    const winter = seasonalLife(namedSeason('winter'))
    expect(faunaConditions(winter, fine, 1).insects).toBe(0)
  })
})

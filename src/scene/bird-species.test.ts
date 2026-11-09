import { describe, expect, it } from 'vitest'

import { flockRandom } from './bird-flock'
import { BIRD_VERTICES, hingedVertex, writeBird } from './bird-geometry'
import {
  BIRD_SPECIES,
  SPECIES,
  chooseSpecies,
  flapPose,
  speciesWeights,
  stepWing,
} from './bird-species'
import type { FlockContext, WingPose, WingState } from './bird-species'
import { namedSeason } from './season'

const hour = 3600
const context = (overrides: Partial<FlockContext> = {}): FlockContext => ({
  season: namedSeason('summer'),
  sinceSunrise: 6 * hour,
  untilSunset: 6 * hour,
  overcast: 0,
  fromCrown: false,
  ...overrides,
})

const share = (ctx: FlockContext) => {
  const weights = speciesWeights(ctx)
  const total = BIRD_SPECIES.reduce((sum, name) => sum + weights[name], 0)
  return Object.fromEntries(BIRD_SPECIES.map((name) => [name, weights[name] / total]))
}

describe('bird species by context', () => {
  it('startles only crows out of a crown', () => {
    const random = flockRandom(4)
    for (let i = 0; i < 50; i++)
      expect(chooseSpecies(context({ fromCrown: true }), random)).toBe('crow')
  })

  it('sends swifts on summer evenings and never in winter', () => {
    const evening = share(context({ untilSunset: 1.5 * hour, sinceSunrise: 14 * hour }))
    const noon = share(context())
    expect(evening.swift).toBeGreaterThan(noon.swift ?? 0)
    expect(evening.swift).toBeGreaterThan(0.35)
    const winter = speciesWeights(context({ season: namedSeason('winter') }))
    expect(winter.swift).toBe(0)
    expect(speciesWeights(context({ season: namedSeason('autumn') })).swift).toBe(0)
  })

  it('favours mallards at dawn and dusk and crows under a winter overcast', () => {
    const dawn = share(context({ sinceSunrise: 0.5 * hour }))
    expect(dawn.mallard).toBeGreaterThan(share(context()).mallard ?? 0)
    const grey = share(context({ season: namedSeason('winter'), overcast: 1 }))
    expect(grey.crow).toBeGreaterThan(share(context()).crow ?? 0)
  })

  it('draws every species it weighs, in proportion', () => {
    const random = flockRandom(9)
    const counts: Record<string, number> = { crow: 0, gull: 0, mallard: 0, swift: 0 }
    const ctx = context({ untilSunset: 2 * hour })
    for (let i = 0; i < 4000; i++) {
      const name = chooseSpecies(ctx, random)
      counts[name] = (counts[name] ?? 0) + 1
    }
    const expected = share(ctx)
    for (const name of BIRD_SPECIES)
      expect((counts[name] ?? 0) / 4000).toBeCloseTo(expected[name] ?? 0, 1)
  })
})

const pose = (): WingPose => ({ shoulder: 0, wrist: 0, fold: 0 })

/** Share of 30 s a bird of `name` spends gliding. */
const glideShare = (name: (typeof BIRD_SPECIES)[number]) => {
  const { flight } = SPECIES[name]
  const wing: WingState = { phase: 0, beats: flight.burst[0], gliding: 0, glide: 0, rate: 1 }
  const random = flockRandom(3)
  let glidingTime = 0,
    widest = 0,
    finite = true
  const target = pose()
  for (let t = 0; t < 30; t += 1 / 60) {
    stepWing(wing, flight, 1 / 60, false, random, target)
    if (wing.gliding > 0) glidingTime += 1 / 60
    finite &&= [target.shoulder, target.wrist, target.fold].every(Number.isFinite)
    widest = Math.max(widest, Math.abs(target.shoulder))
  }
  return { share: glidingTime / 30, widest, finite }
}

describe('wing beat', () => {
  it('sweeps the wing down on the downstroke and folds the hand on the way up', () => {
    for (const name of BIRD_SPECIES) {
      const { flight } = SPECIES[name]
      const top = flapPose(0, flight, pose())
      const bottom = flapPose(flight.downstroke, flight, pose())
      expect(top.shoulder).toBeGreaterThan(0.3)
      expect(bottom.shoulder).toBeLessThan(0)
      expect(top.shoulder - bottom.shoulder).toBeCloseTo(flight.amplitude, 5)
      // Extended through the downstroke, tucked mid-upstroke.
      expect(flapPose(flight.downstroke / 2, flight, pose()).fold).toBe(0)
      const midUp = flapPose((1 + flight.downstroke) / 2, flight, pose())
      expect(midUp.fold).toBeGreaterThan(0.2 * flight.fold)
      // The hand lags: up on the downstroke, down on the upstroke.
      expect(flapPose(flight.downstroke / 2, flight, pose()).wrist).toBeGreaterThan(0)
      expect(midUp.wrist).toBeLessThan(0)
      // Continuous across the beat's ends and its turn at the bottom.
      for (const at of [0, flight.downstroke, 1]) {
        const a = flapPose(at - 1e-4, flight, pose()),
          b = flapPose(at + 1e-4, flight, pose())
        expect(Math.abs(a.shoulder - b.shoulder)).toBeLessThan(1e-3)
      }
    }
  })

  it('alternates bursts and glides, and never glides a mallard', () => {
    for (const name of BIRD_SPECIES) {
      const { widest, finite } = glideShare(name)
      expect(finite).toBe(true)
      expect(widest).toBeLessThan(1.2)
    }
    expect(glideShare('mallard').share).toBe(0)
    expect(glideShare('gull').share).toBeGreaterThan(0.4)
    expect(glideShare('crow').share).toBeGreaterThan(0.1)
    expect(glideShare('crow').share).toBeLessThan(0.5)
  })

  it('does not glide while climbing', () => {
    const { flight } = SPECIES.gull
    const wing: WingState = { phase: 0, beats: 1, gliding: 0, glide: 0, rate: 1 }
    const random = flockRandom(5)
    for (let t = 0; t < 5; t += 1 / 60) {
      stepWing(wing, flight, 1 / 60, true, random, pose())
      expect(wing.gliding).toBe(0)
    }
  })
})

describe('bird geometry', () => {
  it('builds every species with the same layout, symmetric, wings up-facing', () => {
    for (const name of BIRD_SPECIES) {
      const { shape } = SPECIES[name]
      const out = writeBird(shape)
      expect(out.position).toHaveLength(BIRD_VERTICES * 3)
      let lowestWingNormal = 1,
        minX = 0,
        maxX = 0,
        minZ = 0,
        maxZ = 0
      for (let i = 0; i < BIRD_VERTICES; i++) {
        const x = out.position[i * 3] ?? 0,
          z = out.position[i * 3 + 2] ?? 0
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minZ = Math.min(minZ, z)
        maxZ = Math.max(maxZ, z)
        const ny = out.normal[i * 3 + 1] ?? 0
        // Wing panels face up at rest; normals are unit length.
        if ((out.wing[i * 4 + 3] ?? 0) > 0) lowestWingNormal = Math.min(lowestWingNormal, ny)
        const length = Math.hypot(out.normal[i * 3] ?? 0, ny, out.normal[i * 3 + 2] ?? 0)
        expect(length).toBeCloseTo(1, 5)
      }
      expect(lowestWingNormal).toBeGreaterThan(0.95)
      expect(maxX - minX).toBeCloseTo(shape.span, 5)
      expect(maxX).toBeCloseTo(-minX, 5)
      // Bill to tail within a few centimetres of the species' length.
      expect(maxZ - minZ).toBeGreaterThan(shape.length * 0.8)
      expect(maxZ - minZ).toBeLessThan(shape.length * 1.35)
    }
  })
})

describe('bird pose bounds', () => {
  it('keeps every vertex of every species within the bird in every pose', () => {
    const at = { x: 0, y: 0, z: 0 }
    for (const name of BIRD_SPECIES) {
      const { shape, flight } = SPECIES[name]
      const buffers = writeBird(shape)
      // The rest pose's bounding radius about the chest, plus the shoulder's offset from the
      // axis: the hinges only turn the wing about the shoulder, so nothing reaches farther.
      let rest = 0
      for (let i = 0; i < BIRD_VERTICES; i++)
        rest = Math.max(
          rest,
          Math.hypot(
            buffers.position[i * 3] ?? 0,
            buffers.position[i * 3 + 1] ?? 0,
            buffers.position[i * 3 + 2] ?? 0,
          ),
        )
      const radius = rest + shape.girth
      expect(rest).toBeLessThan(Math.max(shape.span / 2, shape.length) * 1.15)
      let farthest = 0,
        finite = true
      const poses: WingPose[] = []
      for (let phase = 0; phase < 1; phase += 0.01) poses.push(flapPose(phase, flight, pose()))
      for (const shoulder of [-1.2, -0.4, 0, 0.4, 1.2])
        for (const wrist of [-1.2, -0.4, 0, 0.4, 1.2])
          for (const fold of [0, 0.5, 1]) poses.push({ shoulder, wrist, fold })
      for (const p of poses)
        for (let i = 0; i < BIRD_VERTICES; i++) {
          hingedVertex(buffers, i, p, at)
          finite &&= Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.z)
          farthest = Math.max(farthest, Math.hypot(at.x, at.y, at.z))
        }
      expect(finite).toBe(true)
      expect(farthest).toBeLessThanOrEqual(radius)
    }
  })
})

import { describe, expect, it } from 'vitest'

import {
  THUNDER_BYTES,
  THUNDER_RATE,
  THUNDER_SECONDS,
  THUNDER_VARIANTS,
  thunderLevel,
  thunderSamples,
  thunderVariant,
  thunderVoicing,
} from './thunder'

const sequence = (seed: number) => {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4_294_967_296
  }
}
const energy = (samples: Float32Array, from: number, to: number) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2
  return sum / Math.max(1, to - from)
}
/** Mean absolute difference between neighbours: a rough measure of high-frequency content. */
const roughness = (samples: Float32Array) => {
  let sum = 0
  for (let i = 1; i < samples.length; i++)
    sum += Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0))
  return sum / samples.length
}

describe('thunder', () => {
  it('renders a peak-normalised peal that dies away', () => {
    const rate = 8000
    const samples = thunderSamples(rate, 1500, sequence(3))
    expect(samples.length).toBe(THUNDER_SECONDS * rate)
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    expect(peak).toBeCloseTo(1, 6)
    for (const value of samples) expect(Number.isFinite(value)).toBe(true)
    // The last second is much quieter than the first three.
    expect(energy(samples, 4 * rate, 5 * rate)).toBeLessThan(energy(samples, 0, 3 * rate) / 4)
  })

  it('loses its crack and highs with distance', () => {
    const rate = 8000
    const near = thunderSamples(rate, 1000, sequence(5))
    const far = thunderSamples(rate, 7000, sequence(5))
    expect(roughness(far)).toBeLessThan(roughness(near))
    expect(thunderLevel(1000, 1)).toBeCloseTo(1, 9)
    expect(thunderLevel(6000, 1)).toBeLessThan(thunderLevel(2000, 1))
    expect(thunderLevel(Number.NaN, 1)).toBe(0)
    expect(thunderLevel(2000, -1)).toBe(0)
  })

  it('starts each peal from silence and keeps the decimated envelope smooth', () => {
    const samples = thunderSamples(THUNDER_RATE, 5200, sequence(9))
    expect(samples[0]).toBe(0)
    // No step at the envelope's control-rate boundaries: neighbours stay close.
    let jump = 0
    for (let i = 1; i < samples.length; i++)
      jump = Math.max(jump, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)))
    expect(jump).toBeLessThan(0.2)
  })

  it('shares three pre-rendered peals and varies each strike', () => {
    expect(THUNDER_BYTES).toBe(THUNDER_VARIANTS.length * THUNDER_SECONDS * THUNDER_RATE * 4)
    expect(thunderVariant(800)).toBe(0)
    expect(thunderVariant(2400)).toBe(1)
    expect(thunderVariant(8000)).toBe(2)
    expect(thunderVariant(Number.NaN)).toBe(1)
    const near = thunderVoicing(1000, () => 0.5),
      far = thunderVoicing(7000, () => 0.5)
    expect(near.cutoff).toBeGreaterThan(far.cutoff)
    expect(near.rate).toBeCloseTo(0.97)
    expect(thunderVoicing(1000, () => 0).rate).toBeCloseTo(0.82)
    expect(thunderVoicing(1000, () => 0.999).rate).toBeLessThan(1.12)
  })
})

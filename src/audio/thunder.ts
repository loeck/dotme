import { unit } from './units'

/** Seconds of rumble rendered for one peal. */
export const THUNDER_SECONDS = 5
/**
 * Sample rate of the rendered peals. Thunder lives below 350 Hz, so 8 kHz holds all of it at a
 * quarter of the memory and work of the context's 32 kHz; the source resamples on playback.
 */
export const THUNDER_RATE = 8000
/** Distances of the pre-rendered peals: near with a crack, middle, and a far low rumble. */
export const THUNDER_VARIANTS = [1200, 2600, 5200] as const
/** Decoded size of all pre-rendered peals, for the mixer's memory budget. */
export const THUNDER_BYTES = THUNDER_VARIANTS.length * THUNDER_SECONDS * THUNDER_RATE * 4
/** The envelope is evaluated once per this many samples and interpolated in between. */
const ENVELOPE_STEP = 32

export type ThunderEvent = Readonly<{
  /** Metres from the viewer. */
  distance: number
  /** Seconds from now until the sound arrives. */
  delay: number
  /** 0–1, before distance attenuation. */
  intensity: number
  pan: number
}>

/**
 * One peal of thunder as mono samples, peak-normalised to 1. Brown noise shaped into a crack
 * and a few rolling swells that die away; distance takes the crack and the high end away, as
 * air does, so a far strike is only a low rumble. The envelope runs at a decimated control rate,
 * so a peal costs a few multiplications per sample rather than a handful of `Math.exp` calls.
 */
export function thunderSamples(
  sampleRate: number,
  distance: number,
  random: () => number = Math.random,
): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.round(THUNDER_SECONDS * sampleRate))
  const samples = new Float32Array(length)
  const near = unit((3000 - distance) / 2000)
  // One-pole low-pass cut-offs, in Hz: air absorbs the highs of a far strike.
  const smoothing = (cutoff: number) => 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)
  const body = smoothing(90 + 260 * near),
    floor = smoothing(30)
  const rolls = Array.from({ length: 3 + Math.floor(random() * 4) }, () => ({
    at: 0.25 + random() * 2.6,
    width: 0.25 + random() * 0.6,
    level: 0.35 + random() * 0.65,
  }))
  const envelopeAt = (t: number) => {
    let envelope = near * Math.exp(-t / 0.18) * Math.min(1, t / 0.008)
    for (const roll of rolls)
      envelope += roll.level * Math.exp(-(((t - roll.at) / roll.width) ** 2))
    return envelope * Math.exp(-t / 2.2) * Math.min(1, t / 0.03)
  }
  let brown = 0,
    low = 0,
    peak = 0
  let from = 0,
    to = envelopeAt(0)
  for (let i = 0; i < length; i++) {
    const step = i % ENVELOPE_STEP
    if (step === 0) {
      from = to
      to = envelopeAt((i + ENVELOPE_STEP) / sampleRate)
    }
    const envelope = from + (to - from) * (step / ENVELOPE_STEP)
    brown += body * (random() * 2 - 1 - brown)
    low += floor * (brown - low)
    const value = (brown * 0.7 + low * 2.4) * envelope
    samples[i] = value
    peak = Math.max(peak, Math.abs(value))
  }
  if (peak > 0) for (let i = 0; i < length; i++) samples[i] = (samples[i] ?? 0) / peak
  return samples
}

/** Index of the pre-rendered peal closest (in log distance) to a strike. */
export function thunderVariant(distance: number) {
  const target = Math.log(Math.max(1, Number.isFinite(distance) ? distance : 3000))
  let best = 0
  THUNDER_VARIANTS.forEach((variant, index) => {
    if (
      Math.abs(Math.log(variant) - target) <
      Math.abs(Math.log(THUNDER_VARIANTS[best] ?? 1) - target)
    )
      best = index
  })
  return best
}

/**
 * Per-strike variation of a shared peal: a slightly different pitch (and so length), and a
 * low-pass cut-off that falls with distance like the rendered body (350 Hz near, 90 Hz far).
 */
export function thunderVoicing(distance: number, random: () => number = Math.random) {
  const near = unit((3000 - (Number.isFinite(distance) ? distance : 3000)) / 2000)
  return { rate: 0.82 + random() * 0.3, cutoff: 140 + 360 * near + random() * 80 }
}

/** Loudness of a strike's thunder at the viewer: about 1 at one kilometre, quieter beyond. */
export function thunderLevel(distance: number, intensity: number) {
  if (!Number.isFinite(distance) || !Number.isFinite(intensity)) return 0
  return unit(intensity) * Math.min(1, 1000 / Math.max(1000, distance)) ** 0.8
}

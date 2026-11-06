/** Seconds of rumble rendered for one strike. */
export const THUNDER_SECONDS = 5

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
 * air does, so a far strike is only a low rumble.
 */
export function thunderSamples(
  sampleRate: number,
  distance: number,
  random: () => number = Math.random,
): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.round(THUNDER_SECONDS * sampleRate))
  const samples = new Float32Array(length)
  const near = Math.max(0, Math.min(1, (3000 - distance) / 2000))
  // One-pole low-pass cut-offs, in Hz: air absorbs the highs of a far strike.
  const smoothing = (cutoff: number) => 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)
  const body = smoothing(90 + 260 * near),
    floor = smoothing(30)
  const rolls = Array.from({ length: 3 + Math.floor(random() * 4) }, () => ({
    at: 0.25 + random() * 2.6,
    width: 0.25 + random() * 0.6,
    level: 0.35 + random() * 0.65,
  }))
  let brown = 0,
    low = 0,
    peak = 0
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    brown += body * (random() * 2 - 1 - brown)
    low += floor * (brown - low)
    let envelope = near * Math.exp(-t / 0.18) * Math.min(1, t / 0.008)
    for (const roll of rolls)
      envelope += roll.level * Math.exp(-(((t - roll.at) / roll.width) ** 2))
    envelope *= Math.exp(-t / 2.2) * Math.min(1, t / 0.03)
    const value = (brown * 0.7 + low * 2.4) * envelope
    samples[i] = value
    peak = Math.max(peak, Math.abs(value))
  }
  if (peak > 0) for (let i = 0; i < length; i++) samples[i] = (samples[i] ?? 0) / peak
  return samples
}

/** Loudness of a strike's thunder at the viewer: about 1 at one kilometre, quieter beyond. */
export function thunderLevel(distance: number, intensity: number) {
  if (!Number.isFinite(distance) || !Number.isFinite(intensity)) return 0
  return Math.max(0, Math.min(1, intensity)) * Math.min(1, 1000 / Math.max(1000, distance)) ** 0.8
}

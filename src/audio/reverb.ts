/** Length of the synthesised impulse response, seconds. */
export const REVERB_SECONDS = 2.5

/** Decoded size of the stereo impulse at a context's sample rate, for the memory budget. */
export const reverbBytes = (sampleRate: number) => Math.round(REVERB_SECONDS * sampleRate) * 2 * 4

/** A small seeded generator, so every page builds the same room and tests stay deterministic. */
function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4_294_967_296
  }
}

/**
 * A stereo impulse response for an open lakeside: decorrelated white noise in each ear under an
 * exponential decay of about 60 dB over the impulse, a few milliseconds of pre-delay and a
 * one-pole low-pass that closes as the tail decays, as air and foliage swallow the highs of
 * late reflections. Built once per mixer with multiplications only.
 */
export function reverbImpulse(
  sampleRate: number,
  random: () => number = seeded(0x51ce),
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = Math.max(1, Math.round(REVERB_SECONDS * sampleRate))
  const predelay = Math.round(0.012 * sampleRate)
  // exp(-6.9) is -60 dB at the end of the impulse.
  const decay = Math.exp(-6.9 / length)
  const channel = () => {
    const samples = new Float32Array(length)
    let level = 1,
      smooth = 0,
      // Low-pass coefficient: bright at first, darker towards the tail.
      openness = 0.9
    const closing = Math.exp(Math.log(0.12 / 0.9) / length)
    for (let i = predelay; i < length; i++) {
      smooth += openness * (random() * 2 - 1 - smooth)
      samples[i] = smooth * level * 0.5
      level *= decay
      openness *= closing
    }
    return samples
  }
  return [channel(), channel()]
}

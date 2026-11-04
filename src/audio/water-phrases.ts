/** Pick fresh passages from the long recording without pitch shifts or hard cuts. */
export function waterPhrase(duration: number, previousOffset: number, random = Math.random) {
  const length = Math.min(duration, 24 + random() * 12)
  const available = Math.max(0, duration - length)
  let offset = random() * available
  // Avoid immediately revisiting the same opening splash. Picking the opposite
  // end of the available range avoids an unbounded retry loop.
  if (available >= 24 && Math.abs(offset - previousOffset) < 8)
    offset = (previousOffset < available / 2 ? (available * 5) / 6 : 0) + (random() * available) / 6
  return { offset, duration: length, fade: duration > 24 ? 4 : 1.5 }
}

/**
 * A random passage of a shorter loop (wind, rain, insects, waterfall): half to most of the
 * recording, at a fresh offset, so consecutive passages never line up into an audible period.
 */
export function loopPhrase(duration: number, previousOffset: number, random = Math.random) {
  const length = duration * (0.5 + random() * 0.35)
  const available = Math.max(0, duration - length)
  let offset = random() * available
  if (available >= 6 && Math.abs(offset - previousOffset) < 3)
    offset = previousOffset < available / 2 ? available - random() * 2 : random() * 2
  return { offset, duration: length, fade: Math.min(3, length / 4) }
}

/** One window of a recording that holds several separate calls; never the same one twice. */
export function pickPhrase(phrases: readonly unknown[], previous: number, random = Math.random) {
  if (phrases.length < 2) return 0
  if (previous < 0 || previous >= phrases.length) return Math.floor(random() * phrases.length)
  const index = Math.floor(random() * (phrases.length - 1))
  return index >= previous ? index + 1 : index
}

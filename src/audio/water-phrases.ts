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

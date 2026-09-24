/** Budget input in CSS pixels: perspective must not turn vertical hover into a trench. */
export function waterStroke(pixels: number, seconds: number, distance: number, dragging: boolean) {
  const radius = dragging ? 0.7 : 0.55
  const samples = Math.max(1, Math.min(48, Math.ceil(distance / (radius * 0.5))))
  const speed = pixels / Math.max(1 / 120, seconds)
  const response = 0.4 + 0.6 * (1 - Math.exp(-speed / 420))
  // Bound a coalesced event as well as its individual splats. Spreading the
  // budget over a longer projected path must not create more displaced water.
  const budget = Math.min(pixels, 80) * (dragging ? 0.014 : 0.0035) * response
  return { radius, samples, velocity: -budget / samples }
}

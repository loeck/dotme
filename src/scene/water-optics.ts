/** An artistic weather response, not a measurement of local water quality.
 * Clouds already affect illumination; rain adds suspended haze and wind roughens
 * the surface without pretending that an overcast sky makes the lake muddy. */
export function sampleWaterOptics(rainIntensity: number, windSpeed: number) {
  const rain = Number.isFinite(rainIntensity) ? Math.max(0, Math.min(1, rainIntensity)) : 0
  const wind = Number.isFinite(windSpeed) ? Math.max(0, Math.min(1, windSpeed / 9)) : 0
  return {
    clarity: 1 - rain * 0.58,
    agitation: Math.min(1, wind * 0.55 + rain * 0.65),
  }
}

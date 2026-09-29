/** An artistic weather response, not a measurement of local water quality.
 * Rain adds suspended haze and wind roughens the surface; cloud cover mutes
 * light penetration so overcast water reads steel-grey instead of tropical. */
export function sampleWaterOptics(rainIntensity: number, windSpeed: number, diffuse = 1) {
  const rain = Number.isFinite(rainIntensity) ? Math.max(0, Math.min(1, rainIntensity)) : 0
  const wind = Number.isFinite(windSpeed) ? Math.max(0, Math.min(1, windSpeed / 9)) : 0
  const cover = Number.isFinite(diffuse) ? Math.max(0, Math.min(1, diffuse)) : 1
  return {
    clarity: (1 - rain * 0.58) * (0.3 + 0.7 * cover ** 1.5),
    agitation: Math.min(1, wind * 0.55 + rain * 0.65),
  }
}

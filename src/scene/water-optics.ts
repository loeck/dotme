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

/** An artistic clear-water window shared by the surface and submerged fish.
 * Keep the distant grazing reflection while opening the nearby water column. */
export const WATER_INTERFACE_GLSL = `
float waterReflectance(float fresnel, float distanceToCamera, float clarity) {
  float window = (1.0 - smoothstep(30.0, 85.0, distanceToCamera)) * clarity;
  return mix(fresnel, min(fresnel, 0.24), window);
}
`

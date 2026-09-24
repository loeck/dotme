/** Shared engine state; independent of rendering and weather fetching. */
export type AmbientEnvironment = Readonly<{
  solarHour: number
  daylight: number
  windSpeed: number
  rainIntensity: number
  waterfall?: Readonly<{ intensity: number; pan: number }>
}>
const unit = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

/** Relative loudness and stereo position of a finite, distant water source. */
export function waterfallSound(width: number, height: number, distance: number, screenX: number) {
  const power = unit(Math.sqrt((Math.max(0, width) * Math.max(0, height)) / 3.6))
  const attenuation = Number.isFinite(distance)
    ? 1 / Math.sqrt(1 + (Math.max(0, distance) / 28) ** 2)
    : 0
  return {
    intensity: power * attenuation,
    pan: Number.isFinite(screenX) ? Math.max(-0.75, Math.min(0.75, screenX * 0.7)) : 0,
  }
}

export function ambientMix(environment: AmbientEnvironment) {
  const day = unit(environment.daylight),
    rain = unit(environment.rainIntensity)
  const wind = unit(environment.windSpeed / 12),
    wildlife = 1 - rain * 0.9
  const waterfall = unit(environment.waterfall?.intensity ?? 0)
  return {
    water: (0.14 + wind * 0.035) * (1 - rain * 0.45) * (1 - waterfall * 0.15),
    waterfall: waterfall * 0.26 * (1 - rain * 0.4),
    wind: 0.04 + wind * 0.16,
    rain: rain * 0.42,
    insects: (1 - day) * wildlife * 0.1,
    birds: day * wildlife * 0.12,
  }
}

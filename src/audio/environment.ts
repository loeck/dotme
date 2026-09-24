/** Shared engine state; independent of rendering and weather fetching. */
export type AmbientEnvironment = Readonly<{
  solarHour: number
  daylight: number
  windSpeed: number
  rainIntensity: number
}>
const unit = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)
export function ambientMix(environment: AmbientEnvironment) {
  const day = unit(environment.daylight),
    rain = unit(environment.rainIntensity)
  const wind = unit(environment.windSpeed / 12),
    wildlife = 1 - rain * 0.9
  return {
    water: 0.3 + wind * 0.08,
    wind: 0.04 + wind * 0.16,
    rain: rain * 0.3,
    insects: (1 - day) * wildlife * 0.08,
    birds: day * wildlife * 0.12,
  }
}

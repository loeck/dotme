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

/**
 * Twilight song: birds sing hardest while the morning light comes up (the dawn chorus) and
 * again, more briefly, as it fades. Keyed on daylight rather than the clock, so it follows the
 * season's sunrise; zero at night, in full day and in rain.
 */
export function birdChorus(environment: AmbientEnvironment) {
  const light = unit(environment.daylight)
  const twilight = unit(1 - Math.abs(light - 0.4) / 0.4)
  const hour = ((environment.solarHour % 24) + 24) % 24
  return twilight * (hour < 12 ? 1 : 0.45) * (1 - unit(environment.rainIntensity))
}

/** Distance attenuation and stereo position of a small sound on the lake. */
export function pointSound(distance: number, screenX: number) {
  return {
    attenuation: Number.isFinite(distance)
      ? 1 / Math.sqrt(1 + (Math.max(0, distance) / 14) ** 2)
      : 0,
    pan: Number.isFinite(screenX) ? Math.max(-0.85, Math.min(0.85, screenX * 0.8)) : 0,
  }
}

export function ambientMix(environment: AmbientEnvironment) {
  const day = unit(environment.daylight),
    rain = unit(environment.rainIntensity)
  const wind = unit(environment.windSpeed / 12),
    wildlife = 1 - rain * 0.9
  const waterfall = unit(environment.waterfall?.intensity ?? 0)
  const chorus = birdChorus(environment)
  const night = 1 - day
  return {
    water: (0.14 + wind * 0.035) * (1 - rain * 0.45) * (1 - waterfall * 0.15),
    waterfall: waterfall * 0.26 * (1 - rain * 0.4),
    wind: 0.04 + wind * 0.16,
    rain: rain * 0.42,
    insects: night * wildlife * 0.1,
    // Day birds fade in through dawn; the chorus lifts them a little above the midday level.
    birds: Math.max(unit((day - 0.3) / 0.4), chorus * 1.25) * wildlife * 0.12,
    // Owls call only in a dry, properly dark night.
    owls: night * night * (1 - rain) * (1 - wind * 0.5) * 0.12,
  }
}

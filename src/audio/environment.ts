import { clampPan, finiteOr, smoothstep, unit } from './units'

/**
 * Weather the scene does not simulate itself but the sound follows: set once from the scene's
 * weather (and again when a weather refresh lands). Every field is optional; a missing value
 * leaves the mix as it was before weather data reached the sound.
 */
export type AmbientWeather = Readonly<{
  /** Air temperature, °C. Crickets fall silent below about 10 °C. */
  temperature?: number
  /** 0–1: fog density from WMO fog codes and visibility. Damps the highs and the birds. */
  fog?: number
  /** 0–1: snowfall. Damps like fog and silences the rain bed. */
  snow?: number
  /** A thunderstorm is reported, whatever the rain. */
  storm?: boolean
  /**
   * 0–1: how deep in winter the scene's season is (`season.ts`). Thins the birdsong and
   * silences the crickets; missing keeps the summer mix.
   */
  winter?: number
}>

/** Shared engine state; independent of rendering and weather fetching. */
export type AmbientEnvironment = AmbientWeather &
  Readonly<{
    solarHour: number
    daylight: number
    windSpeed: number
    rainIntensity: number
    waterfall?: Readonly<{ intensity: number; pan: number }>
    /**
     * Stereo position (-1 left … 1 right) the wind blows from, relative to the camera; see
     * `windPanFromCamera`. Missing keeps the wind bed centred.
     */
    windPan?: number
    /** Reduced motion: no lightning, so storms rumble on their own in the distance. */
    reducedMotion?: boolean
  }>

/** Relative loudness and stereo position of a finite, distant water source. */
export function waterfallSound(width: number, height: number, distance: number, screenX: number) {
  const power = unit(Math.sqrt((Math.max(0, width) * Math.max(0, height)) / 3.6))
  const attenuation = Number.isFinite(distance)
    ? 1 / Math.sqrt(1 + (Math.max(0, distance) / 28) ** 2)
    : 0
  return { intensity: power * attenuation, pan: clampPan(finiteOr(screenX, 0) * 0.7, 0.75) }
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
    pan: clampPan(finiteOr(screenX, 0) * 0.8, 0.85),
  }
}

/** How much fog or falling snow muffles the landscape, 0–1. */
const damping = (environment: AmbientEnvironment) =>
  Math.max(unit(environment.fog ?? 0), unit(environment.snow ?? 0))

/** Crickets need warmth: silent below 8 °C, full above 12 °C; unknown temperature sings. */
export function insectWarmth(temperature: number | undefined) {
  return temperature === undefined || !Number.isFinite(temperature)
    ? 1
    : smoothstep(8, 12, temperature)
}

/**
 * Cricket chirp rate follows temperature (Dolbear's law): playback speeds up gently in the warm
 * and slows in the cool, around the recording's own rate at 20 °C.
 */
export function insectRate(temperature: number | undefined) {
  if (temperature === undefined || !Number.isFinite(temperature)) return 1
  return Math.max(0.9, Math.min(1.15, 1 + (temperature - 20) * 0.012))
}

export function ambientMix(environment: AmbientEnvironment) {
  const day = unit(environment.daylight),
    rain = unit(environment.rainIntensity)
  const wind = unit(environment.windSpeed / 12),
    wildlife = 1 - rain * 0.9
  const waterfall = unit(environment.waterfall?.intensity ?? 0)
  const chorus = birdChorus(environment)
  const night = 1 - day
  const muffled = 1 - damping(environment) * 0.6
  const winter = unit(environment.winter ?? 0)
  // Rain loudness grows roughly with the square root of the drop rate, and masks the water and
  // the waterfall as it is heard, not as it is measured. Snow falls silently.
  const patter = Math.sqrt(rain) * (1 - unit(environment.snow ?? 0))
  return {
    water: (0.14 + wind * 0.035) * (1 - patter * 0.45) * (1 - waterfall * 0.15),
    waterfall: waterfall * 0.26 * (1 - patter * 0.4),
    wind: 0.04 + wind * 0.16,
    rain: patter * 0.42,
    insects: night * wildlife * 0.1 * insectWarmth(environment.temperature) * (1 - winter),
    // Day birds fade in through dawn; the chorus lifts them a little above the midday level.
    birds:
      Math.max(unit((day - 0.3) / 0.4), chorus * 1.25) *
      wildlife *
      0.12 *
      muffled *
      (1 - winter * 0.6),
    // Owls call only in a dry, properly dark night.
    owls: night * night * (1 - rain) * (1 - wind * 0.5) * 0.12 * muffled,
  }
}

/**
 * Filter and space settings that follow the weather: the rain bed opens from a distant hiss to
 * the full patter with intensity, fog and snow cut the master's highs, and the reverb return
 * grows wetter at night (and a little in fog).
 */
export function ambientTone(environment: AmbientEnvironment) {
  const rain = unit(environment.rainIntensity)
  const damp = damping(environment)
  return {
    /** Low-pass cut-off of the rain bed, Hz: 1.2 kHz in a drizzle to 11 kHz in a downpour. */
    rainCutoff: 1200 * (11_000 / 1200) ** rain,
    /** Master high-shelf gain above 2 kHz, dB: 0 in clear air, -14 dB in thick fog or snow. */
    masterShelf: -14 * damp,
    /** Reverb return level. */
    reverb: 0.14 + 0.16 * (1 - unit(environment.daylight)) + 0.06 * unit(environment.fog ?? 0),
    insectRate: insectRate(environment.temperature),
    windPan: clampPan(environment.windPan ?? 0) * 0.6,
  }
}

/** Seconds until the next distant rumble of a storm heard but not seen (reduced motion). */
export function rumbleGap(random = Math.random) {
  return 18 + random() * 30
}

/** Whether the environment is stormy enough for lightning, as the scene decides it. */
export function stormy(environment: AmbientEnvironment) {
  return environment.storm === true || unit(environment.rainIntensity) >= 0.75
}

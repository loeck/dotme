import { Color, Vector3 } from 'three'

import {
  eyeAdaptation,
  horizonRadiance,
  refraction,
  skyIrradiance,
  SKY_EXPOSURE,
} from './atmosphere'
import { EARTH, luminance, transmittance } from './atmosphere-physics'
import type { Rgb } from './atmosphere-physics'
import { DEFAULT_SOLAR, wrapDay } from './solar-clock'
import type { SolarEndpoints } from './solar-clock'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Real-time adaptation stays gradual even when the solar clock is accelerated. */
export function fadeNightLight(current: number, target: number, dt: number, frozen = false) {
  if (frozen) return target
  const value = current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / 0.9))
  return Math.abs(value - target) < 0.0001 ? target : value
}

const CLOUD_HEIGHT = 2
const NOON_SUN = transmittance(EARTH.viewerHeight, 0.85)[0]
const NOON_AMBIENT = 0.4185 / luminance(skyIrradiance(0.85))
const CLOUD_AMBIENT = 0.135 / luminance(skyIrradiance(0.85))
const scaled = (c: Rgb, scale: number) =>
  new Color().setRGB(c[0] * scale, c[1] * scale, c[2] * scale)
/** Sky irradiance is bluer than lit surroundings perceive; keep its luminance. */
const skyLight = (c: Rgb, scale: number) => {
  const grey = luminance(c)
  return new Color()
    .setRGB(grey, grey, grey)
    .lerp(new Color().setRGB(c[0], c[1], c[2]), 0.45)
    .multiplyScalar(scale)
}

/** Artistic orbit between sunrise and sunset. Directions always point FROM the scene TO the light. */
export function sampleLighting(
  initialSeconds: number,
  elapsed = 0,
  weather: WeatherPreset = 'partly-cloudy',
  solar: SolarEndpoints = DEFAULT_SOLAR,
) {
  const span = solar.sunset - solar.sunrise
  const endpoints = span > 0 && span < 86_400 ? solar : DEFAULT_SOLAR
  const now = wrapDay(initialSeconds + elapsed)
  const dayLength = endpoints.sunset - endpoints.sunrise
  const angle =
    now >= endpoints.sunrise && now < endpoints.sunset
      ? ((now - endpoints.sunrise) / dayLength) * Math.PI
      : Math.PI + (wrapDay(now - endpoints.sunset) / (86_400 - dayLength)) * Math.PI
  // The rising bearing crosses the open valley, so the morning disc can enter
  // the camera before climbing out of view. The two orbit axes are orthogonal.
  const bearing = 0.36
  const horizontal = Math.sin(angle) * Math.sqrt(1 - 0.85 ** 2)
  const sunDirection = new Vector3(
    Math.sin(bearing) * Math.cos(angle) - Math.cos(bearing) * horizontal,
    Math.sin(angle) * 0.85,
    -Math.cos(bearing) * Math.cos(angle) - Math.sin(bearing) * horizontal,
  ).normalize()
  const height = sunDirection.y
  const daylight = smooth(-0.12, 0.12, height)
  const adaptation = eyeAdaptation(height)
  const sunIntensity = 4.5 * smooth(0, Math.sin((2 * Math.PI) / 180), height)
  const moonIntensity = 1.4 * (1 - smooth(-0.12, 0, height))
  const moonDirection = sunDirection.clone().negate()
  // Direct sunlight is the atmosphere's own transmittance, ozone included.
  const sunColor = scaled(transmittance(EARTH.viewerHeight, height), adaptation / NOON_SUN)
  const { lift, flattening } = refraction(height)
  const flat = Math.hypot(sunDirection.x, sunDirection.z),
    apparentElevation = Math.asin(height) + lift
  const sunApparent = new Vector3(
    (sunDirection.x / flat) * Math.cos(apparentElevation),
    Math.sin(apparentElevation),
    (sunDirection.z / flat) * Math.cos(apparentElevation),
  )
  const sunDisc = scaled(
    transmittance(EARTH.viewerHeight, sunApparent.y),
    (54 * adaptation) / NOON_SUN,
  )
  const direction = height >= 0 ? sunDirection : moonDirection
  const color = height >= 0 ? sunColor : new Color(0xa3bfd6)
  const intensity = height >= 0 ? sunIntensity : moonIntensity
  const night = 1 - daylight
  const diffuse = WEATHER[weather].diffuse
  const irradiance = skyIrradiance(height)
  const ambient = new Color()
    .setRGB(0.016 * night, 0.024 * night, 0.038 * night)
    .add(skyLight(irradiance, NOON_AMBIENT * adaptation))
    .multiplyScalar(diffuse)
  const ambientLuminance = ambient.r * 0.2126 + ambient.g * 0.7152 + ambient.b * 0.0722
  // Use the shared ambient illumination, including weather, rather than fixed hours.
  const localLightStrength = 1 - smooth(0.03, 0.15, ambientLuminance)
  // Cursor illumination starts only after the sky's daylight transition ends.
  const pointerLightStrength = 1 - smooth(-0.24, -0.12, height)
  // Cloud decks keep the sun a little after the ground loses it: the afterglow.
  const cloudSun = transmittance(CLOUD_HEIGHT, height),
    cloudLit = cloudSun[0] > 0
  const cloudDirection = cloudLit
    ? new Vector3(sunDirection.x, Math.max(height, 0.02), sunDirection.z).normalize()
    : moonDirection
  const cloudShare = 0.026 + daylight * 0.24
  const cloudDirect = cloudLit
    ? scaled(cloudSun, ((4.5 * adaptation) / NOON_SUN) * cloudShare)
    : new Color(0xa3bfd6).multiplyScalar(moonIntensity * cloudShare * smooth(-0.025, -0.08, height))
  const skyExposure = SKY_EXPOSURE * adaptation
  const nightHaze = new Color().setRGB(0.007 * night, 0.014 * night, 0.023 * night)
  return {
    localLightStrength,
    pointerLightStrength,
    ambientLuminance,
    sunDirection,
    sunApparent,
    sunFlattening: flattening,
    sunDisc,
    moonDirection,
    sunColor,
    sunIntensity,
    moonIntensity,
    daylight,
    skyExposure,
    direction,
    color,
    intensity,
    ambient,
    haze: nightHaze.clone().add(scaled(horizonRadiance(height), skyExposure * 0.5)),
    nightHaze,
    waterScatter: new Color()
      .setRGB(0.0012, 0.007, 0.015)
      .lerp(new Color().setRGB(0.02, 0.3, 0.33), daylight),
    cloudAmbient: new Color()
      .setRGB(0.006 * night, 0.009 * night, 0.015 * night)
      .add(skyLight(irradiance, CLOUD_AMBIENT * adaptation))
      .multiplyScalar(diffuse),
    cloudDirection,
    cloudDirect,
  }
}
export type LightingState = ReturnType<typeof sampleLighting>

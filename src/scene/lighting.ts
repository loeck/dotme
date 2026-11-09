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
import { smoothstep as smooth } from './math'
import { DEFAULT_SOLAR, wrapDay } from './solar-clock'
import type { SolarEndpoints } from './solar-clock'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'

/** Morning mist that veils low sun under cloud cover and burns off as it climbs. */
export function mistFactor(sunHeight: number, diffuse: number) {
  return (1 - smooth(0, 0.35, sunHeight)) * (1 - diffuse)
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
const GREY = new Color()
const SKY = new Color()
const scaled = (target: Color, c: Rgb, scale: number) =>
  target.setRGB(c[0] * scale, c[1] * scale, c[2] * scale)
const desaturate = (color: Color, amount: number) => {
  const grey = luminance([color.r, color.g, color.b])
  return color.lerp(GREY.setRGB(grey, grey, grey), amount)
}
/** Sky irradiance is bluer than lit surroundings perceive; keep its luminance. */
const skyLight = (c: Rgb, scale: number) => {
  const grey = luminance(c)
  return SKY.setRGB(grey, grey, grey)
    .lerp(GREY.setRGB(c[0], c[1], c[2]), 0.45)
    .multiplyScalar(scale)
}
const MOONLIGHT = new Color(0xa3bfd6)

/** Fresh storage for `sampleLighting`; a frame loop passes one back to avoid allocating. */
export function createLightingState() {
  return {
    localLightStrength: 0,
    pointerLightStrength: 0,
    ambientLuminance: 0,
    sunDirection: new Vector3(),
    sunApparent: new Vector3(),
    sunFlattening: 1,
    sunDisc: new Color(),
    moonDirection: new Vector3(),
    sunColor: new Color(),
    sunIntensity: 0,
    moonIntensity: 0,
    daylight: 0,
    skyExposure: 0,
    direction: new Vector3(),
    color: new Color(),
    intensity: 0,
    ambient: new Color(),
    haze: new Color(),
    nightHaze: new Color(),
    waterScatter: new Color(),
    cloudAmbient: new Color(),
    cloudDirection: new Vector3(),
    cloudDirect: new Color(),
    weatherDiffuse: 0,
  }
}
export type LightingState = ReturnType<typeof createLightingState>

/** How far the noon sun swings round from the frame's centre, radians. */
const MIDDAY_SWING = 2.25

/** Half-width of the moon's sweep across the frame, radians of azimuth either side of centre. */
export const MOON_SWEEP = 0.3
/** Moon elevation (sine) at the ends of the night and its rise at midnight. */
const MOON_LOW = 0.08
const MOON_RISE = 0.28

/**
 * The moon is staged rather than opposite the sun: over the night it crosses the open valley
 * from the right ridge to the left, a few degrees up at dusk and about 21° at midnight, so it
 * and the glitter path it lays on the lake stay in frame. During the day it returns unseen.
 */
export function moonPath(nightProgress: number, target = new Vector3()) {
  const p = Math.max(0, Math.min(1, nightProgress))
  const height = MOON_LOW + MOON_RISE * Math.sin(Math.PI * p)
  const azimuth = MOON_SWEEP * (1 - 2 * p)
  const flat = Math.sqrt(1 - height * height)
  return target.set(Math.sin(azimuth) * flat, height, -Math.cos(azimuth) * flat)
}

/** Artistic orbit between sunrise and sunset. Directions always point FROM the scene TO the light. */
export function sampleLighting(
  initialSeconds: number,
  elapsed = 0,
  /** A sky preset, or blended weather levels (`weather-blend.ts`): diffuse light and fog. */
  weather: WeatherPreset | Readonly<{ diffuse: number; fog?: number }> = 'partly-cloudy',
  solar: SolarEndpoints = DEFAULT_SOLAR,
  /** Written in place and returned; omit it for a fresh state. */
  target: LightingState = createLightingState(),
): LightingState {
  const span = solar.sunset - solar.sunrise
  const endpoints = span > 0 && span < 86_400 ? solar : DEFAULT_SOLAR
  const now = wrapDay(initialSeconds + elapsed)
  const dayLength = endpoints.sunset - endpoints.sunrise
  const isDay = now >= endpoints.sunrise && now < endpoints.sunset
  const angle = isDay
    ? ((now - endpoints.sunrise) / dayLength) * Math.PI
    : Math.PI + (wrapDay(now - endpoints.sunset) / (86_400 - dayLength)) * Math.PI
  // The day arc stays in front of the fixed camera: the disc rises over the
  // valley's right ridge and sets over its left cliffs, so both golden hours
  // stay in frame. The night arc returns behind the camera, which keeps the
  // moon crossing the visible sky instead of the zenith. Elevation is unchanged.
  const bearing = 0.36
  // Through the middle of the day the sun swings round behind the camera's right shoulder
  // (about 130° at noon), so the woods and meadows face it in three-quarter light rather than
  // reading as back-lit silhouettes; both ends of the arc are unchanged.
  const swing = isDay ? Math.sin(angle) ** 2 * MIDDAY_SWING : 0
  const azimuth = isDay
    ? bearing * (1 - (2 * angle) / Math.PI) + swing
    : -bearing + ((angle - Math.PI) / Math.PI) * (2 * Math.PI + 2 * bearing)
  const orbitHeight = Math.sin(angle) * 0.85
  const height = isDay ? orbitHeight : orbitHeight * (1 - 0.5 * smooth(-0.3, -0.6, orbitHeight))
  const cosElevation = Math.sqrt(Math.max(0, 1 - height * height))
  const sunDirection = target.sunDirection.set(
    Math.sin(azimuth) * cosElevation,
    height,
    -Math.cos(azimuth) * cosElevation,
  )
  const daylight = smooth(-0.12, 0.12, height)
  const adaptation = eyeAdaptation(height)
  const diffuse = typeof weather === 'string' ? WEATHER[weather].diffuse : weather.diffuse
  const fog = typeof weather === 'string' ? 0 : Math.max(0, Math.min(1, weather.fog ?? 0))
  const greyMix = Math.max(0, Math.min(1, (0.92 - diffuse) / 0.3)) ** 1.5
  // Ground fog dims the direct sun and moon; their light reaches the scene scattered instead.
  const beam = diffuse ** 1.5 * (1 - 0.5 * fog)
  const sunIntensity = 4.5 * smooth(0, Math.sin((2 * Math.PI) / 180), height) * beam
  const moonIntensity = 1.4 * (1 - smooth(-0.12, 0, height)) * beam
  const moonDirection = moonPath(
    isDay ? 1 - angle / Math.PI : angle / Math.PI - 1,
    target.moonDirection,
  )
  // Direct sunlight is the atmosphere's own transmittance, ozone included.
  const sunColor = desaturate(
    scaled(target.sunColor, transmittance(EARTH.viewerHeight, height), adaptation / NOON_SUN),
    greyMix * 0.5,
  )
  const { lift, flattening } = refraction(height)
  const flat = Math.hypot(sunDirection.x, sunDirection.z),
    apparentElevation = Math.asin(height) + lift
  const sunApparent = target.sunApparent.set(
    (sunDirection.x / flat) * Math.cos(apparentElevation),
    Math.sin(apparentElevation),
    (sunDirection.z / flat) * Math.cos(apparentElevation),
  )
  scaled(
    target.sunDisc,
    transmittance(EARTH.viewerHeight, sunApparent.y),
    (54 * adaptation) / NOON_SUN,
  )
  target.direction.copy(height >= 0 ? sunDirection : moonDirection)
  target.color.copy(height >= 0 ? sunColor : MOONLIGHT)
  const intensity = height >= 0 ? sunIntensity : moonIntensity
  const night = 1 - daylight
  // A clear, temperate lake scatters little, and in green-teal: water absorbs red, and the
  // little phytoplankton and dissolved matter it holds take some of the blue.
  const dayWater = desaturate(
    target.waterScatter.setRGB(0.012, 0.031, 0.03),
    greyMix,
  ).multiplyScalar(0.35 + 0.65 * diffuse)
  const irradiance = skyIrradiance(height)
  const ambient = desaturate(
    target.ambient
      .setRGB(0.02 * night, 0.03 * night, 0.046 * night)
      .add(skyLight(irradiance, NOON_AMBIENT * adaptation)),
    greyMix * 0.6,
  ).multiplyScalar(diffuse)
  const ambientLuminance = ambient.r * 0.2126 + ambient.g * 0.7152 + ambient.b * 0.0722
  // Use the shared ambient illumination, including weather, rather than fixed hours.
  const localLightStrength = 1 - smooth(0.03, 0.15, ambientLuminance)
  // Cursor illumination starts only after the sky's daylight transition ends.
  const pointerLightStrength = 1 - smooth(-0.24, -0.12, height)
  // Cloud decks keep the sun a little after the ground loses it: the afterglow.
  const cloudSun = transmittance(CLOUD_HEIGHT, height),
    cloudLit = cloudSun[0] > 0
  if (cloudLit)
    target.cloudDirection.set(sunDirection.x, Math.max(height, 0.02), sunDirection.z).normalize()
  else target.cloudDirection.copy(moonDirection)
  const cloudShare = 0.026 + daylight * 0.24
  const cloudDirectRaw = cloudLit
    ? scaled(target.cloudDirect, cloudSun, ((4.5 * adaptation) / NOON_SUN) * cloudShare)
    : target.cloudDirect
        .copy(MOONLIGHT)
        .multiplyScalar(moonIntensity * cloudShare * smooth(-0.025, -0.08, height))
  desaturate(cloudDirectRaw, greyMix * 0.8).multiplyScalar(0.35 + 0.65 * beam)
  const skyExposure = SKY_EXPOSURE * adaptation
  const nightHaze = target.nightHaze.setRGB(0.007 * night, 0.014 * night, 0.023 * night)
  scaled(target.haze, horizonRadiance(height), skyExposure * 0.5).add(nightHaze)
  // dayWater lives in waterScatter: blend from the night colour towards it.
  const dayShare = daylight * (0.25 + 0.75 * smooth(0, 0.3, height))
  target.waterScatter.setRGB(
    0.0014 + (dayWater.r - 0.0014) * dayShare,
    0.0026 + (dayWater.g - 0.0026) * dayShare,
    0.0034 + (dayWater.b - 0.0034) * dayShare,
  )
  desaturate(
    target.cloudAmbient
      .setRGB(0.006 * night, 0.009 * night, 0.015 * night)
      .add(skyLight(irradiance, CLOUD_AMBIENT * adaptation)),
    greyMix * 0.7,
  ).multiplyScalar(diffuse)
  target.localLightStrength = localLightStrength
  target.pointerLightStrength = pointerLightStrength
  target.ambientLuminance = ambientLuminance
  target.sunFlattening = flattening
  target.sunIntensity = sunIntensity
  target.moonIntensity = moonIntensity
  target.daylight = daylight
  target.skyExposure = skyExposure
  target.intensity = intensity
  target.weatherDiffuse = diffuse
  return target
}

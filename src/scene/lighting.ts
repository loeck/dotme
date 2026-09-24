import { Color, Vector3 } from 'three'

import { wrapDay } from './solar-clock'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Artistic 06:00–18:00 orbit. Directions always point FROM the scene TO the light. */
export function sampleLighting(
  initialSeconds: number,
  elapsed = 0,
  weather: WeatherPreset = 'partly-cloudy',
) {
  const angle = ((wrapDay(initialSeconds + elapsed) / 3600 - 6) / 12) * Math.PI
  // The rising bearing crosses the open valley, so the morning disc can enter
  // the camera before climbing out of view. The two orbit axes are orthogonal.
  const bearing = 0.36
  const horizontal = Math.sin(angle) * Math.sqrt(1 - 0.85 ** 2)
  const sunDirection = new Vector3(
    Math.sin(bearing) * Math.cos(angle) - Math.cos(bearing) * horizontal,
    Math.sin(angle) * 0.85,
    -Math.cos(bearing) * Math.cos(angle) - Math.sin(bearing) * horizontal,
  ).normalize()
  const daylight = smooth(-0.12, 0.12, sunDirection.y)
  const sunIntensity = 4.5 * smooth(0, Math.sin((2 * Math.PI) / 180), sunDirection.y)
  const moonIntensity = 1.4 * (1 - smooth(-0.12, 0, sunDirection.y))
  const moonDirection = sunDirection.clone().negate()
  const sunColor = new Color()
    .setRGB(1, 0.42, 0.18)
    .lerp(new Color().setRGB(1, 0.94, 0.82), smooth(0, 0.4, sunDirection.y))
  const direction = sunDirection.y >= 0 ? sunDirection : moonDirection
  const color = sunDirection.y >= 0 ? sunColor : new Color(0xa3bfd6)
  const intensity = sunDirection.y >= 0 ? sunIntensity : moonIntensity
  const ambient = new Color()
    .setRGB(0.016, 0.024, 0.038)
    .lerp(new Color().setRGB(0.32, 0.43, 0.59), daylight)
    .multiplyScalar(WEATHER[weather].diffuse)
  const ambientLuminance = ambient.r * 0.2126 + ambient.g * 0.7152 + ambient.b * 0.0722
  // Use the shared ambient illumination, including weather, rather than fixed hours.
  const localLightStrength = 1 - smooth(0.04, 0.16, ambientLuminance)
  return {
    localLightStrength,
    ambientLuminance,
    sunDirection,
    moonDirection,
    sunColor,
    sunIntensity,
    moonIntensity,
    daylight,
    direction,
    color,
    intensity,
    ambient,
    haze: new Color()
      .setRGB(0.007, 0.014, 0.023)
      .lerp(new Color().setRGB(0.32, 0.43, 0.55), daylight),
    waterScatter: new Color()
      .setRGB(0.0022, 0.0043, 0.0065)
      .lerp(new Color().setRGB(0.025, 0.075, 0.09), daylight),
    cloudAmbient: new Color()
      .setRGB(0.006, 0.009, 0.015)
      .lerp(new Color().setRGB(0.1, 0.14, 0.2), daylight)
      .multiplyScalar(WEATHER[weather].diffuse),
    cloudDirect: color.clone().multiplyScalar(intensity * (0.026 + daylight * 0.24)),
  }
}
export type LightingState = ReturnType<typeof sampleLighting>

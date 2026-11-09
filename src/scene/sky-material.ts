import {
  acos,
  atan,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  dot,
  exp,
  float,
  length,
  mat3,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { BackSide, Color, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu'
import type { Node } from 'three/webgpu'

import { aurora, hasAurora } from './aurora'
import { distantPeaks, horizonNoise } from './distant-horizon'
import { sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import { sampleMoonLight } from './moon-light'
import { rainbowSpectrum, stagedRainbowCentre } from './rainbow'
import type { SkyAtmosphere } from './sky-atmosphere'
import { milkyWay, stellarRadiance } from './stars'
import type { VolumetricClouds } from './volumetric-clouds'

const SUN_RADIUS = 0.0097
/** About three times the real moon's angular radius: at 54° of field the true disc is a
 * few pixels wide, too small for its maria to read. */
const MOON_RADIUS = 0.013

const luminanceOf = (value: Node<'vec3'>) => dot(value, vec3(0.2126, 0.7152, 0.0722))

function skyUniforms(seed: number, mobile: boolean) {
  const moon = sampleMoonLight(0),
    light = sampleLighting(0)
  return {
    uTime: uniform(0),
    uStarTime: uniform(0),
    uMeteorAge: uniform(2),
    uMeteorStart: uniform(new Vector3(0, 1, 0)),
    uMeteorEnd: uniform(new Vector3(0, 1, 0)),
    uReflectionCapture: uniform(0),
    uSunDirection: uniform(light.sunDirection),
    uSunApparent: uniform(light.sunApparent),
    uSunFlattening: uniform(light.sunFlattening),
    uSunDisc: uniform(new Color()),
    uDaylight: uniform(0),
    uShowSun: uniform(1),
    uShowMoon: uniform(1),
    uMoonDirection: uniform(moon.offset.normalize()),
    uMoonIntensity: uniform(moon.intensity),
    uSeed: uniform((seed % 4096) / 379),
    uMobile: uniform(mobile ? 1 : 0),
    uWeatherLight: uniform(1),
    uOvercast: uniform(0),
    /** 1 on the landscapes whose clear nights carry an aurora. */
    uAurora: uniform(hasAurora(seed) ? 1 : 0),
    /** Lightning inside the clouds, 0 when dark. */
    uFlash: uniform(0),
    /** Ground fog, 0–1: the sun and moon dim and spread into a glow, the horizon greys. */
    uFog: uniform(0),
    /** Rainbow strength (`rainbowFactor`) and its staged centre (`stagedRainbowCentre`). */
    uRainbow: uniform(0),
    uRainbowCentre: uniform(new Vector3(0, -1, 0)),
  }
}
type SkyUniforms = ReturnType<typeof skyUniforms>

/** Limb-darkened, refraction-flattened solar disc (Frostbite limb coefficients). */
function solarDisc(direction: Node<'vec3'>, u: SkyUniforms) {
  const sun = u.uSunApparent,
    right = normalize(cross(sun, vec3(0, 1, 0)).add(vec3(0.00001, 0, 0))),
    up = cross(right, sun)
  const offset = vec2(direction.dot(right), direction.dot(up).div(u.uSunFlattening)),
    radius = length(offset).div(SUN_RADIUS),
    front = smoothstep(0, 0.2, direction.dot(sun))
  const limb = pow(sqrt(clamp(radius.mul(radius).oneMinus(), 0.0001, 1)), vec3(0.397, 0.503, 0.652))
  const disc = smoothstep(0.94, 1.06, radius).oneMinus().mul(front)
  const corona = exp(radius.mul(-1.6)).mul(0.006).mul(front)
  // Fog scatters the disc into a soft, pale glow round a dim sun.
  const veiled = float(1).sub(u.uFog.mul(0.82))
  const angle = acos(clamp(direction.dot(sun), -1, 1))
  const glow = exp(angle.pow2().mul(-260))
    .mul(0.5)
    .add(exp(angle.pow2().mul(-22)).mul(0.08))
    .mul(u.uFog)
    .mul(1 / 54)
  return u.uSunDisc.rgb.mul(limb.mul(disc).add(corona).mul(veiled).add(glow)).mul(u.uShowSun)
}

export class SkyMaterial extends MeshBasicNodeMaterial {
  readonly uniforms
  constructor(seed: number, mobile: boolean, clouds: VolumetricClouds, sky: SkyAtmosphere) {
    super({ side: BackSide, depthWrite: false, fog: false })
    this.uniforms = skyUniforms(seed, mobile)
    const u = this.uniforms
    // Translation-free sky and far-plane depth also hold for oblique reflection cameras.
    const clip = cameraProjectionMatrix.mul(vec4(mat3(cameraViewMatrix).mul(positionLocal), 1))
    this.vertexNode = vec4(clip.xy, clip.w, clip.w)
    const direction = normalize(positionLocal),
      azimuth = atan(direction.x, direction.z.negate()),
      elevation = direction.y,
      night = u.uDaylight.oneMinus()
    const variation = horizonNoise(vec2(azimuth.mul(7).add(u.uSeed), 8))
    const horizon = exp(
      elevation.sub(0.018).sub(variation.sub(0.5).mul(0.012)).mul(12).pow2().negate(),
    )
    const valley = exp(azimuth.sub(0.08).div(0.46).pow2().negate())
    // The clear sky as a polarising filter photographs it on a summer day: about a third darker
    // and more saturated, deepest overhead and paler toward the horizon, so white cumulus stand
    // out against a deep blue. Only the visible sky changes; scene lighting reads the LUTs.
    const physical = sky.radiance(direction)
    const overhead = smoothstep(0.02, 0.6, elevation)
    const radiance = max(
      mix(vec3(luminanceOf(physical)), physical, mix(float(1.12), float(1.35), overhead)).mul(
        mix(float(0.86), float(0.62), overhead),
      ),
      vec3(0),
    )
    const radianceGrey = luminanceOf(radiance)
    const dimRadiance = mix(radiance, vec3(radianceGrey), u.uOvercast.mul(0.45)).mul(
      u.uWeatherLight,
    )
    let color = mix(
      vec3(0.0026, 0.0038, 0.0051),
      vec3(0.012, 0.018, 0.027),
      horizon.mul(variation.mul(0.27).add(valley.mul(0.15)).add(0.58)),
    )
      .mul(night)
      .add(dimRadiance)
      .add(solarDisc(direction, u))
    const moonAngle = acos(clamp(direction.dot(u.uMoonDirection), -1, 1))
    const disc = smoothstep(MOON_RADIUS * 0.9, MOON_RADIUS, moonAngle).oneMinus()
    // Maria and a little limb darkening in the disc's own east/north frame.
    const east = normalize(cross(vec3(0, 1, 0), u.uMoonDirection)),
      north = cross(u.uMoonDirection, east)
    const face = vec2(dot(direction, east), dot(direction, north)).div(MOON_RADIUS)
    const maria = horizonNoise(face.mul(2.2).add(11))
      .mul(0.6)
      .add(horizonNoise(face.mul(5.3).add(3)).mul(0.4))
    const surface = mix(float(1), float(0.6), smoothstep(0.42, 0.68, maria)).mul(
      float(1).sub(dot(face, face).mul(0.22)),
    )
    // A tight aureole round the disc and a wide, faint glow in the night air.
    const halo = exp(moonAngle.pow(2).mul(-900))
      .mul(0.05)
      .add(exp(moonAngle.pow(2).mul(-60)).mul(0.02))
    color = color.add(
      vec3(0.63, 0.77, 1)
        .mul(
          disc
            .mul(surface)
            .mul(2.2)
            .mul(u.uShowMoon)
            .mul(u.uFog.mul(-0.75).add(1))
            .add(halo.mul(u.uFog.mul(2.5).add(1))),
        )
        .mul(u.uMoonIntensity),
    )
    const cloud = clouds.sample(direction)
    color = color
      .add(
        stellarRadiance(direction, moonAngle, u)
          .add(milkyWay(direction, moonAngle, u))
          .mul(smoothstep(0.65, 0.98, cloud.a))
          .add(aurora(direction, u)),
      )
      .mul(cloud.a)
      .add(cloud.rgb)
      // Lightning glows through the cloud deck: brightest where the cloud is thick.
      .add(vec3(0.62, 0.68, 0.85).mul(u.uFlash.mul(cloud.a.oneMinus().mul(0.35).add(0.04))))
    // Distant ridges and mist take the sky's own horizon light in their direction:
    // warm towards the sun, rose and blue under the Earth's shadow.
    const air = sky.horizon(direction).mul(u.uWeatherLight)
    const tone = (nightTone: Node<'vec3'>, strength: number, tint: Node<'vec3'> = vec3(1)) =>
      nightTone.mul(night).add(air.mul(strength).mul(tint))
    const drift = u.uTime.mul(0.011),
      peaks = distantPeaks(azimuth, u.uSeed, u.uMobile),
      baseFade = smoothstep(-0.008, 0.026, elevation)
    // Distant ranges are wooded hills: the farthest blue with air, the nearer ones greener and
    // darker, each crest broken by a tree line, and the nearest shaded and lit slope by slope.
    const treeline = (scale: number, amplitude: number, offset: number) =>
      horizonNoise(vec2(azimuth.mul(scale), u.uSeed.add(offset)))
        .sub(0.5)
        .mul(amplitude)
        .add(
          horizonNoise(vec2(azimuth.mul(scale * 2.7), u.uSeed.add(offset + 5)))
            .sub(0.5)
            .mul(amplitude * 0.5),
        )
    const slopes = horizonNoise(vec2(azimuth.mul(9), u.uSeed.add(41)))
      .mul(0.5)
      .add(0.75)
    color = mix(
      color,
      tone(vec3(0.0078, 0.0123, 0.0188), 0.32, vec3(0.93, 0.99, 1.04)),
      smoothstep(peaks.x.sub(0.006), peaks.x.add(0.009), elevation)
        .oneMinus()
        .mul(baseFade)
        .mul(0.88),
    )
    const mistShape = horizonNoise(vec2(azimuth.mul(13).add(drift.mul(0.8)), u.uSeed.add(73)))
    const mistHeight = mistShape.sub(0.5).mul(0.024).add(0.033),
      farMist = exp(elevation.sub(mistHeight).mul(28).pow2().negate())
    const pool = exp(azimuth.sub(0.13).div(0.32).pow2().negate())
    color = mix(
      color,
      tone(vec3(0.018, 0.026, 0.037), 0.45),
      farMist.mul(mistShape.mul(0.13).add(pool.mul(0.36)).add(0.08)),
    )
    color = mix(
      color,
      tone(vec3(0.0053, 0.0085, 0.0131), 0.21, vec3(0.8, 1, 0.82)),
      smoothstep(
        peaks.y.add(treeline(260, 0.0028, 11)).sub(0.003),
        peaks.y.add(treeline(260, 0.0028, 11)).add(0.004),
        elevation,
      )
        .oneMinus()
        .mul(baseFade)
        .mul(0.91),
    )
    color = mix(
      color,
      tone(vec3(0.0031, 0.0051, 0.0081), 0.13, vec3(0.62, 1, 0.52).mul(slopes)),
      smoothstep(
        peaks.z.add(treeline(520, 0.004, 23)).sub(0.0015),
        peaks.z.add(treeline(520, 0.004, 23)).add(0.002),
        elevation,
      )
        .oneMinus()
        .mul(baseFade)
        .mul(0.86),
    )
    const lowMist = exp(elevation.sub(0.006).mul(42).pow2().negate())
    const mistNoise = horizonNoise(
        vec2(azimuth.mul(18).add(drift.mul(0.8)), elevation.mul(35).add(73)),
      ),
      detail = horizonNoise(vec2(azimuth.mul(43).sub(drift), elevation.mul(24).add(u.uSeed)))
    color = mix(
      color,
      tone(vec3(0.023, 0.033, 0.044), 0.5),
      lowMist.mul(mistNoise.mul(0.16).add(detail.mul(0.055)).add(pool.mul(0.22)).add(0.12)),
    )
    const mistBand = smoothstep(0.05, 0.55, elevation).oneMinus()
    const lowSun = smoothstep(0, 0.35, u.uSunDirection.y)
      .oneMinus()
      .mul(smoothstep(-0.06, 0.02, u.uSunDirection.y))
    const sunward = smoothstep(0.3, 0.95, dot(direction, u.uSunDirection))
    const mistAmount = lowSun.mul(u.uOvercast).mul(mistBand).mul(sunward.mul(0.8).add(0.6))
    const airGrey = luminanceOf(air)
    const mistColor = mix(vec3(airGrey), air, 0.22).mul(0.55)
    color = mix(color, mistColor, mistAmount)
    // Fog greys the low sky into the air's own light; the volumetric air thickens it further in
    // the main view, and this keeps the lake's reflection of the sky foggy too.
    const fogBand = exp(max(elevation, 0).mul(-7)).mul(u.uFog.mul(0.85))
    color = mix(color, mix(vec3(airGrey), air, 0.35).mul(0.7), fogBand)
    // The rainbow, lit by the sun on the drops (its colour) about as bright as the sky round it,
    // and only as far as the sun itself is clear of the cloud.
    const sunClear = clouds.sample(u.uSunDirection).a
    const sunTint = u.uSunDisc.rgb.div(max(luminanceOf(u.uSunDisc.rgb), 0.0001))
    color = color.add(
      rainbowSpectrum(direction, u.uRainbowCentre)
        .mul(sunTint)
        .mul(airGrey)
        .mul(u.uRainbow.mul(mix(0.3, 1, sunClear)).mul(0.9)),
    )
    this.fragmentNode = vec4(
      color.mul(u.uReflectionCapture.oneMinus()),
      float(1).sub(u.uReflectionCapture),
    )
  }
}
export function createSkyMaterial(
  seed: number,
  mobile: boolean,
  clouds: VolumetricClouds,
  sky: SkyAtmosphere,
) {
  return new SkyMaterial(seed, mobile, clouds, sky)
}
export function updateSkyLighting(material: SkyMaterial, light: LightingState, showSun: boolean) {
  const u = material.uniforms
  u.uWeatherLight.value = light.weatherDiffuse ** 2
  u.uOvercast.value = 1 - light.weatherDiffuse
  u.uSunDirection.value.copy(light.sunDirection)
  u.uSunApparent.value.copy(light.sunApparent)
  u.uSunFlattening.value = light.sunFlattening
  u.uSunDisc.value.copy(light.sunDisc)
  u.uDaylight.value = light.daylight
  u.uShowSun.value = showSun ? 1 : 0
  u.uMoonDirection.value.copy(light.moonDirection)
  u.uMoonIntensity.value = light.moonIntensity
}
/** Weather the sky draws itself: ground fog and the rainbow (uniforms only). */
export function updateSkyWeather(material: SkyMaterial, fog: number, rainbow: number) {
  const u = material.uniforms
  u.uFog.value = Math.max(0, Math.min(1, fog))
  u.uRainbow.value = Math.max(0, Math.min(1, rainbow))
  stagedRainbowCentre(u.uSunDirection.value, u.uRainbowCentre.value)
}

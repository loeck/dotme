import {
  acos,
  atan,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  exp,
  float,
  mat3,
  mix,
  normalize,
  positionLocal,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { BackSide, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu'

import { daylightSky } from './daylight-sky'
import { distantPeaks, horizonNoise } from './distant-horizon'
import { sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import { sampleMoonLight } from './moon-light'
import { stellarRadiance } from './stars'
import type { VolumetricClouds } from './volumetric-clouds'

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
    uSunColor: uniform(light.sunColor),
    uSunIntensity: uniform(0),
    uDaylight: uniform(0),
    uShowSun: uniform(1),
    uShowMoon: uniform(1),
    uHaze: uniform(light.haze),
    uMoonDirection: uniform(moon.offset.normalize()),
    uMoonIntensity: uniform(moon.intensity),
    uSeed: uniform((seed % 4096) / 379),
    uMobile: uniform(mobile ? 1 : 0),
  }
}
export class SkyMaterial extends MeshBasicNodeMaterial {
  readonly uniforms
  constructor(seed: number, mobile: boolean, clouds: VolumetricClouds) {
    super({ side: BackSide, depthWrite: false, fog: false })
    this.uniforms = skyUniforms(seed, mobile)
    const u = this.uniforms
    // Translation-free sky and far-plane depth also hold for oblique reflection cameras.
    const clip = cameraProjectionMatrix.mul(vec4(mat3(cameraViewMatrix).mul(positionLocal), 1))
    this.vertexNode = vec4(clip.xy, clip.w, clip.w)
    const direction = normalize(positionLocal),
      azimuth = atan(direction.x, direction.z.negate()),
      elevation = direction.y
    const variation = horizonNoise(vec2(azimuth.mul(7).add(u.uSeed), 8))
    const horizon = exp(
      elevation.sub(0.018).sub(variation.sub(0.5).mul(0.012)).mul(12).pow2().negate(),
    )
    const valley = exp(azimuth.sub(0.08).div(0.46).pow2().negate())
    let color = mix(
      vec3(0.0026, 0.0038, 0.0051),
      vec3(0.012, 0.018, 0.027),
      horizon.mul(variation.mul(0.27).add(valley.mul(0.15)).add(0.58)),
    )
    color = mix(
      color,
      daylightSky(direction, u.uSunDirection, u.uSunColor, u.uSunIntensity, u.uShowSun),
      u.uDaylight,
    )
    const moonAngle = acos(clamp(direction.dot(u.uMoonDirection), -1, 1))
    const disc = smoothstep(0.008, 0.01, moonAngle).oneMinus(),
      halo = exp(moonAngle.pow(2).mul(-90)).mul(0.016)
    color = color.add(
      vec3(0.63, 0.77, 1).mul(disc.mul(2).mul(u.uShowMoon).add(halo)).mul(u.uMoonIntensity),
    )
    const cloud = clouds.sample(direction)
    color = color
      .add(stellarRadiance(direction, moonAngle, u).mul(smoothstep(0.65, 0.98, cloud.a)))
      .mul(cloud.a)
      .add(cloud.rgb)
    const drift = u.uTime.mul(0.011),
      peaks = distantPeaks(azimuth, u.uSeed, u.uMobile),
      baseFade = smoothstep(-0.008, 0.026, elevation)
    color = mix(
      color,
      mix(vec3(0.0078, 0.0123, 0.0188), u.uHaze.rgb.mul(0.55), u.uDaylight),
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
      mix(vec3(0.018, 0.026, 0.037), u.uHaze.rgb.mul(0.85), u.uDaylight),
      farMist.mul(mistShape.mul(0.13).add(pool.mul(0.36)).add(0.08)),
    )
    color = mix(
      color,
      mix(vec3(0.0053, 0.0085, 0.0131), u.uHaze.rgb.mul(0.36), u.uDaylight),
      smoothstep(peaks.y.sub(0.004), peaks.y.add(0.006), elevation)
        .oneMinus()
        .mul(baseFade)
        .mul(0.91),
    )
    color = mix(
      color,
      mix(vec3(0.0031, 0.0051, 0.0081), u.uHaze.rgb.mul(0.22), u.uDaylight),
      smoothstep(peaks.z.sub(0.003), peaks.z.add(0.004), elevation)
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
      mix(vec3(0.023, 0.033, 0.044), u.uHaze.rgb.mul(0.95), u.uDaylight),
      lowMist.mul(mistNoise.mul(0.16).add(detail.mul(0.055)).add(pool.mul(0.22)).add(0.12)),
    )
    this.fragmentNode = vec4(
      color.mul(u.uReflectionCapture.oneMinus()),
      float(1).sub(u.uReflectionCapture),
    )
  }
}
export function createSkyMaterial(seed: number, mobile: boolean, clouds: VolumetricClouds) {
  return new SkyMaterial(seed, mobile, clouds)
}
export function updateSkyLighting(material: SkyMaterial, light: LightingState, showSun: boolean) {
  const u = material.uniforms
  u.uSunDirection.value.copy(light.sunDirection)
  u.uSunColor.value.copy(light.sunColor)
  u.uSunIntensity.value = light.sunIntensity
  u.uDaylight.value = light.daylight
  u.uShowSun.value = showSun ? 1 : 0
  u.uHaze.value.copy(light.haze)
  u.uMoonDirection.value.copy(light.moonDirection)
  u.uMoonIntensity.value = light.moonIntensity
}

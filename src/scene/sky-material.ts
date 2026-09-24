import { BackSide, ShaderMaterial } from 'three'

import { DAYLIGHT_SKY_GLSL } from './daylight-sky'
import { DISTANT_HORIZON_GLSL } from './distant-horizon'
import { sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import { sampleMoonLight } from './moon-light'
import { CLOUD_SAMPLING_GLSL } from './volumetric-clouds'
import type { VolumetricClouds } from './volumetric-clouds'

// The landscape is close to the camera; these distant silhouettes give the
// valley depth without adding another band of visible geometry at the shore.
const vertexShader = `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  // The sky is infinitely distant, including in the lake's oblique reflection
  // camera. Clipping this finite sphere against the water plane leaves a black
  // strip where reflected rays meet the lake beyond the sphere's radius.
  gl_Position.z = gl_Position.w;
}
`

const fragmentShader = `
uniform float uTime;
${CLOUD_SAMPLING_GLSL}
${DAYLIGHT_SKY_GLSL}
uniform float uSeed;
uniform float uReflectionCapture;
uniform float uMobile;
uniform vec3 uMoonDirection;
uniform float uMoonIntensity;
uniform float uShowMoon;
varying vec3 vDirection;

${DISTANT_HORIZON_GLSL}
void main() {
  vec3 direction = normalize(vDirection);
  float azimuth = atan(direction.x, -direction.z);
  float elevation = direction.y;

  // A faint pool of light follows the open water, with an irregular upper edge.
  // Its narrow height keeps the rest of the sky nearly black.
  float horizonVariation = horizonNoise(vec2(azimuth * 7.0 + uSeed, 8.0));
  float horizon = exp(-pow((elevation - 0.018 - (horizonVariation - 0.5) * 0.012) * 12.0, 2.0));
  float valleyLight = exp(-pow((azimuth - 0.08) / 0.46, 2.0));
  vec3 color = mix(
    vec3(0.0026, 0.0038, 0.0051),
    vec3(0.012, 0.018, 0.027),
    horizon * (0.58 + 0.27 * horizonVariation + 0.15 * valleyLight)
  );

  color = mix(color, daylightSky(direction), uDaylight);

  // The visible moon and its halo track the same direction as the scene light.
  float moonAngle = acos(clamp(dot(direction, uMoonDirection), -1.0, 1.0));
  float moonDisc = 1.0 - smoothstep(0.008, 0.010, moonAngle);
  float moonHalo = exp(-moonAngle * moonAngle * 90.0) * 0.016;
  color += vec3(0.63, 0.77, 1.0) * (moonDisc * 2.0 * uShowMoon + moonHalo) * uMoonIntensity;
  // Clouds attenuate both the lunar disc and its halo before distant relief.
  vec4 cloud = sampleClouds(direction);
  color = color * cloud.a + cloud.rgb;
  float drift = uTime * 0.011;

  // Separate hills overlap at different bearings. Avoid a mirrored valley
  // function, which reads as two diagonal wedges at narrow viewports.
  vec3 peaks = distantPeaks(azimuth, uSeed, uMobile);
  float farPeak = peaks.x, middlePeak = peaks.y, nearPeak = peaks.z;

  // Keep the crests legible as the ridge feet dissolve into the low mist.
  // A tall base fade erased the smaller hills and flattened the entire valley.
  float baseFade = smoothstep(-0.008, 0.026, elevation);
  float farEdge = 1.0 - smoothstep(farPeak - 0.006, farPeak + 0.009, elevation);
  color = mix(color, mix(vec3(0.0078, 0.0123, 0.0188), uHaze * 0.55, uDaylight), farEdge * baseFade * 0.88);

  // A wavering low veil pools in the open valley and softens only the far ridge.
  float mistShape = horizonNoise(vec2(azimuth * 13.0 + drift * 0.8, uSeed + 73.0));
  float mistHeight = 0.033 + (mistShape - 0.5) * 0.024;
  float farMist = exp(-pow((elevation - mistHeight) * 28.0, 2.0));
  float valleyPool = exp(-pow((azimuth - 0.13) / 0.32, 2.0));
  color = mix(
    color,
    mix(vec3(0.018, 0.026, 0.037), uHaze * 0.85, uDaylight),
    farMist * (0.08 + mistShape * 0.13 + valleyPool * 0.36)
  );

  float middleEdge = 1.0 - smoothstep(middlePeak - 0.004, middlePeak + 0.006, elevation);
  color = mix(color, mix(vec3(0.0053, 0.0085, 0.0131), uHaze * 0.36, uDaylight), middleEdge * baseFade * 0.91);
  float nearEdge = 1.0 - smoothstep(nearPeak - 0.003, nearPeak + 0.004, elevation);
  color = mix(color, mix(vec3(0.0031, 0.0051, 0.0081), uHaze * 0.22, uDaylight), nearEdge * baseFade * 0.86);

  // Thin, uneven mist separates the ridge layers close to the waterline.
  float lowMist = exp(-pow((elevation - 0.006) * 42.0, 2.0));
  float mistNoise = horizonNoise(vec2(azimuth * 18.0 + drift * 0.8, elevation * 35.0 + 73.0));
  float mistDetail = horizonNoise(vec2(azimuth * 43.0 - drift, elevation * 24.0 + uSeed));
  float mist = lowMist * (0.12 + mistNoise * 0.16 + mistDetail * 0.055 + valleyPool * 0.22);
  color = mix(color, mix(vec3(0.023, 0.033, 0.044), uHaze * 0.95, uDaylight), mist);

  // The reflection target reuses alpha as local scenery coverage.
  gl_FragColor = vec4(color * (1.0 - uReflectionCapture), 1.0 - uReflectionCapture);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export function createSkyMaterial(
  seed: number,
  mobile: boolean,
  clouds: VolumetricClouds,
): ShaderMaterial {
  const moon = sampleMoonLight(0)
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uReflectionCapture: { value: 0 },
      uSunDirection: { value: sampleLighting(0).sunDirection },
      uSunColor: { value: sampleLighting(0).sunColor },
      uSunIntensity: { value: 0 },
      uDaylight: { value: 0 },
      uShowSun: { value: 1 },
      uShowMoon: { value: 1 },
      uHaze: { value: sampleLighting(0).haze },
      ...clouds.uniforms,
      uMoonDirection: { value: moon.offset.normalize() },
      uMoonIntensity: { value: moon.intensity },
      uSeed: { value: (seed % 4096) / 379 },
      uMobile: { value: mobile ? 1 : 0 },
    },
    side: BackSide,
    depthWrite: false,
    fog: false,
  })
}

export function updateSkyLighting(
  material: ShaderMaterial,
  light: LightingState,
  showSun: boolean,
) {
  const u = material.uniforms
  u.uSunDirection!.value.copy(light.sunDirection)
  u.uSunColor!.value.copy(light.sunColor)
  u.uSunIntensity!.value = light.sunIntensity
  u.uDaylight!.value = light.daylight
  u.uShowSun!.value = showSun ? 1 : 0
  u.uHaze!.value.copy(light.haze)
  u.uMoonDirection!.value.copy(light.moonDirection)
  u.uMoonIntensity!.value = light.moonIntensity
}

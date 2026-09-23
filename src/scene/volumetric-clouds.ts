import {
  BackSide,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  Mesh,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLCubeRenderTarget,
} from 'three'
import type { WebGLRenderer } from 'three'

import { CLOUD_DENSITY_GLSL, createCloudBodies } from './cloud-density'
import { createCloudNoise } from './cloud-noise'
import { CloudShadows } from './cloud-shadows'
import { sampleMoonLight } from './moon-light'
import type { WindModel } from './wind'

export const CLOUD_PROFILES = {
  desktop: { resolution: 256, hz: 15, steps: 48 },
  mobile: { resolution: 128, hz: 10, steps: 24 },
} as const

/** Decode before interpolation so sky and reflections compose linear radiance. */
export const CLOUD_SAMPLING_GLSL = `
uniform samplerCube uCloudPrevious;
uniform samplerCube uCloudNext;
uniform float uCloudBlend;
uniform float uCloudResolution;
vec4 decodeCloud(samplerCube cloudMap, vec3 ray) {
  vec4 value = textureCube(cloudMap, ray);
  value.rgb *= value.rgb;
  return value;
}
// Four bilinear lookups reconstruct a cubic B-spline. Work in the selected face's
// plane but sample directions, allowing taps to cross seamlessly to adjacent faces.
vec4 smoothCloud(samplerCube cloudMap, vec3 ray) {
  vec3 a = abs(ray);
  float major = max(max(a.x, a.y), a.z);
  vec3 normal, tangent, bitangent;
  if (a.x >= a.y && a.x >= a.z) {
    normal = vec3(sign(ray.x), 0.0, 0.0); tangent = vec3(0.0, 1.0, 0.0); bitangent = vec3(0.0, 0.0, 1.0);
  } else if (a.y >= a.z) {
    normal = vec3(0.0, sign(ray.y), 0.0); tangent = vec3(1.0, 0.0, 0.0); bitangent = vec3(0.0, 0.0, 1.0);
  } else {
    normal = vec3(0.0, 0.0, sign(ray.z)); tangent = vec3(1.0, 0.0, 0.0); bitangent = vec3(0.0, 1.0, 0.0);
  }
  vec2 uv = vec2(dot(ray, tangent), dot(ray, bitangent)) / major;
  vec2 texel = (uv * 0.5 + 0.5) * uCloudResolution - 0.5;
  vec2 f = fract(texel), base = floor(texel);
  vec2 w0 = pow(1.0 - f, vec2(3.0)) / 6.0;
  vec2 w1 = (3.0 * f*f*f - 6.0 * f*f + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f*f*f + 3.0 * f*f + 3.0*f + 1.0) / 6.0;
  vec2 w3 = f*f*f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 low = (base - 0.5 + w1 / g0) * (2.0 / uCloudResolution) - 1.0;
  vec2 high = (base + 1.5 + w3 / g1) * (2.0 / uCloudResolution) - 1.0;
  return decodeCloud(cloudMap, normal + tangent * low.x + bitangent * low.y) * g0.x * g0.y
    + decodeCloud(cloudMap, normal + tangent * high.x + bitangent * low.y) * g1.x * g0.y
    + decodeCloud(cloudMap, normal + tangent * low.x + bitangent * high.y) * g0.x * g1.y
    + decodeCloud(cloudMap, normal + tangent * high.x + bitangent * high.y) * g1.x * g1.y;
}
vec4 sampleClouds(vec3 direction) {
  return mix(smoothCloud(uCloudPrevious, direction), smoothCloud(uCloudNext, direction), uCloudBlend);
}
`

const vertexShader = `
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`
const fragmentShader = `
${CLOUD_DENSITY_GLSL}
uniform vec3 uMoonDirection;
uniform float uMoonIntensity;
varying vec3 vDirection;

void main() {
  vec3 ray = normalize(vDirection);
  if (ray.y <= 0.035) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // Fixed world origin: capture never inherits the viewer/reflection camera position.
  float entry = CLOUD_BASE / ray.y;
  float exitDistance = min(CLOUD_TOP / ray.y, 2200.0);
  if (entry >= exitDistance) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float stepLength = (exitDistance - entry) / float(CLOUD_STEPS);
  float transmittance = 1.0;
  vec3 radiance = vec3(0.0);
  float cosine = dot(ray, uMoonDirection);
  // Henyey-Greenstein forward scattering, normalized relative to isotropic light.
  float phase = 0.75 / pow(max(0.05, 1.25 - cosine), 1.5);
  for (int i = 0; i < CLOUD_STEPS; i++) {
    vec3 p = ray * (entry + (float(i) + 0.5) * stepLength);
    float d = density(p, true);
    if (d > 0.001) {
      float opticalDepth = 0.0;
      // Three increasingly distant moonward samples approximate internal shadows.
      for (int j = 0; j < 3; j++) {
        float stride = 9.0 + float(j) * 12.0;
        opticalDepth += density(p + uMoonDirection * (8.0 + float(j) * 22.0), false) * stride;
      }
      float moonLight = exp(-opticalDepth * CLOUD_EXTINCTION);
      vec3 source = vec3(0.006, 0.009, 0.015)
        + vec3(0.026, 0.036, 0.050) * moonLight * uMoonIntensity * (0.3 + phase * 0.35);
      float opacity = 1.0 - exp(-d * stepLength * CLOUD_EXTINCTION);
      radiance += transmittance * opacity * source;
      transmittance *= 1.0 - opacity;
      if (transmittance < 0.015) break;
    }
  }
  float horizonFade = smoothstep(0.035, 0.075, ray.y);
  radiance *= horizonFade;
  transmittance = mix(1.0, transmittance, horizonFade);
  // Encode dim radiance for the RGBA8 fallback; decode before linear composition.
  gl_FragColor = vec4(sqrt(radiance), transmittance);
}
`

/** Two bracketing deterministic captures. The next capture can be evaluated ahead
 * of time, so interpolation adds no one-frame jump or weather latency. */
export class VolumetricClouds {
  readonly shadows: CloudShadows
  readonly profile: (typeof CLOUD_PROFILES)[keyof typeof CLOUD_PROFILES]
  readonly uniforms = {
    uCloudPrevious: { value: null as WebGLCubeRenderTarget['texture'] | null },
    uCloudNext: { value: null as WebGLCubeRenderTarget['texture'] | null },
    uCloudBlend: { value: 0 },
    uCloudResolution: { value: 256 },
  }
  private readonly targets: WebGLCubeRenderTarget[]
  private readonly noise
  private readonly material: ShaderMaterial
  private readonly geometry = new SphereGeometry(1, 16, 8)
  private readonly scene = new Scene()
  private readonly camera: CubeCamera
  private tick = -1
  private current = 0

  constructor(
    private readonly renderer: WebGLRenderer,
    seed: number,
    mobile: boolean,
    private readonly wind: WindModel,
  ) {
    this.profile = mobile ? CLOUD_PROFILES.mobile : CLOUD_PROFILES.desktop
    this.uniforms.uCloudResolution.value = this.profile.resolution
    this.noise = createCloudNoise(seed)
    this.targets = [0, 1].map(
      () =>
        new WebGLCubeRenderTarget(this.profile.resolution, {
          type: renderer.extensions.has('EXT_color_buffer_float')
            ? HalfFloatType
            : UnsignedByteType,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          generateMipmaps: false,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    )
    for (const target of this.targets)
      target.texture.name = 'Volumetric cloud radiance / transmission'
    this.camera = new CubeCamera(0.1, 2, this.targets[0]!)
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: { CLOUD_STEPS: this.profile.steps },
      uniforms: {
        ...createCloudBodies(seed),
        uNoise: { value: this.noise },
        uDisplacement: { value: new Vector2() },
        uTime: { value: 0 },
        uMoonDirection: { value: new Vector3() },
        uMoonIntensity: { value: 1.5 },
      },
      side: BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.shadows = new CloudShadows(renderer, this.material.uniforms, this.uniforms.uCloudBlend)
    const sphere = new Mesh(this.geometry, this.material)
    sphere.frustumCulled = false
    this.scene.add(sphere)
  }

  private capture(index: number, time: number) {
    const wind = this.wind.sample(time)
    this.material.uniforms.uDisplacement!.value.fromArray(wind.displacement)
    this.material.uniforms.uTime!.value = time
    const moon = sampleMoonLight(time)
    this.material.uniforms.uMoonDirection!.value.copy(moon.offset).normalize()
    this.material.uniforms.uMoonIntensity!.value = moon.intensity
    this.camera.renderTarget = this.targets[index]!
    this.camera.update(this.renderer, this.scene)
    this.shadows.capture(index)
  }

  update(time: number) {
    const tick = Math.floor(time * this.profile.hz)
    if (this.tick !== tick) {
      if (tick === this.tick + 1 && this.tick >= 0) {
        this.current = 1 - this.current
      } else {
        this.capture(this.current, tick / this.profile.hz)
      }
      this.capture(1 - this.current, (tick + 1) / this.profile.hz)
      this.shadows.select(this.current)
      this.tick = tick
      this.uniforms.uCloudPrevious.value = this.targets[this.current]!.texture
      this.uniforms.uCloudNext.value = this.targets[1 - this.current]!.texture
    }
    this.uniforms.uCloudBlend.value = Math.max(0, Math.min(1, time * this.profile.hz - tick))
  }

  dispose() {
    this.shadows.dispose()
    this.noise.dispose()
    this.geometry.dispose()
    this.material.dispose()
    for (const target of this.targets) target.dispose()
  }
}

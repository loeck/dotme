import {
  Color,
  HalfFloatType,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three'
import type { DirectionalLight, IUniform, PerspectiveCamera, WebGLRenderer } from 'three'

import { CLOUD_SHADOW_GLSL } from './cloud-shadows'
import type { LightingState } from './lighting'

const vertexShader = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

export const AIR_INTEGRATION_GLSL = `
// Integral of exp(-extinction*x), including the zero-extinction limit.
float segmentIntegral(float extinction, float length) {
  float tau = extinction * length;
  return tau < 0.001 ? length * (1.0 - tau * 0.5 + tau * tau / 6.0)
    : (1.0 - exp(-tau)) / extinction;
}
float airPhase(float cosine) {
  // View ray points away from camera; light direction points toward sun. g=0.6.
  return 0.0795774715 * 0.64 / pow(1.36 - 1.2 * cosine, 1.5);
}
`

const fragmentShader = `
precision highp sampler2DShadow;
uniform sampler2D tDepth;
uniform sampler2DShadow tTerrain;
uniform mat4 uInverseProjection;
uniform mat4 uCameraWorld;
uniform mat4 uShadowMatrix;
uniform vec3 uEye;
uniform vec3 uSunDirection;
uniform vec3 uSunRadiance;
uniform vec3 uAmbient;
uniform float uExtinction;
uniform float uShadowBias;
varying vec2 vUv;
${CLOUD_SHADOW_GLSL}
${AIR_INTEGRATION_GLSL}
float terrainVisibility(vec4 projected) {
  vec3 p = projected.xyz / projected.w;
  if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) return 1.0;
  return texture(tTerrain, vec3(p.xy, p.z + uShadowBias));
}
void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 view = uInverseProjection * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 endPoint = (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
  vec3 delta = endPoint - uEye;
  float distance = min(length(delta), 240.0);
  vec3 ray = normalize(delta);
  // Air is a separate medium beneath the clouds (y=80). Clip both slab boundaries.
  float entry = 0.0;
  if (abs(ray.y) > 0.00001) {
    float a = (-20.0 - uEye.y) / ray.y;
    float b = (80.0 - uEye.y) / ray.y;
    entry = max(0.0, min(a, b));
    distance = min(distance, max(a, b));
  } else if (uEye.y < -20.0 || uEye.y > 80.0) distance = 0.0;
  float stepLength = max(0.0, distance - entry) / float(AIR_STEPS);
  if (stepLength <= 0.0 || uExtinction <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Shadow projections are linear along this ray. Project origin and step once,
  // retaining exactly the same midpoint samples and shadow-map resolutions.
  vec4 start = vec4(uEye + ray * entry, 1.0);
  vec4 step = vec4(ray * stepLength, 0.0);
  vec4 terrainStart = uShadowMatrix * start;
  vec4 terrainStep = uShadowMatrix * step;
  vec2 previousStart = (uCloudShadowPreviousMatrix * start).xy;
  vec2 previousStep = (uCloudShadowPreviousMatrix * step).xy;
  vec2 nextStart = (uCloudShadowNextMatrix * start).xy;
  vec2 nextStep = (uCloudShadowNextMatrix * step).xy;
  bool directLight = uSunDirection.y > 0.0 && dot(uSunRadiance, vec3(1.0)) > 0.0;
  float transmission = exp(-uExtinction * stepLength);
  float integral = segmentIntegral(uExtinction, stepLength);
  float phase = airPhase(dot(ray, uSunDirection));
  float accumulated = 1.0;
  vec3 radiance = vec3(0.0);
  // Stable midpoint quadrature, no temporal history or frame-dependent jitter.
  for (int i = 0; i < AIR_STEPS; i++) {
    float midpoint = float(i) + 0.5;
    float visibility = 0.0;
    if (directLight) {
      visibility = terrainVisibility(terrainStart + terrainStep * midpoint);
      // Fully blocked terrain contributes no sunlight, regardless of cloud cover.
      if (visibility > 0.0)
        visibility *= cloudShadowProjected(previousStart + previousStep * midpoint,
          nextStart + nextStep * midpoint);
    }
    // Artistic solar exposure compensates for the normalized HG phase. Cloud
    // transmission remains Beer–Lambert: opaque cover cannot invent a beam.
    vec3 source = uExtinction * (uAmbient + uSunRadiance * visibility * phase * 6.0);
    radiance += accumulated * source * integral;
    accumulated *= transmission;
  }
  // Range 0..16 linear radiance in RGBA8 as well as half float. Alpha is transmission.
  gl_FragColor = vec4(sqrt(max(radiance, vec3(0.0)) / 16.0), accumulated);
}
`

const compositeShader = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAir;
uniform vec2 uAirSize;
uniform vec2 uCameraRange;
varying vec2 vUv;
float distanceAt(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  return uCameraRange.x * uCameraRange.y / (uCameraRange.y - d * (uCameraRange.y - uCameraRange.x));
}
void main() {
  float center = distanceAt(vUv);
  vec2 pixel = vUv * uAirSize - 0.5;
  vec2 base = floor(pixel);
  vec2 f = fract(pixel);
  vec4 air = vec4(0.0);
  float total = 0.0;
  vec4 nearestAir = vec4(0.0, 0.0, 0.0, 1.0);
  float nearestDifference = 1e10;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 uv = clamp((base + offset + 0.5) / uAirSize, 0.5 / uAirSize, 1.0 - 0.5 / uAirSize);
      float difference = abs(distanceAt(uv) - center);
      vec4 value = texture2D(tAir, uv);
      value.rgb = value.rgb * value.rgb * 16.0;
      if (difference < nearestDifference) { nearestAir = value; nearestDifference = difference; }
      vec2 bilinear = mix(1.0 - f, f, offset);
      float weight = bilinear.x * bilinear.y * exp(-difference / max(0.25, center * 0.015));
      air += value * weight;
      total += weight;
    }
  }
  air = total > 0.00001 ? air / total : nearestAir;
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb * air.a + air.rgb, 1.0);
}
`

/** Half-resolution world-space single scattering, followed by bilateral reconstruction. */
export class VolumetricLight {
  readonly target: WebGLRenderTarget
  readonly airTarget: WebGLRenderTarget
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly material: ShaderMaterial
  private readonly composite: ShaderMaterial
  private readonly quad: Mesh<PlaneGeometry, ShaderMaterial>

  constructor(
    renderer: WebGLRenderer,
    mobile: boolean,
    cloudUniforms: Record<string, IUniform>,
    extinction: number,
    steps = mobile ? 16 : 32,
  ) {
    const type = renderer.extensions.has('EXT_color_buffer_float')
      ? HalfFloatType
      : UnsignedByteType
    this.target = new WebGLRenderTarget(1, 1, { type, depthBuffer: false })
    this.airTarget = new WebGLRenderTarget(1, 1, {
      type,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    })
    this.target.texture.name = 'Atmosphere composite'
    this.airTarget.texture.name = 'Air radiance / transmission'
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: { AIR_STEPS: steps },
      uniforms: {
        ...cloudUniforms,
        tDepth: { value: null },
        tTerrain: { value: null },
        uInverseProjection: { value: new Matrix4() },
        uCameraWorld: { value: new Matrix4() },
        uShadowMatrix: { value: new Matrix4() },
        uEye: { value: new Vector3() },
        uSunDirection: { value: new Vector3() },
        uSunRadiance: { value: new Color() },
        uAmbient: { value: new Color() },
        uExtinction: { value: extinction },
        uShadowBias: { value: 0 },
      },
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    })
    this.composite = new ShaderMaterial({
      vertexShader,
      fragmentShader: compositeShader,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tAir: { value: this.airTarget.texture },
        uAirSize: { value: new Vector2() },
        uCameraRange: { value: new Vector2() },
      },
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    })
    this.quad = new Mesh(this.geometry, this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  update(light: LightingState) {
    this.material.uniforms.uSunDirection!.value.copy(light.sunDirection)
    this.material.uniforms
      .uSunRadiance!.value.copy(light.sunColor)
      .multiplyScalar(light.sunIntensity)
    // Keep diffuse air fill subdued so cloud openings read as shafts, while
    // preserving the night haze. Direct light is still gated by world shadows.
    this.material.uniforms.uAmbient!.value.copy(light.haze).multiplyScalar(1 - light.daylight * 0.7)
  }

  resize(width: number, height: number) {
    this.target.setSize(width, height)
    this.airTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)))
    this.composite.uniforms.uAirSize!.value.set(this.airTarget.width, this.airTarget.height)
  }

  render(
    renderer: WebGLRenderer,
    input: WebGLRenderTarget,
    camera: PerspectiveCamera,
    light: DirectionalLight,
  ) {
    const previous = renderer.getRenderTarget()
    const u = this.material.uniforms
    u.tDepth!.value = input.depthTexture
    u.tTerrain!.value = light.shadow.map?.depthTexture
    u.uShadowMatrix!.value.copy(light.shadow.matrix)
    u.uShadowBias!.value = light.shadow.bias
    u.uInverseProjection!.value.copy(camera.projectionMatrixInverse)
    u.uCameraWorld!.value.copy(camera.matrixWorld)
    u.uEye!.value.copy(camera.position)
    this.composite.uniforms.tColor!.value = input.texture
    this.composite.uniforms.tDepth!.value = input.depthTexture
    this.composite.uniforms.uCameraRange!.value.set(camera.near, camera.far)
    try {
      this.quad.material = this.material
      renderer.setRenderTarget(this.airTarget)
      renderer.render(this.scene, this.camera)
      this.quad.material = this.composite
      renderer.setRenderTarget(this.target)
      renderer.render(this.scene, this.camera)
    } finally {
      renderer.setRenderTarget(previous)
    }
    return this.target.texture
  }

  dispose() {
    this.target.dispose()
    this.airTarget.dispose()
    this.material.dispose()
    this.composite.dispose()
    this.geometry.dispose()
  }
}

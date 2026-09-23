import {
  DoubleSide,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector4,
} from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'

import { WATER_LIGHTING_GLSL } from './water-lighting'

const VERTEX_SHADER = `
#include <common>
#include <shadowmap_pars_vertex>
uniform float uTime;
uniform mat4 textureMatrix;
varying vec3 vWorldPosition;
varying vec4 vMirrorCoord;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  // The coarse mesh only carries a long, shallow swell. Smaller waves live in
  // the fragment normal so the 1000-unit plane cannot reveal its triangles.
  world.y += sin(world.x * 0.16 + world.z * 0.10 + uTime * 0.29) * 0.027;
  vWorldPosition = world.xyz;
  vMirrorCoord = textureMatrix * vec4(position, 1.0);
  vec4 worldPosition = world;
  vec3 transformedNormal = normalize(normalMatrix * normal);
  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAGMENT_SHADER = `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
uniform float uTime;
uniform sampler2D uRippleMap;
uniform vec4 uRippleBounds;
uniform vec2 uRippleTexel;
uniform sampler2D tDiffuse;
uniform samplerCube uEnvironment;
varying vec3 vWorldPosition;
varying vec4 vMirrorCoord;

float waveHeight(vec2 p) {
  float t = uTime;
  float swell = sin(dot(p, vec2(0.22, 0.15)) + t * 0.31);
  float crossSwell = sin(dot(p, vec2(-0.15, 0.29)) - t * 0.25);
  vec2 flow = vec2(
    sin(dot(p, vec2(0.23, 0.19)) + t * 0.11),
    sin(dot(p, vec2(-0.18, 0.26)) - t * 0.09)
  );
  vec2 warped = p + vec2(crossSwell, swell) * 0.43 + flow * 0.70;
  float packetA = smoothstep(-0.65, 0.42,
    sin(p.x * 0.28 + p.y * 0.10 + flow.y * 0.65));
  float packetB = smoothstep(-0.58, 0.45,
    sin(p.x * -0.37 + p.y * 0.16 + flow.x * 0.53));
  float wave = swell * 0.034 + crossSwell * 0.021;
  wave += sin(dot(warped, vec2(0.37, 2.35)) + t * 0.78
    + sin(dot(p, vec2(0.51, 0.43))) * 0.72) * 0.011
    * (0.13 + packetA * 0.87);
  wave += sin(dot(warped, vec2(-0.48, 3.80)) - t * 0.65
    + sin(dot(p, vec2(-0.31, 0.61))) * 0.68) * 0.006
    * (0.12 + packetB * 0.88);
  wave += sin(dot(warped, vec2(1.07, 6.90)) + t * 1.12
    + flow.x * 0.73) * 0.0025 * packetA * packetB;
  return wave;
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash11(dot(i, vec2(127.1, 311.7)));
  float b = hash11(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7)));
  float c = hash11(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7)));
  float d = hash11(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 displayToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
    step(vec3(0.04045), c));
}

${WATER_LIGHTING_GLSL}

void main() {
  vec2 p = vWorldPosition.xz;
  float distanceToCamera = length(p - cameraPosition.xz);
  float farWater = smoothstep(12.0, 110.0, distanceToCamera);
  float nearWater = 1.0 - smoothstep(8.0, 32.0, distanceToCamera);
  vec2 rippleUv = (p - uRippleBounds.xy) / uRippleBounds.zw;
  vec2 du = vec2(uRippleTexel.x, 0.0);
  vec2 dv = vec2(0.0, uRippleTexel.x);
  vec2 gestureSlope = vec2(
    texture2D(uRippleMap, rippleUv + du).r - texture2D(uRippleMap, rippleUv - du).r,
    texture2D(uRippleMap, rippleUv + dv).r - texture2D(uRippleMap, rippleUv - dv).r
  ) / (2.0 * uRippleTexel.y);
  float inDomain = step(0.0, rippleUv.x) * step(rippleUv.x, 1.0)
    * step(0.0, rippleUv.y) * step(rippleUv.y, 1.0);
  gestureSlope *= inDomain;

  // Derivatives of one continuous height field give every highlight and
  // reflection the same wave direction. No cells or tiled ripple masks.
  float stepSize = 0.035;
  vec2 slope = vec2(
    waveHeight(p + vec2(stepSize, 0.0)) - waveHeight(p - vec2(stepSize, 0.0)),
    waveHeight(p + vec2(0.0, stepSize)) - waveHeight(p - vec2(0.0, stepSize))
  ) / (2.0 * stepSize);
  slope = slope * 0.72 + gestureSlope;
  vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  // Fine normals scatter points of light; only the long swell shapes the broad
  // sky reflection, preventing repeated horizontal stripes across the lake.
  float broadA = cos(dot(p, vec2(0.22, 0.15)) + uTime * 0.31) * 0.034;
  float broadB = cos(dot(p, vec2(-0.15, 0.29)) - uTime * 0.25) * 0.021;
  vec2 broadSlope = vec2(broadA * 0.22 - broadB * 0.15,
    broadA * 0.15 + broadB * 0.29);
  // Ripple slopes change the reflection angle and Fresnel, even where the
  // planar image is uniform. A screen-UV wobble alone disappears on dark water.
  vec3 skyNormal = normalize(vec3(-broadSlope.x - gestureSlope.x,
    1.0, -broadSlope.y - gestureSlope.y));
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float ndv = clamp(dot(skyNormal, viewDir), 0.0, 1.0);
  float fresnel = 0.0204 + 0.9796 * pow(1.0 - ndv, 5.0);
  // The sky and banks come from the current reflected scene, including the
  // moon and drifting clouds. Only the water's absorption tint is procedural.
  vec3 color = vec3(0.024, 0.039, 0.053);
  color += vec3(0.008, 0.012, 0.017) * farWater;
  color = mix(color, vec3(0.019, 0.033, 0.043), nearWater * 0.18);
  vec4 mirrorUv = vMirrorCoord;
  float reflectionDepth = 1.0 - smoothstep(8.0, 70.0, distanceToCamera);
  vec2 reflectionDrift = vec2(
    noise2D(p * vec2(0.22, 0.33) + vec2(uTime * 0.034, 0.0)),
    noise2D(p * vec2(0.29, 0.18) + vec2(0.0, -uTime * 0.026))
  ) - 0.5;
  mirrorUv.xy += (slope * vec2(0.055, 0.041)
    + reflectionDrift * vec2(0.0017, 0.0008)) * mirrorUv.w;
  vec2 blurOffset = vec2(0.0014 + reflectionDepth * 0.0011,
    0.00055 + reflectionDepth * 0.00055) * mirrorUv.w;
  vec4 mirrorLeft = mirrorUv;
  vec4 mirrorRight = mirrorUv;
  mirrorLeft.xy -= blurOffset;
  mirrorRight.xy += blurOffset;
  vec3 mirror = texture2DProj(tDiffuse, mirrorUv).rgb * 0.52;
  mirror += texture2DProj(tDiffuse, mirrorLeft).rgb * 0.24;
  mirror += texture2DProj(tDiffuse, mirrorRight).rgb * 0.24;
  // Apply the angular change in environment radiance continuously. Switching
  // between reflection sources based on ripple strength drew visible ring masks.
  vec3 calmNormal = normalize(vec3(-broadSlope.x, 1.0, -broadSlope.y));
  vec3 calmEnvironment = textureCube(uEnvironment, reflect(-viewDir, calmNormal)).rgb;
  vec3 rippleEnvironment = textureCube(uEnvironment, reflect(-viewDir, skyNormal)).rgb;
  mirror = max(mirror + rippleEnvironment - calmEnvironment, vec3(0.0));
  float mirrorStrength = fresnel;
  vec3 linearColor = displayToLinear(max(color, vec3(0.0)));
  linearColor = mix(linearColor, mirror, mirrorStrength);
  linearColor += waterLighting(normal, viewDir);
  gl_FragColor = vec4(linearColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** The renderer supplies current lights and shadow maps on every camera pass. */
export function createLakeWaterMaterial() {
  return new ShaderMaterial({
    name: 'RealtimeLakeWater',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    lights: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.lights,
      {
        uTime: { value: 0 },
        uEnvironment: { value: null },
        uRippleMap: { value: null },
        uRippleBounds: { value: new Vector4() },
        uRippleTexel: { value: new Vector2() },
      },
    ]),
    side: DoubleSide,
    depthWrite: true,
    depthTest: true,
    fog: false,
  })
}

export type LakeReflector = Reflector & { material: ShaderMaterial }

export function createLakeReflector(geometry: PlaneGeometry, mobile: boolean): LakeReflector {
  const base = createLakeWaterMaterial()
  const reflector = new Reflector(geometry, {
    textureWidth: mobile ? 384 : 1024,
    textureHeight: mobile ? 832 : 576,
    clipBias: 0.001,
    multisample: 0,
    shader: {
      name: 'LakeReflector',
      vertexShader: base.vertexShader,
      fragmentShader: base.fragmentShader,
      uniforms: {
        ...base.uniforms,
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
      },
    },
  }) as LakeReflector
  base.dispose()
  reflector.material.lights = true
  reflector.material.side = DoubleSide
  reflector.material.depthWrite = true
  reflector.material.depthTest = true
  reflector.material.fog = false
  reflector.material.toneMapped = true
  return reflector
}

import { DoubleSide, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'

import { LAMP_REFLECTIONS_GLSL } from './lake-lamp-reflections'

const VERTEX_SHADER = `
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
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAGMENT_SHADER = `
uniform float uTime;
uniform vec2 uResolution;
uniform vec4 uLampScreens[7];
uniform vec3 uPointer;
uniform vec4 uImpulses[10];
uniform sampler2D tDiffuse;
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

float smoothNoise(float p) {
  float i = floor(p);
  float f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
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

${LAMP_REFLECTIONS_GLSL}

void main() {
  vec2 p = vWorldPosition.xz;
  float distanceToCamera = length(p - cameraPosition.xz);
  float farWater = smoothstep(12.0, 110.0, distanceToCamera);
  float nearWater = 1.0 - smoothstep(8.0, 32.0, distanceToCamera);
  vec2 pointerDelta = p - uPointer.xy;
  float contactScale = clamp(length(uPointer.xy - cameraPosition.xz) * 0.06, 0.16, 1.0);
  float pointerDistance = length(pointerDelta) / contactScale;
  // A small breeze follows a nearby hand. Its broken wave fronts read as
  // disturbed water rather than a cursor disc laid on top of the lake.
  float touchFalloff = exp(-pointerDistance * pointerDistance * 0.085) * uPointer.z;
  float touchWave = sin(dot(pointerDelta / contactScale, vec2(1.8, 8.5)) - uTime * 3.9
    + noise2D(p * 3.1) * 5.5);
  float touchCrest = touchWave * touchFalloff;
  float impulseCrest = 0.0;
  float impulseTrough = 0.0;
  vec2 gestureSlope = normalize(pointerDelta + vec2(0.0001)) * touchCrest * 0.085;
  for (int i = 0; i < 10; i++) {
    vec4 impulse = uImpulses[i];
    float age = uTime - impulse.z;
    vec2 delta = p - impulse.xy;
    float rippleScale = clamp(length(impulse.xy - cameraPosition.xz) * 0.06, 0.16, 1.0);
    float radius = length(delta) / rippleScale;
    float fade = (1.0 - smoothstep(0.45, 3.1, age)) * impulse.w;
    float angle = atan(delta.y, delta.x);
    float irregularity = sin(angle * 5.0 + impulse.x) * 0.035
      + sin(angle * 9.0 - impulse.y) * 0.022;
    float front = radius - age * 2.6 - irregularity * radius;
    float ring = exp(-pow(front * 5.5, 2.0));
    float trailingRing = exp(-pow((front + 0.52) * 6.0, 2.0)) * 0.43;
    float trough = exp(-pow((front + 0.23) * 6.0, 2.0));
    float glints = 0.08 + 0.92 * smoothstep(-0.25, 0.8,
      sin(angle * 11.0 + radius * 2.1 + sin(angle * 7.0)));
    glints *= 0.4 + noise2D(p * 6.0) * 0.6;
    impulseCrest += (ring + trailingRing) * fade * glints;
    impulseTrough += trough * fade;
    gestureSlope += normalize(delta + vec2(0.0001))
      * (ring - trough + trailingRing) * fade * 0.25;
  }

  // Derivatives of one continuous height field give every highlight and
  // reflection the same wave direction. No cells or tiled ripple masks.
  float stepSize = 0.035;
  vec2 slope = vec2(
    waveHeight(p + vec2(stepSize, 0.0)) - waveHeight(p - vec2(stepSize, 0.0)),
    waveHeight(p + vec2(0.0, stepSize)) - waveHeight(p - vec2(0.0, stepSize))
  ) / (2.0 * stepSize);
  slope += gestureSlope;
  vec3 normal = normalize(vec3(-slope.x * 0.72, 1.0, -slope.y * 0.72));
  // Fine normals scatter points of light; only the long swell shapes the broad
  // sky reflection, preventing repeated horizontal stripes across the lake.
  float broadA = cos(dot(p, vec2(0.22, 0.15)) + uTime * 0.31) * 0.034;
  float broadB = cos(dot(p, vec2(-0.15, 0.29)) - uTime * 0.25) * 0.021;
  vec2 broadSlope = vec2(broadA * 0.22 - broadB * 0.15,
    broadA * 0.15 + broadB * 0.29);
  vec3 skyNormal = normalize(vec3(-broadSlope.x, 1.0, -broadSlope.y));
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float ndv = clamp(dot(skyNormal, viewDir), 0.0, 1.0);
  float fresnel = 0.025 + 0.975 * pow(1.0 - ndv, 5.0);
  vec3 reflected = reflect(-viewDir, skyNormal);
  float skyHorizon = 1.0 - smoothstep(-0.28, 0.48, reflected.y);
  float cloud = 0.5 + 0.5 * sin(reflected.x * 16.0
    + reflected.z * 11.0 + sin(p.x * 0.12 + p.y * 0.08) * 1.5);
  vec3 sky = mix(vec3(0.073, 0.097, 0.118), vec3(0.115, 0.147, 0.172), skyHorizon);
  sky *= 0.93 + cloud * 0.07;
  vec3 color = mix(vec3(0.024, 0.039, 0.053), sky, fresnel * 0.91);
  color += vec3(0.022, 0.033, 0.041) * farWater;
  // Wave packets share the height field's wind direction. Their irregular
  // envelopes keep each crest local rather than striping the whole lake.
  vec2 flowP = p + vec2(uTime * 0.065, -uTime * 0.045);
  float broadSheen = noise2D(flowP * vec2(0.12, 0.19));
  float packet = noise2D(flowP * vec2(2.7, 1.3) + vec2(7.2, 13.6));
  float finePacket = noise2D(flowP * vec2(3.9, 2.7));
  float crest = sin(dot(p, vec2(1.13, 12.35)) + uTime * 0.78
    + finePacket * 5.0 + sin(p.x * 2.1 + p.y * 0.43) * 1.2);
  float wavelets = smoothstep(0.80, 0.99, crest)
    * smoothstep(0.50, 0.78, packet) * (0.28 + finePacket * 0.72);
  color += vec3(0.010, 0.017, 0.025) * broadSheen;
  color += vec3(0.026, 0.037, 0.047) * wavelets
    * (0.80 - nearWater * 0.75);

  vec2 screenPx = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec3 lampLight = lampReflections(screenPx, slope, normal, skyNormal);

  color = mix(color, vec3(0.019, 0.033, 0.043), nearWater * 0.18);
  vec2 screenUv = screenPx / uResolution;
  color *= vec3(1.15, 1.08, 1.04);
  // The mirror texture contains the real voxel banks and trees. Its reflected
  // forms soften with distance from the shore, while the lower lake retains
  // the dark water color and moving facets.
  vec4 mirrorUv = vMirrorCoord;
  float reflectionDepth = smoothstep(0.63, 0.91, screenUv.y);
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
  float mirrorStrength = (0.25 + fresnel * 0.64) * (1.0 - nearWater * 0.38);
  mirrorStrength *= 1.0 - reflectionDepth * 0.78;
  vec3 linearColor = displayToLinear(max(color, vec3(0.0)));
  linearColor = mix(linearColor, mirror, mirrorStrength);
  // Lamp energy is additive after the bank mirror; mixing it into that mirror
  // would erase the brightest reflection precisely at the shoreline.
  linearColor += displayToLinear(max(lampLight, vec3(0.0)));
  // The crest catches the same cool night sky after the scene reflection is
  // composed, so a touch remains visible even on the darkest near water.
  float touchGlint = smoothstep(0.25, 0.95, touchWave)
    * touchFalloff * smoothstep(0.3, 0.65, noise2D(p * 4.7));
  linearColor *= 1.0 - min(impulseTrough * 0.28, 0.42);
  linearColor += displayToLinear(vec3(0.105, 0.145, 0.175) * touchGlint);
  linearColor += displayToLinear(vec3(0.28, 0.345, 0.39) * min(impulseCrest, 1.4));
  gl_FragColor = vec4(linearColor, 1.0);
  #include <colorspace_fragment>
}
`

/**
 * Update `uTime`, `uResolution`, and the supplied screens in place: normalized x/y contact,
 * intensity, warm flag. The Reflector supplies the planar scene texture.
 */
export function createLakeWaterMaterial(lampScreens: Vector4[]) {
  return new ShaderMaterial({
    name: 'ProceduralLakeWater',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uResolution: { value: new Vector2(1, 1) },
      uLampScreens: { value: lampScreens },
      uPointer: { value: new Vector3(0, 0, 0) },
      // A bounded ring buffer keeps each touch and each section of a wake alive.
      uImpulses: { value: Array.from({ length: 10 }, () => new Vector4(0, 0, -10, 0)) },
    },
    side: DoubleSide,
    depthWrite: true,
    depthTest: true,
    transparent: false,
    fog: false,
    toneMapped: true,
  })
}

export type LakeReflector = Reflector & { material: ShaderMaterial }

export function createLakeReflector(
  geometry: PlaneGeometry,
  lampScreens: Vector4[],
  mobile: boolean,
): LakeReflector {
  const base = createLakeWaterMaterial(lampScreens)
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
  // Reflector clones its uniforms. This array is updated in place each frame.
  reflector.material.uniforms.uLampScreens!.value = lampScreens
  reflector.material.side = DoubleSide
  reflector.material.depthWrite = true
  reflector.material.depthTest = true
  reflector.material.fog = false
  reflector.material.toneMapped = true
  return reflector
}

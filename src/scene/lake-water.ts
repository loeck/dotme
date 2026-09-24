import {
  Color,
  DoubleSide,
  LinearMipmapLinearFilter,
  Matrix4,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  UniformsLib,
  UniformsUtils,
} from 'three'
import type { PlaneGeometry } from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'

import { POINTER_LIGHT_GLSL, createPointerLightUniforms } from './pointer-light'
import { WATER_LIGHTING_GLSL } from './water-lighting'
import { WATER_INTERFACE_GLSL } from './water-optics'
import { WATER_FIELD_GLSL } from './water-surface'
import { createWindUniforms } from './wind'

const vertexShader = `
#include <common>
#include <shadowmap_pars_vertex>
${WATER_FIELD_GLSL}
uniform mat4 textureMatrix;
varying vec3 vWorldPosition;
varying vec4 vMirrorCoord;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  float height = heightAt(world.xz, 0.0);
  world.y += height;
  vWorldPosition = world.xyz;
  vMirrorCoord = textureMatrix * vec4(position.xy, position.z + height, 1.0);
  vec4 worldPosition = world;
  vec3 transformedNormal = normalize(normalMatrix * normal);
  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * world;
}
`
const fragmentShader = `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${WATER_FIELD_GLSL}
uniform sampler2D uRainSlopeMap;
uniform vec2 uRainResolution;
uniform float uRainSlopesEnabled;
uniform sampler2D tDiffuse;
uniform mat4 textureMatrix;
uniform sampler2D uBedColor;
uniform sampler2D uBedDepth;
uniform vec4 uBedAtlas;
uniform mat4 uFishInverseViewProjection;
uniform sampler2D uBedHeight;
uniform vec4 uBedFieldLayout;
uniform mat4 uBedInverseViewProjection;
uniform mat4 uBedViewProjection;
uniform vec2 uBedTexel;
uniform vec3 uPointer;
#ifdef ENVMAP_TYPE_CUBE_UV
uniform sampler2D uEnvironment;
#include <cube_uv_reflection_fragment>
#else
uniform samplerCube uEnvironment;
#endif
uniform vec3 uWaterScatter;
uniform float uWaterClarity;
uniform float uWaterAgitation;
varying vec3 vWorldPosition;
varying vec4 vMirrorCoord;
${WATER_LIGHTING_GLSL}
${POINTER_LIGHT_GLSL}
${WATER_INTERFACE_GLSL}
float contactNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec4 corners = vec4(dot(i, vec2(127.1,311.7)), dot(i+vec2(1,0), vec2(127.1,311.7)),
    dot(i+vec2(0,1), vec2(127.1,311.7)), dot(i+vec2(1,1), vec2(127.1,311.7)));
  vec4 values = fract(sin(corners) * 43758.5453);
  return mix(mix(values.x, values.y, f.x), mix(values.z, values.w, f.x), f.y);
}
vec3 bottomAt(vec2 uv) {
  vec4 view = uBedInverseViewProjection * vec4(uv * 2.0 - 1.0, texture2D(uBedDepth, uv * uBedAtlas.xy).r * 2.0 - 1.0, 1.0);
  return view.xyz / view.w;
}
// Clamp inside each atlas region so bilinear filtering never crosses its border.
float bedDepthAt(vec2 uv) {
  vec2 halfTexel = uBedFieldLayout.zw * 0.5;
  return texture2D(uBedHeight, clamp(uv * uBedFieldLayout.xy,
    halfTexel, uBedFieldLayout.xy - halfTexel)).r;
}
float shoreDistanceAt(vec2 uv) {
  vec2 start = vec2(0.0, uBedFieldLayout.y);
  vec2 halfTexel = uBedFieldLayout.zw * 0.5;
  vec2 coord = start + uv * vec2(1.0, 1.0 - start.y);
  return texture2D(uBedHeight, clamp(coord, start + halfTexel, vec2(1.0) - halfTexel)).r;
}
float wetHeight(vec2 p, float center) {
  // A zero-height sample inside a rock would tilt the normal into the rock,
  // visually swallowing the reflected wave at its strongest point.
  return shoreDistanceAt(fieldUv(p)) <= 0.0
    ? center : interactionHeight(p);
}
void main() {
  vec2 p = vWorldPosition.xz;
  // Estimate pixel coverage on the flat plane: displaced mesh triangles must
  // not introduce seams in the spectral filter at their shared edges.
  vec2 flatP = cameraPosition.xz + (p - cameraPosition.xz)
    * ((cameraPosition.y + 0.035) / max(0.001, cameraPosition.y - vWorldPosition.y));
  float footprint = max(length(dFdx(flatP)), length(dFdy(flatP)));
  float e = max(uCell, footprint * 0.5);
  vec2 state = texture2D(uState, clamp(fieldUv(p), 0.0, 1.0)).rg;
  vec2 rippleSlope = vec2(wetHeight(p + vec2(e,0.0), state.x) - wetHeight(p - vec2(e,0.0), state.x),
    wetHeight(p + vec2(0.0,e), state.x) - wetHeight(p - vec2(0.0,e), state.x)) / (2.0 * e);
  vec4 wind = windField(p, footprint);
  vec4 rainField = texture2D(uRainSlopeMap, gl_FragCoord.xy / uRainResolution) * uRainSlopesEnabled;
  vec2 slope = wind.yz + rippleSlope + rainField.xy;
  float shore = shoreDistanceAt(fieldUv(p));
  vec2 shoreNormal = vec2(0.0);
  if (shore < 1.95) {
    vec2 uv = fieldUv(p), stepUv = vec2(uCell / 160.0, 0.0);
    shoreNormal = vec2(shoreDistanceAt(uv + stepUv) - shoreDistanceAt(uv - stepUv),
      shoreDistanceAt(uv + stepUv.yx) - shoreDistanceAt(uv - stepUv.yx));
    shoreNormal /= max(length(shoreNormal), 0.0001);
    // Resolve the last sub-cell strip at the actual face. The total surface
    // turns along the wall while the simulated reflection travels back out.
    slope -= shoreNormal * dot(slope, shoreNormal)
      * (1.0 - smoothstep(0.0, uCell * 2.0, max(0.0, shore)));
  }
  vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 view = normalize(cameraPosition - vWorldPosition);
  float ndv = clamp(dot(normal, view), 0.0, 1.0);
  float fresnel = 0.02037 + 0.97963 * pow(1.0 - ndv, 5.0);
  float reveal = exp(-dot(p - uPointer.xy, p - uPointer.xy) / 2.8) * uPointer.z;
  float baseRoughness = mix(mix(0.035, 0.085, uWaterAgitation), 0.025, reveal);
  float roughness = sqrt(baseRoughness * baseRoughness + min(0.04, rainField.z));
  // Project a displaced reflection ray back onto the planar capture. The
  // offset scales with reflected depth and view angle, not a fixed UV wobble.
  vec3 reflectedRay = reflect(-view, normal);
  vec3 flatRay = reflect(-view, vec3(0.0, 1.0, 0.0));
  // A planar capture cannot resolve an arbitrarily long displaced ray. Bound
  // its travel so grazing ripples do not stretch bank texels into long bars.
  float rayDistance = mix(2.0, 8.0, 1.0 - ndv);
  vec3 offset = (reflectedRay - flatRay) * rayDistance;
  vec4 displacedMirror = vMirrorCoord + textureMatrix * vec4(offset.x, -offset.z, offset.y, 0.0);
  vec2 mirrorUv = displacedMirror.xy / displacedMirror.w;
  float edge = min(min(mirrorUv.x, mirrorUv.y), min(1.0-mirrorUv.x, 1.0-mirrorUv.y));
  // The sky is infinitely distant: sample it by reflection direction rather
  // than stretching its planar image as if it were an eight-metre-away bank.
  #ifdef ENVMAP_TYPE_CUBE_UV
    vec3 environment = textureCubeUV(uEnvironment, reflectedRay, max(roughness, WATER_ENVIRONMENT_ROUGHNESS)).rgb;
  #else
    vec3 environment = textureCube(uEnvironment, reflectedRay).rgb;
  #endif
  vec2 halfTexel = 0.5 / vec2(textureSize(tDiffuse, 0));
  // Capture alpha stores local scenery coverage; the sky writes zero.
  // Reuse that channel instead of spending a seventeenth fragment sampler.
  // One continuous, derivative-filtered footprint. The former five-tap cross
  // and forced extra mip level turned isolated rain glints into detached halos.
  // Trilinear mipmaps and anisotropy still filter stretched grazing reflections.
  vec4 local = texture2D(tDiffuse, clamp(mirrorUv, halfTexel, 1.0 - halfTexel));
  vec3 reflection = local.rgb + environment * (1.0 - clamp(local.a, 0.0, 1.0));
  reflection = mix(environment, reflection, smoothstep(0.0, 0.06, edge));

  vec3 refracted = refract(-view, normal, 1.0 / 1.333);
  // Intersect the world-space bed first. A screen-space depth alone can jump
  // between occluding ridges and draw vertical bands across the near lake.
  float depth = bedDepthAt(fieldUv(p));
  vec3 candidate = vWorldPosition;
  for (int i = 0; i < 4; i++) {
    candidate = vWorldPosition + refracted * min(18.0, max(0.02, depth + vWorldPosition.y + 0.035) / max(0.25, -refracted.y));
    depth = bedDepthAt(fieldUv(candidate.xz));
  }
  vec4 projected = uBedViewProjection * vec4(candidate, 1.0);
  vec2 projectedUv = projected.xy / projected.w * 0.5 + 0.5;
  float captureEdge = min(min(projectedUv.x, projectedUv.y), min(1.0 - projectedUv.x, 1.0 - projectedUv.y));
  vec2 refractUv = clamp(projectedUv, uBedTexel, 1.0 - uBedTexel);
  vec3 actualBottom = bottomAt(refractUv);
  // Reject samples above the surface or outside the bed, instead of dragging a bank into water.
  float valid = (1.0 - smoothstep(-0.06, -0.035, actualBottom.y))
    * (1.0 - smoothstep(0.5, 2.0, length(actualBottom - candidate)))
    * smoothstep(0.0, 0.045, captureEdge);
  float path = min(40.0, length(candidate - vWorldPosition));
  // The whole water column is clear in calm weather. Optical path length
  // retains the depth gradient; rain adds suspended haze.
  float nearShallow = (1.0 - smoothstep(2.8, 6.0, depth))
    * (1.0 - smoothstep(24.0, 48.0, length(cameraPosition.xz - p)));
  float clarity = max(uWaterClarity * (0.9 + 0.1 * nearShallow), reveal);
  vec3 absorption = mix(vec3(0.48, 0.22, 0.14), vec3(0.18, 0.035, 0.016), clarity);
  vec3 transmission = exp(-absorption * path);
  // Broad diagonal taps erased silhouettes smaller than a metre in the atlas.
  vec2 bedBlur = uBedTexel * mix(1.1, 0.18, clarity);
  vec3 bed = texture2D(uBedColor, refractUv * uBedAtlas.xy).rgb * 0.4;
  bed += texture2D(uBedColor, clamp(refractUv + bedBlur, uBedTexel, 1.0 - uBedTexel) * uBedAtlas.xy).rgb * 0.3;
  bed += texture2D(uBedColor, clamp(refractUv - bedBlur, uBedTexel, 1.0 - uBedTexel) * uBedAtlas.xy).rgb * 0.3;
  // Cloud cover also shades the moonlit scattering inside the water.
  float cloudVisibility = cloudShadow(vWorldPosition);
  vec3 scatter = uWaterScatter * mix(0.25, 1.0, cloudVisibility)
    * mix(vec3(1.18, 1.12, 0.92), vec3(0.8, 1.08, 1.12), uWaterClarity);
  vec3 transmitted = mix(scatter, bed * transmission + scatter * (1.0 - transmission), valid);
  // Fish occupy the second region of the same color/depth atlas. They are
  // absent from the main camera: reflections, highlights and foam always cover
  // their transmitted light, and wave normals gently distort the whole image.
  vec2 fishUv = clamp(gl_FragCoord.xy / uRainResolution + normal.xz * 0.0025,
    vec2(0.001), vec2(0.999));
  vec2 fishAtlasUv = vec2(0.0, uBedAtlas.y) + fishUv * uBedAtlas.zw;
  vec4 fish = texture2D(uBedColor, fishAtlasUv);
  if (fish.a > 0.001) {
    float fishZ = texture2D(uBedDepth, fishAtlasUv).r;
    vec4 fishPoint = uFishInverseViewProjection * vec4(fishUv * 2.0 - 1.0, fishZ * 2.0 - 1.0, 1.0);
    float fishDepth = max(0.0, (-0.035 - fishPoint.y / fishPoint.w) * 1.333);
    float fishPath = fishDepth / max(0.35, -refracted.y);
    vec3 fishTransmission = exp(-absorption * fishPath);
    // Color in the transparent capture is already premultiplied by alpha.
    transmitted = transmitted * (1.0 - fish.a) + fish.rgb * fishTransmission
      + scatter * (1.0 - fishTransmission) * fish.a;
  }
  // Preserve the readable shallow-water window under the smoother sky reflection.
  float shallowFresnel = waterReflectance(fresnel, length(cameraPosition.xz - p), uWaterClarity);
  float reflectedFraction = mix(shallowFresnel, min(shallowFresnel, 0.16), reveal * 0.85);
  vec3 color = mix(transmitted, reflection, reflectedFraction);

  float shorePixel = min(1.0, fwidth(shore));
  float foam = 0.0;
  if (shore < 1.95) {
    float distance = max(0.0, shore);
    float crest = smoothstep(-0.018, 0.04, wind.x + state.x);
    float impact = smoothstep(0.008, 0.12, abs(wind.w + state.y));
    float arrival = crest * mix(0.65, 1.0, impact);
    vec2 tangent = vec2(-shoreNormal.y, shoreNormal.x);
    vec2 anchor = p - shoreNormal * distance;
    float patches = contactNoise(anchor * 0.9 + tangent * uTime * 0.045);
    float width = max(mix(0.32, 1.15, arrival), shorePixel * 1.45)
      * mix(0.65, 1.0, patches);
    float contact = 1.0 - smoothstep(width * 0.25, width + shorePixel * 0.5, distance);
    // Froth drifts away from each face, shears around corners, and breaks into
    // lace as the wash thins. World-space flow keeps it attached during parallax.
    vec2 flow = p - shoreNormal * (uTime * 0.16 + crest * 0.12)
      - tangent * sin(uTime * 0.35 + patches * 6.0) * 0.09;
    float lace = contactNoise(flow * 3.2);
    float grain = mix(contactNoise(flow * 16.0), 0.5, smoothstep(0.035, 0.18, footprint));
    float breakup = smoothstep(0.24, 0.67, lace + grain * 0.18);
    float residual = mix(0.08, 0.6, smoothstep(0.32, 0.62, patches));
    float film = contact * mix(residual, 0.9, arrival) * mix(0.28, 1.0, breakup);
    // The expanding front detaches from the clinging film; scattered bubbles
    // survive briefly on its outer side instead of the whole outline blinking.
    float front = 1.0 - smoothstep(0.07 + shorePixel * 0.25, 0.19 + shorePixel * 0.6,
      abs(distance - width * 0.7));
    float fragments = front * arrival * smoothstep(0.38, 0.7, lace) * (1.0 - smoothstep(1.2, 1.9, distance));
    foam = min(0.92, film + fragments * 0.5);
  }
  foam = min(0.92, foam + rainField.a);
  color *= 1.0 - foam;
  color += waterLighting(normal, view, roughness, foam, cloudVisibility);
  // Broad local sheen follows the displaced normals rather than a screen-space halo.
  color += pointerLightAt(vWorldPosition, normal) * (0.006 + fresnel * 0.035) * (1.0 - foam * 0.65);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export type LakeReflector = Reflector & { material: ShaderMaterial }
export function createLakeReflector(
  geometry: PlaneGeometry,
  mobile: boolean,
  filteredEnvironment = true,
): LakeReflector {
  const reflector = new Reflector(geometry, {
    textureWidth: mobile ? 256 : 768,
    textureHeight: mobile ? 512 : 576,
    clipBias: 0.001,
    multisample: 0,
    shader: {
      name: 'LakeOptics',
      vertexShader,
      fragmentShader,
      uniforms: UniformsUtils.merge([
        UniformsLib.lights,
        {
          color: { value: null },
          ...createPointerLightUniforms(),
          tDiffuse: { value: null },
          textureMatrix: { value: null },
          uTime: { value: 0 },
          ...createWindUniforms(),
          uCell: { value: 0.16 },
          uRainSlopeMap: { value: null },
          uRainResolution: { value: new Vector2(1, 1) },
          uRainSlopesEnabled: { value: 0 },
          uState: { value: null },
          uMask: { value: null },
          uBedColor: { value: null },
          uBedDepth: { value: null },
          uBedAtlas: { value: new Vector4(1, 0.5, 1, 0.5) },
          uFishInverseViewProjection: { value: new Matrix4() },
          uBedHeight: { value: null },
          uBedFieldLayout: { value: new Vector4(0.5, 1 / 3, 1, 1) },
          uBedInverseViewProjection: { value: new Matrix4() },
          uBedViewProjection: { value: new Matrix4() },
          uBedTexel: { value: new Vector2(1, 1) },
          uPointer: { value: new Vector3() },
          uWaterScatter: { value: new Color().setRGB(0.0022, 0.0043, 0.0065) },
          uWaterClarity: { value: 1 },
          uWaterAgitation: { value: 0.2 },
          uEnvironment: { value: null },
        },
      ]),
    },
  }) as LakeReflector
  // Distorted reflection UVs cover many source texels at grazing angles.
  // Trilinear filtering removes the stair-step/moire pattern of a single level.
  const target = reflector.getRenderTarget()
  if (filteredEnvironment) {
    const cubeSize = mobile ? 64 : 128
    reflector.material.defines = {
      ENVMAP_TYPE_CUBE_UV: '',
      CUBEUV_TEXEL_WIDTH: 1 / (3 * Math.max(cubeSize, 112)),
      CUBEUV_TEXEL_HEIGHT: 1 / (4 * cubeSize),
      CUBEUV_MAX_MIP: Math.log2(cubeSize).toFixed(1),
      // Stay above the resolvable roughness of the 64/128-pixel source faces.
      WATER_ENVIRONMENT_ROUGHNESS: mobile ? 0.12 : 0.09,
    }
  }
  const reflectionTexture = target.texture
  reflectionTexture.generateMipmaps = true
  reflectionTexture.minFilter = LinearMipmapLinearFilter
  reflector.material.lights = true
  reflector.material.side = DoubleSide
  reflector.material.depthWrite = true
  reflector.material.fog = false
  return reflector
}

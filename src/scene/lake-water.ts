import {
  DoubleSide,
  LinearMipmapLinearFilter,
  Matrix4,
  ShaderMaterial,
  Vector2,
  Vector3,
  UniformsLib,
  UniformsUtils,
} from 'three'
import type { PlaneGeometry } from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'

import { CURSOR_GLOW_GLSL, createCursorGlowUniforms } from './cursor-glow'
import { WATER_LIGHTING_GLSL } from './water-lighting'
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
uniform sampler2D tDiffuse;
uniform mat4 textureMatrix;
uniform sampler2D uBedColor;
uniform sampler2D uBedDepth;
uniform sampler2D uBedHeight;
uniform sampler2D uShore;
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
varying vec3 vWorldPosition;
varying vec4 vMirrorCoord;
${WATER_LIGHTING_GLSL}
${CURSOR_GLOW_GLSL}
float contactNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec4 corners = vec4(dot(i, vec2(127.1,311.7)), dot(i+vec2(1,0), vec2(127.1,311.7)),
    dot(i+vec2(0,1), vec2(127.1,311.7)), dot(i+vec2(1,1), vec2(127.1,311.7)));
  vec4 values = fract(sin(corners) * 43758.5453);
  return mix(mix(values.x, values.y, f.x), mix(values.z, values.w, f.x), f.y);
}
vec3 bottomAt(vec2 uv) {
  vec4 view = uBedInverseViewProjection * vec4(uv * 2.0 - 1.0, texture2D(uBedDepth, uv).r * 2.0 - 1.0, 1.0);
  return view.xyz / view.w;
}
void main() {
  vec2 p = vWorldPosition.xz;
  // Estimate pixel coverage on the flat plane: displaced mesh triangles must
  // not introduce seams in the spectral filter at their shared edges.
  vec2 flatP = cameraPosition.xz + (p - cameraPosition.xz)
    * ((cameraPosition.y + 0.035) / max(0.001, cameraPosition.y - vWorldPosition.y));
  float footprint = max(length(dFdx(flatP)), length(dFdy(flatP)));
  float e = max(uCell, footprint * 0.5);
  vec2 rippleSlope = vec2(interactionHeight(p + vec2(e,0.0)) - interactionHeight(p - vec2(e,0.0)),
    interactionHeight(p + vec2(0.0,e)) - interactionHeight(p - vec2(0.0,e))) / (2.0 * e);
  vec4 wind = windField(p, footprint);
  vec2 slope = wind.yz + rippleSlope;
  vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 view = normalize(cameraPosition - vWorldPosition);
  float ndv = clamp(dot(normal, view), 0.0, 1.0);
  float fresnel = 0.02037 + 0.97963 * pow(1.0 - ndv, 5.0);
  float reveal = exp(-dot(p - uPointer.xy, p - uPointer.xy) / 2.8) * uPointer.z;
  float roughness = mix(0.065, 0.025, reveal);
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
  vec2 blur = 1.5 / vec2(textureSize(tDiffuse, 0));
  vec3 reflection = vec3(0.0);
  // Capture alpha stores local scenery coverage; the sky writes zero.
  // Reuse that channel instead of spending a seventeenth fragment sampler.
  for (int i = 0; i < 5; i++) {
    vec2 tap = vec2(0.0);
    if (i == 1) tap.x = blur.x;
    if (i == 2) tap.x = -blur.x;
    if (i == 3) tap.y = blur.y;
    if (i == 4) tap.y = -blur.y;
    vec2 uv = clamp(mirrorUv + tap, blur, 1.0 - blur);
    vec4 local = texture2D(tDiffuse, uv, 1.0);
    reflection += (local.rgb + environment * (1.0 - clamp(local.a, 0.0, 1.0)))
      * (i == 0 ? 0.333333333 : 0.166666667);
  }
  reflection = mix(environment, reflection, smoothstep(0.0, 0.06, edge));

  vec3 refracted = refract(-view, normal, 1.0 / 1.333);
  // Intersect the world-space bed first. A screen-space depth alone can jump
  // between occluding ridges and draw vertical bands across the near lake.
  float depth = texture2D(uBedHeight, clamp(fieldUv(p), 0.0, 1.0)).r;
  vec3 candidate = vWorldPosition;
  for (int i = 0; i < 4; i++) {
    candidate = vWorldPosition + refracted * min(18.0, max(0.02, depth + vWorldPosition.y + 0.035) / max(0.25, -refracted.y));
    depth = texture2D(uBedHeight, clamp(fieldUv(candidate.xz), 0.0, 1.0)).r;
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
  // Clear near-shore water lets the shallow relief and shoals read without
  // turning the distant, deep lake transparent. Hover opens a gentle window.
  float nearShallow = (1.0 - smoothstep(2.0, 4.5, depth))
    * (1.0 - smoothstep(20.0, 42.0, length(cameraPosition.xz - p)));
  float clarity = max(nearShallow, reveal);
  vec3 absorption = mix(vec3(0.85, 0.42, 0.27), vec3(0.26, 0.12, 0.085), clarity);
  vec3 transmission = exp(-absorption * path);
  // Broad diagonal taps erased silhouettes smaller than a metre in the atlas.
  vec2 bedBlur = uBedTexel * mix(1.1, 0.25, clarity);
  vec3 bed = texture2D(uBedColor, refractUv).rgb * 0.4;
  bed += texture2D(uBedColor, clamp(refractUv + bedBlur, 0.0, 1.0)).rgb * 0.3;
  bed += texture2D(uBedColor, clamp(refractUv - bedBlur, 0.0, 1.0)).rgb * 0.3;
  // Cloud cover also shades the moonlit scattering inside the water.
  float cloudVisibility = cloudShadow(vWorldPosition);
  vec3 scatter = vec3(0.0022, 0.0043, 0.0065) * mix(0.25, 1.0, cloudVisibility);
  vec3 transmitted = mix(scatter, bed * transmission + scatter * (1.0 - transmission), valid);
  // Preserve the readable shallow-water window under the smoother sky reflection.
  float shallowFresnel = mix(fresnel, min(fresnel, 0.32), nearShallow);
  float reflectedFraction = mix(shallowFresnel, min(shallowFresnel, 0.16), reveal * 0.85);
  vec3 color = mix(transmitted, reflection, reflectedFraction);

  // A narrow, broken foam line follows the real rock footprint and rises
  // with the arriving crest. No permanent white outline or emissive foam.
  float shore = texture2D(uShore, clamp(fieldUv(p), 0.0, 1.0)).r;
  float contact = 1.0 - smoothstep(0.04, 0.38 + min(0.2, footprint), max(0.0, shore));
  vec2 state = texture2D(uState, clamp(fieldUv(p), 0.0, 1.0)).rg;
  float arrival = smoothstep(-0.016, 0.032, wind.x + state.x)
    * smoothstep(-0.025, 0.045, wind.w + state.y * 0.5);
  float grain = mix(contactNoise(p * 7.0 + vec2(uTime * 0.06, 0.0)), 0.5,
    smoothstep(0.08, 0.3, footprint));
  float foam = contact * arrival * mix(0.3, 0.9, grain) * 0.65;
  color *= 1.0 - foam;
  color += waterLighting(normal, view, roughness, foam, cloudVisibility);
  // Broad, low-energy sheen for the diffuse cursor field; no point-source glint.
  color += cursorGlowAt(vWorldPosition, normal) * (0.004 + fresnel * 0.025);
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
          tDiffuse: { value: null },
          textureMatrix: { value: null },
          uTime: { value: 0 },
          ...createWindUniforms(),
          uCell: { value: 0.16 },
          uState: { value: null },
          uMask: { value: null },
          uBedColor: { value: null },
          uBedDepth: { value: null },
          uBedHeight: { value: null },
          uShore: { value: null },
          uBedInverseViewProjection: { value: new Matrix4() },
          uBedViewProjection: { value: new Matrix4() },
          uBedTexel: { value: new Vector2(1, 1) },
          uPointer: { value: new Vector3() },
          ...createCursorGlowUniforms(),
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

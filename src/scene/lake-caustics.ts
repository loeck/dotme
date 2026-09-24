import { Vector3 } from 'three'
import type { MeshStandardMaterial } from 'three'

import { WATER_LEVEL } from './lake-bed'
import { WIND_WAVES } from './water-surface'
import { createWindUniforms, updateWindUniforms } from './wind'
import type { WindState } from './wind'

type WaterPointer = Readonly<{ x: number; z: number }>

// These resolvable short waves make the light folds. Coefficients, dispersion,
// packet envelopes and phases come from the same spectrum as the visible water.
const FOCUS_WAVES = WIND_WAVES.filter(([, wavelength]) => wavelength <= 5.1 && wavelength >= 1.07)
const gl = (value: number) => value.toFixed(9)

const CAUSTICS_GLSL = `
varying vec3 vCausticWorld;
uniform float uTime;
uniform float uCausticStrength;
uniform vec2 uWindRotation;
uniform vec4 uWindResponse;
uniform vec3 uCausticPointer;

// Symmetric Hessian of the SAME surface height (xx, xz, zz). Analytic
// curvature avoids several full-spectrum samples or another capture pass.
vec3 causticCurvature(vec2 p, float footprint) {
  vec3 curvature = vec3(0.0);
  ${FOCUS_WAVES.map(([angle, wavelength, amplitude, initialPhase]) => {
    const k = (Math.PI * 2) / wavelength
    const omega = Math.sqrt(9.81 * k)
    const small = Math.max(0, Math.min(1, (5 - wavelength) / 5))
    return `{
      vec2 k = vec2(${gl(Math.cos(angle) * k)}, ${gl(Math.sin(angle) * k)});
      k = vec2(k.x * uWindRotation.x - k.y * uWindRotation.y, k.x * uWindRotation.y + k.y * uWindRotation.x);
      float spatial = dot(p, k);
      vec2 crossK = vec2(-k.y, k.x) * 0.18;
      float crossPhase = dot(p, crossK) + uTime * ${gl(omega * 0.025)} + ${gl(initialPhase * 1.7)};
      float phase = spatial - uTime * ${gl(omega)} + ${gl(initialPhase)} + 0.42 * sin(crossPhase * 0.57);
      vec2 phaseGradient = k + crossK * 0.2394 * cos(crossPhase * 0.57);
      float groupPhase = spatial * 0.14 - uTime * ${gl(omega * 0.07)} + ${gl(initialPhase * 2.3)};
      float alongPacket = 0.72 + 0.28 * cos(groupPhase);
      float crossPacket = 0.64 + 0.36 * cos(crossPhase);
      float packet = alongPacket * crossPacket;
      vec2 packetGradient = -k * 0.0392 * sin(groupPhase) * crossPacket
        -crossK * 0.36 * sin(crossPhase) * alongPacket;
      vec3 kk = vec3(k.x * k.x, k.x * k.y, k.y * k.y);
      vec3 cc = vec3(crossK.x * crossK.x, crossK.x * crossK.y, crossK.y * crossK.y);
      vec3 kc = vec3(2.0 * k.x * crossK.x, k.x * crossK.y + k.y * crossK.x, 2.0 * k.y * crossK.y);
      vec3 packetCurvature = -kk * 0.005488 * cos(groupPhase) * crossPacket
        -cc * 0.36 * cos(crossPhase) * alongPacket
        +kc * 0.014112 * sin(groupPhase) * sin(crossPhase);
      vec3 phaseCurvature = -cc * 0.136458 * sin(crossPhase * 0.57);
      vec3 phaseSquared = vec3(phaseGradient.x * phaseGradient.x,
        phaseGradient.x * phaseGradient.y, phaseGradient.y * phaseGradient.y);
      vec3 crossGradient = vec3(2.0 * phaseGradient.x * packetGradient.x,
        phaseGradient.x * packetGradient.y + phaseGradient.y * packetGradient.x,
        2.0 * phaseGradient.y * packetGradient.y);
      float strength = mix(uWindResponse.x, uWindResponse.y, ${gl(small)});
      float amplitude = ${gl(amplitude)} * (1.0 + ${gl(0.22 + small * 0.78)} * (strength - 1.0))
        * (1.0 - smoothstep(${gl(wavelength * 0.18)}, ${gl(wavelength * 0.5)}, footprint));
      curvature += amplitude * (sin(phase) * (packetCurvature - phaseSquared * packet)
        + cos(phase) * (phaseCurvature * packet + crossGradient));
    }`
  }).join('\n')}
  return curvature;
}

float lakeCausticLight(vec3 world) {
  float depth = ${WATER_LEVEL.toFixed(3)} - world.y;
  float depthFade = smoothstep(0.03, 0.24, depth) * (1.0 - smoothstep(2.0, 6.0, depth));
  float footprint = max(length(dFdx(world.xz)), length(dFdy(world.xz)));
  vec3 curvature = causticCurvature(world.xz, footprint);
  float distanceToPointer = length(world.xz - uCausticPointer.xy);
  float cursorFocus = 1.0 + 0.12 * exp(-distanceToPointer * 0.6) * uCausticPointer.z;
  // Approximate refracted-ray convergence. Its gain is deliberately stylized,
  // but every fold follows a real crest instead of sliding as a second layer.
  curvature *= min(depth, 2.5) * 2.8 * cursorFocus;
  float jacobian = (1.0 + curvature.x) * (1.0 + curvature.z) - curvature.y * curvature.y;
  float convergence = clamp(1.0 / max(0.35, jacobian) - 1.0, 0.0, 1.0);
  float width = max(fwidth(convergence) * 1.5, 0.025);
  float line = smoothstep(0.02 - width, 0.7 + width, convergence);
  return depthFade * uCausticStrength * line;
}
`

/** A material extension: no extra draw, texture or light, and no emissive glow. */
export class LakeCaustics {
  readonly uniforms = {
    uTime: { value: 0 },
    uCausticStrength: { value: 0.35 },
    ...createWindUniforms(),
    uCausticPointer: { value: new Vector3() },
  }
  private readonly restores = new Map<MeshStandardMaterial, () => void>()
  private previousTime = 0
  private initializedWind = false

  constructor(private readonly reducedMotion = false) {}

  applyTo(material: MeshStandardMaterial) {
    if (this.restores.has(material)) return
    const previousCompile = material.onBeforeCompile
    const previousCacheKey = material.customProgramCacheKey
    const cacheKey = material.customProgramCacheKey()
    const compile: typeof material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer)
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = `varying vec3 vCausticWorld;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 causticWorld = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          causticWorld = batchingMatrix * causticWorld;
        #endif
        #ifdef USE_INSTANCING
          causticWorld = instanceMatrix * causticWorld;
        #endif
        vCausticWorld = (modelMatrix * causticWorld).xyz;`,
      )
      shader.fragmentShader = `${CAUSTICS_GLSL}\n${shader.fragmentShader}`
        .replace(
          'void main() {',
          'void main() {\nfloat causticFocus = lakeCausticLight(vCausticWorld);',
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
        // Existing direct illumination already includes terrain/cloud shadows.
        // Caustics concentrate that light; darkness remains dark.
        reflectedLight.directDiffuse *= 1.0 + causticFocus;`,
        )
      // CursorGlow enters via diffuse irradiance rather than a Three light.
      // Concentrate only that existing local contribution, leaving ambient fill alone.
      shader.fragmentShader = shader.fragmentShader.replace(
        'irradiance += cursorGlowAt(',
        'irradiance += (1.0 + causticFocus) * cursorGlowAt(',
      )
    }
    material.onBeforeCompile = compile
    material.customProgramCacheKey = () => `${cacheKey}:lake-caustics-v2`
    material.needsUpdate = true
    this.restores.set(material, () => {
      if (material.onBeforeCompile !== compile) return
      material.onBeforeCompile = previousCompile
      material.customProgramCacheKey = previousCacheKey
      material.needsUpdate = true
    })
  }

  update(time: number, wind: WindState, lightStrength = 1, pointer: WaterPointer | null = null) {
    const dt = Math.max(0, Math.min(0.1, time - this.previousTime))
    this.previousTime = time
    this.uniforms.uTime.value = this.reducedMotion ? 0 : time
    // Irradiance itself already fades at night; preserve some pattern contrast
    // around lamps/cursor instead of applying the same linear attenuation twice.
    this.uniforms.uCausticStrength.value = 0.85 * Math.sqrt(Math.max(0, Math.min(1, lightStrength)))
    if (!this.reducedMotion || !this.initializedWind) {
      updateWindUniforms(this.uniforms, wind)
      this.initializedWind = true
    }
    const contact = this.uniforms.uCausticPointer.value
    if (pointer) {
      contact.x = pointer.x
      contact.y = pointer.z
    }
    const target = pointer && !this.reducedMotion ? 1 : 0
    contact.z += (target - contact.z) * (1 - Math.exp(-dt * 5))
  }

  dispose() {
    this.uniforms.uCausticStrength.value = 0
    for (const restore of this.restores.values()) restore()
    this.restores.clear()
  }
}

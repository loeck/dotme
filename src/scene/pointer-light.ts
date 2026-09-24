import { Vector3 } from 'three'
import type { MeshStandardMaterial } from 'three'

/** Local diffuse illumination: finite reach, broad emitter, no extra shadow map. */
export const POINTER_LIGHT_GLSL = `
uniform vec3 uPointerLightPosition;
uniform vec3 uPointerLightSource;
uniform float uPointerLightStrength;
vec3 pointerLightAt(vec3 worldPosition, vec3 worldNormal) {
  vec3 offset = worldPosition - uPointerLightPosition;
  float radius2 = dot(offset, offset) / 20.25;
  float falloff = exp(-radius2 * 3.5) * (1.0 - smoothstep(0.5, 1.0, radius2));
  vec3 toSource = uPointerLightSource - worldPosition;
  vec3 direction = toSource / max(length(toSource), 0.001);
  float facing = max(0.0, (dot(worldNormal, direction) + 0.18) / 1.18);
  return vec3(0.85, 1.02, 1.2) * facing * falloff * uPointerLightStrength;
}
`

export function createPointerLightUniforms() {
  return {
    uPointerLightPosition: { value: new Vector3() },
    uPointerLightSource: { value: new Vector3() },
    uPointerLightStrength: { value: 0 },
  }
}

export class PointerLight {
  readonly uniforms = createPointerLightUniforms()

  update(
    contact: Vector3 | null,
    rayDirection: Vector3,
    nightStrength: number,
    dt: number,
    frozen = false,
  ) {
    if (contact) {
      this.uniforms.uPointerLightPosition.value.copy(contact)
      // Put a broad virtual emitter on the camera-facing side of the surface.
      this.uniforms.uPointerLightSource.value.copy(contact).addScaledVector(rayDirection, -1.8)
      this.uniforms.uPointerLightSource.value.y += 0.6
    }
    const target = contact ? Math.max(0, Math.min(1, nightStrength)) : 0
    const strength = this.uniforms.uPointerLightStrength
    strength.value +=
      (target - strength.value) *
      (frozen || nightStrength <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) * 7))
    if (Math.abs(strength.value - target) < 0.0001) strength.value = target
  }

  /** Apply once to each engine-owned material, after its cloud-shadow hook. */
  applyTo(material: MeshStandardMaterial) {
    const previousCompile = material.onBeforeCompile
    const cacheKey = material.customProgramCacheKey()
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer)
      Object.assign(shader.uniforms, this.uniforms)
      shader.fragmentShader = `${POINTER_LIGHT_GLSL}\n${shader.fragmentShader}`.replace(
        '#include <lights_fragment_end>',
        `// Reuse Three's view-space position, including in reflection captures.
        vec3 pointerWorld = cameraPosition - vViewPosition * mat3(viewMatrix);
        // Foreground stone has deliberately dark baked albedo; give the diffuse
        // field enough irradiance to reveal it without adding an emissive overlay.
        irradiance += 4.0 * pointerLightAt(pointerWorld, inverseTransformDirection(normal, viewMatrix));
        #include <lights_fragment_end>`,
      )
    }
    material.customProgramCacheKey = () => `${cacheKey}:pointer-light-v2`
    material.needsUpdate = true
  }
}

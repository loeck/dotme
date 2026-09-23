import { Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { Object3D } from 'three'

/** A local diffuse field shared by the terrain, submerged bed and water. */
export const CURSOR_GLOW_GLSL = `
uniform vec3 uCursorGlowPosition;
uniform vec3 uCursorGlowSource;
uniform float uCursorGlowStrength;
vec3 cursorGlowAt(vec3 worldPosition, vec3 worldNormal) {
  vec3 offset = worldPosition - uCursorGlowPosition;
  float falloff = exp(-dot(offset, offset) / 10.24);
  vec3 toSource = uCursorGlowSource - worldPosition;
  vec3 direction = toSource / max(length(toSource), 0.001);
  // A broad emitter softly lights side faces while leaving opposing faces dark.
  float facing = clamp((dot(worldNormal, direction) + 0.35) / 1.35, 0.0, 1.0);
  return vec3(1.45, 1.42, 1.38) * facing * falloff * uCursorGlowStrength;
}
`

export function createCursorGlowUniforms() {
  return {
    uCursorGlowPosition: { value: new Vector3() },
    uCursorGlowSource: { value: new Vector3() },
    uCursorGlowStrength: { value: 0 },
  }
}

export class CursorGlow {
  readonly uniforms = createCursorGlowUniforms()

  attachSurfaces(root: Object3D) {
    const attached = new Set<MeshStandardMaterial>()
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof MeshStandardMaterial) || attached.has(material)) continue
        attached.add(material)
        material.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, this.uniforms)
          shader.vertexShader =
            `varying vec3 vCursorGlowWorldPosition;\n${shader.vertexShader}`.replace(
              '#include <project_vertex>',
              `
              #include <project_vertex>
              vec4 cursorWorld = vec4(transformed, 1.0);
              #ifdef USE_INSTANCING
                cursorWorld = instanceMatrix * cursorWorld;
              #endif
              vCursorGlowWorldPosition = (modelMatrix * cursorWorld).xyz;
            `,
            )
          shader.fragmentShader =
            `varying vec3 vCursorGlowWorldPosition;\n${CURSOR_GLOW_GLSL}\n${shader.fragmentShader}`.replace(
              '#include <lights_fragment_end>',
              `
              // Feed irradiance through the material's diffuse response, preserving
              // its albedo and energy balance instead of adding a colored overlay.
              irradiance += cursorGlowAt(vCursorGlowWorldPosition,
                inverseTransformDirection(normal, viewMatrix));
              #include <lights_fragment_end>
            `,
            )
        }
        material.customProgramCacheKey = () => 'cursor-diffuse-glow-v2'
      }
    })
  }
}

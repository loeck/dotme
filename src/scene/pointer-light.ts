import { exp, max, normalWorld, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl'
import { IrradianceNode, Vector3 } from 'three/webgpu'
import type { MeshStandardNodeMaterial, Node } from 'three/webgpu'
export function createPointerLightUniforms() {
  return {
    uPointerLightPosition: uniform(new Vector3()),
    uPointerLightSource: uniform(new Vector3()),
    uPointerLightStrength: uniform(0),
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

  applyTo(material: MeshStandardNodeMaterial) {
    const light = new IrradianceNode(
      pointerLightAt(positionWorld, normalWorld, this.uniforms).mul(4),
    )
    const setup = material.setupMaterialLightings.bind(material)
    const cacheKey = material.customProgramCacheKey.bind(material)
    // Irradiance must pass through diffuse BRDF and occlusion, just like ambient
    // light. An emissive overlay bypasses both and overexposes the dark shore.
    material.setupMaterialLightings = (builder) => [...setup(builder), light]
    material.customProgramCacheKey = () =>
      `${cacheKey()}:pointer-irradiance:${this.uniforms.uPointerLightStrength.id}`
    material.needsUpdate = true
  }
}
export type PointerLightUniforms = ReturnType<typeof createPointerLightUniforms>
export function pointerLightAt(world: Node<'vec3'>, normal: Node<'vec3'>, u: PointerLightUniforms) {
  const offset = world.sub(u.uPointerLightPosition),
    radius2 = offset.dot(offset).div(20.25)
  const falloff = exp(radius2.mul(-3.5)).mul(smoothstep(0.5, 1, radius2).oneMinus())
  const source = u.uPointerLightSource.sub(world),
    direction = source.div(max(source.length(), 0.001))
  const facing = max(0, normal.dot(direction).add(0.18).div(1.18))
  return vec3(0.85, 1.02, 1.2).mul(facing).mul(falloff).mul(u.uPointerLightStrength)
}

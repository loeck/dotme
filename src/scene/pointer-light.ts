import {
  clamp,
  exp,
  max,
  normalWorld,
  normalize,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl'
import { IrradianceNode, Vector3 } from 'three/webgpu'
import type { MeshStandardNodeMaterial, Node } from 'three/webgpu'
export function createPointerLightUniforms() {
  return {
    uPointerLightPosition: uniform(new Vector3()),
    uPointerLightSource: uniform(new Vector3()),
    uPointerLightStrength: uniform(0),
  }
}

/**
 * Depth change along the view ray that a moving cursor can make without a dip: at least a
 * metre, and a share of the distance, because on a surface seen at a grazing angle far away
 * one pixel of movement already spans tens of centimetres of depth.
 */
const POINTER_LIGHT_JUMP = 1
const POINTER_LIGHT_JUMP_SHARE = 0.35

export class PointerLight {
  readonly uniforms = createPointerLightUniforms()

  update(
    contact: Vector3 | null,
    rayDirection: Vector3,
    nightStrength: number,
    dt: number,
    frozen = false,
    /** The camera position; without it only the fixed one-metre threshold applies. */
    rayOrigin?: Vector3,
  ) {
    const strength = this.uniforms.uPointerLightStrength
    if (contact && !frozen && strength.value > 0) {
      // When the cursor crosses a silhouette the surface under it can jump tens of metres
      // in depth. Rekindle the light there instead of teleporting a full-strength pool.
      const previous = this.uniforms.uPointerLightPosition.value
      const jump = Math.abs(
        (contact.x - previous.x) * rayDirection.x +
          (contact.y - previous.y) * rayDirection.y +
          (contact.z - previous.z) * rayDirection.z,
      )
      const near = rayOrigin
        ? Math.min(rayOrigin.distanceTo(contact), rayOrigin.distanceTo(previous))
        : 0
      const threshold = Math.max(POINTER_LIGHT_JUMP, near * POINTER_LIGHT_JUMP_SHARE)
      if (jump > threshold) strength.value *= Math.exp((threshold - jump) / 6)
    }
    if (contact) {
      this.uniforms.uPointerLightPosition.value.copy(contact)
      // Put a broad virtual emitter on the camera-facing side of the surface.
      this.uniforms.uPointerLightSource.value.copy(contact).addScaledVector(rayDirection, -1.8)
      this.uniforms.uPointerLightSource.value.y += 0.6
    }
    const target = contact ? Math.max(0, Math.min(1, nightStrength)) : 0
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

/** Height of the cursor's lantern above the surface it lights, in metres. */
const POINTER_LANTERN_HEIGHT = 0.35

/**
 * Specular reflection of the night cursor on water, as if a small lantern hung just
 * above the point. Water is almost purely specular, so the diffuse pool barely shows
 * there; this glint sits a little below the point on screen and the waves break it
 * into a short shimmering streak. Bounded by inverse-square falloff from the lantern.
 */
export function pointerLanternGlint(
  world: Node<'vec3'>,
  normal: Node<'vec3'>,
  view: Node<'vec3'>,
  u: PointerLightUniforms,
) {
  const toLantern = u.uPointerLightPosition.add(vec3(0, POINTER_LANTERN_HEIGHT, 0)).sub(world)
  const half = normalize(normalize(toLantern).add(view))
  const lobe = clamp(normal.dot(half), 0, 1).pow(520)
  const falloff = toLantern.dot(toLantern).mul(0.12).add(1).reciprocal()
  return vec3(0.85, 1.02, 1.2).mul(lobe).mul(falloff).mul(u.uPointerLightStrength)
}

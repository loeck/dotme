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
import { IrradianceNode, Vector3, Vector4 } from 'three/webgpu'
import type { MeshStandardNodeMaterial, Node } from 'three/webgpu'
/** Radius of the cursor's pool on a near surface, metres. */
const POINTER_LIGHT_RADIUS = 4.5
/**
 * Past this distance the pool widens and stretches along the view ray: a crown is a loose cloud
 * of cards, and the pick sphere the ray stops on sits in front of most of them. A pool sized for
 * the near bank lit only the few cards on that sphere, so a far tree under the cursor stayed dark.
 */
const POINTER_LIGHT_NEAR = 25

function createPointerLightUniforms() {
  return {
    uPointerLightPosition: uniform(new Vector3()),
    uPointerLightSource: uniform(new Vector3()),
    uPointerLightStrength: uniform(0),
    /** View-ray direction (xyz) and the pool's radius in metres (w). */
    uPointerLightReach: uniform(new Vector4(0, 0, -1, POINTER_LIGHT_RADIUS)),
  }
}

/**
 * Depth change along the view ray that a moving cursor can make without a dip: at least a
 * metre, and a share of the distance, because on a surface seen at a grazing angle far away
 * one pixel of movement already spans tens of centimetres of depth.
 */
const POINTER_LIGHT_JUMP = 1
const POINTER_LIGHT_JUMP_SHARE = 0.35

/** How a material takes the cursor's light; the defaults suit opaque ground and rock. */
export type PointerLightResponse = Readonly<{
  /** Share (0–1) of the light a thin card or blade passes to its unlit side. */
  translucency?: number
  /** Multiplier on the irradiance, for surfaces that hide most of it otherwise. */
  gain?: number
}>

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
      // Far away the ray hops between crowns and the ridge behind them as the cursor moves;
      // those hops dim it less, or a far wood flickered dark under a moving cursor.
      if (jump > threshold) strength.value *= Math.exp((threshold - jump) / Math.max(6, near * 0.2))
    }
    if (contact) {
      const distance = rayOrigin ? rayOrigin.distanceTo(contact) : 0
      this.uniforms.uPointerLightReach.value.set(
        rayDirection.x,
        rayDirection.y,
        rayDirection.z,
        POINTER_LIGHT_RADIUS + Math.max(0, distance - POINTER_LIGHT_NEAR) * 0.04,
      )
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

  applyTo(material: MeshStandardNodeMaterial, response: PointerLightResponse = {}) {
    const { translucency = 0, gain = 1 } = response
    const light = new IrradianceNode(
      pointerLightAt(positionWorld, normalWorld, this.uniforms, translucency).mul(4 * gain),
    )
    const setup = material.setupMaterialLightings.bind(material)
    const cacheKey = material.customProgramCacheKey.bind(material)
    // Irradiance must pass through diffuse BRDF and occlusion, just like ambient
    // light. An emissive overlay bypasses both and overexposes the dark shore.
    material.setupMaterialLightings = (builder) => [...setup(builder), light]
    material.customProgramCacheKey = () =>
      `${cacheKey()}:pointer-irradiance:${this.uniforms.uPointerLightStrength.id}:${translucency}:${gain}`
    material.needsUpdate = true
  }
}
export type PointerLightUniforms = ReturnType<typeof createPointerLightUniforms>
export function pointerLightAt(
  world: Node<'vec3'>,
  normal: Node<'vec3'>,
  u: PointerLightUniforms,
  translucency = 0,
) {
  const offset = world.sub(u.uPointerLightPosition)
  const ray = u.uPointerLightReach.xyz,
    radius = u.uPointerLightReach.w
  // Depth along the view ray counts for less on a far surface (see POINTER_LIGHT_NEAR).
  const along = offset.dot(ray)
  const depthScale = radius.div(POINTER_LIGHT_RADIUS).pow2().pow2()
  const across = offset.sub(ray.mul(along))
  const radius2 = across.dot(across).add(along.mul(along).div(depthScale)).div(radius.mul(radius))
  const falloff = exp(radius2.mul(-3.5)).mul(smoothstep(0.5, 1, radius2).oneMinus())
  const source = u.uPointerLightSource.sub(world),
    direction = source.div(max(source.length(), 0.001))
  const cosine = normal.dot(direction)
  const front = max(0, cosine.add(0.18).div(1.18))
  const facing = translucency > 0 ? max(front, cosine.negate().mul(translucency)) : front
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

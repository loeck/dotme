import { float, mix, smoothstep, uniform, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Snow lying on the scene, 0–1 (`SceneWeatherState.snowCover`), shared by every material that
 * takes it: one uniform, written once a frame, so a snowfall never compiles anything.
 */
export const snowCover = uniform(0)

/** Fresh snow: bright, faintly blue in its shadows, and matte. */
const SNOW_ALBEDO = vec3(0.8, 0.83, 0.88)
export const SNOW_ROUGHNESS = 0.82

/**
 * How much of a surface the snow covers: upward faces first, the flattest at the lightest
 * dusting, steeper ones as it deepens, broken up by `grain` (−1…1 noise) so the edge is not a
 * contour line. `up` is the world normal's y.
 */
export function snowShare(up: Node<'float'>, grain: Node<'float'> = float(0), scale = 1) {
  const edge = mix(float(0.97), float(0.5), snowCover)
  return smoothstep(edge, edge.add(0.14), up.add(grain.mul(0.1)))
    .mul(smoothstep(0, 0.2, snowCover))
    .mul(scale)
}

/** `albedo` under a cover of `share`. */
export function snowAlbedo(albedo: Node<'vec3'>, share: Node<'float'>) {
  return mix(albedo, SNOW_ALBEDO, share)
}

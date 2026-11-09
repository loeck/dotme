import type { PerspectiveCamera, Vector2 } from 'three/webgpu'

export const CAMERA_REST = { x: 0, y: 2.3, z: 16 } as const
const CAMERA_PARALLAX = { x: 1.9, y: 0.16 } as const
export const CAMERA_IDLE_DRIFT = 0.15
export const ENVIRONMENT_PROBE = { x: 0, y: 3, z: -18 } as const

/** The camera eases toward this target, so it never leaves the targets' bounding box. */
function cameraTarget(pointerX: number, pointerY: number, drift: number) {
  return {
    x: pointerX * CAMERA_PARALLAX.x + drift,
    y: CAMERA_REST.y - pointerY * CAMERA_PARALLAX.y,
  }
}

/**
 * Eases the camera toward the pointer's (or the tilt's) parallax target by `parallax` (0–1)
 * with a slow idle drift, keeping it at rest depth and looking across the lake.
 */
export function easeCamera(
  camera: PerspectiveCamera,
  pointer: Vector2,
  target: Vector2,
  parallax: number,
  drift: number,
  mobile: boolean,
) {
  pointer.lerp(target, parallax)
  const eased = cameraTarget(pointer.x, pointer.y, drift)
  camera.position.x += (eased.x - camera.position.x) * parallax
  camera.position.y += (eased.y - camera.position.y) * parallax
  camera.position.z = CAMERA_REST.z
  camera.lookAt(camera.position.x * 0.22, mobile ? 2.3 : 7.3, -25)
  camera.updateMatrixWorld()
}

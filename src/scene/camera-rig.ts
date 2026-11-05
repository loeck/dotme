export const CAMERA_REST = { x: 0, y: 2.3, z: 16 } as const
export const CAMERA_PARALLAX = { x: 1.9, y: 0.16 } as const
export const CAMERA_IDLE_DRIFT = 0.15
export const ENVIRONMENT_PROBE = { x: 0, y: 3, z: -18 } as const

/** The camera eases toward this target, so it never leaves the targets' bounding box. */
export function cameraTarget(pointerX: number, pointerY: number, drift: number) {
  return {
    x: pointerX * CAMERA_PARALLAX.x + drift,
    y: CAMERA_REST.y - pointerY * CAMERA_PARALLAX.y,
  }
}

import { WATER_LEVEL } from './lake-bed'

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

type Eye = readonly [number, number, number]

/** Corners of every viewpoint region that renders terrain: the camera range, its
 * mirror image below the lake reflection plane and the environment probe.
 * A face that is back-facing to all of them is back-face culled in every pass. */
export function terrainEyes(margin = 0.25): Eye[] {
  const x = CAMERA_PARALLAX.x + CAMERA_IDLE_DRIFT + margin
  const low = CAMERA_REST.y - CAMERA_PARALLAX.y - margin
  const high = CAMERA_REST.y + CAMERA_PARALLAX.y + margin
  const eyes: Eye[] = []
  for (const ex of [-x, x])
    for (const ey of [low, high])
      for (const ez of [CAMERA_REST.z - margin, CAMERA_REST.z + margin])
        eyes.push([ex, ey, ez], [ex, 2 * WATER_LEVEL - ey, ez])
  for (const dx of [-margin, margin])
    for (const dy of [-margin, margin])
      for (const dz of [-margin, margin])
        eyes.push([ENVIRONMENT_PROBE.x + dx, ENVIRONMENT_PROBE.y + dy, ENVIRONMENT_PROBE.z + dz])
  return eyes
}

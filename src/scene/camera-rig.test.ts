import { expect, it } from 'vitest'

import {
  CAMERA_IDLE_DRIFT,
  CAMERA_REST,
  cameraTarget,
  ENVIRONMENT_PROBE,
  terrainEyes,
} from './camera-rig'

it('keeps every reachable camera target inside the eyes used for static face culling', () => {
  const eyes = terrainEyes()
  const bound = (axis: 0 | 1 | 2) => [
    Math.min(...eyes.map((eye) => eye[axis])),
    Math.max(...eyes.map((eye) => eye[axis])),
  ]
  const [minX, maxX] = bound(0)
  const [minY, maxY] = bound(1)
  const [minZ, maxZ] = bound(2)
  for (const px of [-1, -0.3, 0, 1])
    for (const py of [-1, 0.4, 1])
      for (const drift of [-CAMERA_IDLE_DRIFT, 0, CAMERA_IDLE_DRIFT]) {
        const { x, y } = cameraTarget(px, py, drift)
        expect(x).toBeGreaterThan(minX ?? Infinity)
        expect(x).toBeLessThan(maxX ?? -Infinity)
        expect(y).toBeGreaterThan(minY ?? Infinity)
        expect(y).toBeLessThan(maxY ?? -Infinity)
      }
  expect(CAMERA_REST.z).toBeGreaterThan(minZ ?? Infinity)
  expect(ENVIRONMENT_PROBE.z).toBeGreaterThan(minZ ?? Infinity)
  expect(CAMERA_REST.z).toBeLessThan(maxZ ?? -Infinity)
})

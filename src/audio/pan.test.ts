import { expect, it } from 'vitest'

import { panFromCamera, panFromCameraMatrix, windPanFromCamera } from './pan'

// A camera looking down -z (north), right along +x, at the origin, as three.js builds it.
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const right = { x: 1, y: 0, z: 0 },
  forward = { x: 0, y: 0, z: -1 }

it('pans by azimuth, keeping sources behind the camera on their own side', () => {
  expect(panFromCamera(right, forward, { x: 0, y: 0, z: -10 })).toBe(0)
  expect(panFromCamera(right, forward, { x: 10, y: 0, z: 0 })).toBe(1)
  expect(panFromCamera(right, forward, { x: -10, y: 3, z: 0 })).toBe(-1)
  const frontRight = panFromCamera(right, forward, { x: 5, y: 0, z: -5 })
  const behindRight = panFromCamera(right, forward, { x: 5, y: 0, z: 5 })
  expect(frontRight).toBeCloseTo(Math.SQRT1_2)
  // A screen projection mirrors this one to the left; the azimuth keeps it right.
  expect(behindRight).toBeCloseTo(Math.SQRT1_2)
  expect(panFromCamera(right, forward, { x: 0, y: 5, z: 0 })).toBe(0)
  expect(panFromCamera(right, forward, { x: Number.NaN, y: 0, z: 1 })).toBe(0)
})

it('reads the camera from its world matrix, position included', () => {
  expect(panFromCameraMatrix(identity, { x: 3, y: 0, z: 0 })).toBe(1)
  const moved = [...identity.slice(0, 12), 10, 0, 0, 1]
  expect(panFromCameraMatrix(moved, { x: 3, y: 0, z: 0 })).toBe(-1)
  // Turned to face east (+x): right is now +z (south).
  const east = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1]
  expect(panFromCameraMatrix(east, { x: 0, y: 0, z: 4 })).toBeCloseTo(1)
  expect(panFromCameraMatrix([], { x: 1, y: 0, z: 0 })).toBe(0)
})

it('hears the wind from upwind', () => {
  // Wind blowing towards +x comes from the west, the camera's left.
  expect(windPanFromCamera(identity, [1, 0])).toBe(-1)
  expect(windPanFromCamera(identity, [0, 1])).toBe(0)
})

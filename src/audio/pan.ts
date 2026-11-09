import { clampPan } from './units'

export type Vector3Like = Readonly<{ x: number; y: number; z: number }>

const dot = (a: Vector3Like, b: Vector3Like) => a.x * b.x + a.y * b.y + a.z * b.z

/**
 * Stereo position of a sound at `offset` from the listener (point minus camera position), for a
 * camera looking along `forward` with `right` to its right. The result is the sine of the
 * sound's azimuth in the camera's horizontal plane: 0 straight ahead or behind, ±1 to either
 * side. Unlike a screen projection, a source behind the camera keeps its side instead of being
 * mirrored, and nothing explodes as it crosses the camera plane.
 */
export function panFromCamera(right: Vector3Like, forward: Vector3Like, offset: Vector3Like) {
  const side = dot(right, offset),
    ahead = dot(forward, offset)
  const length = Math.hypot(side, ahead)
  return length > 1e-9 ? clampPan(side / length) : 0
}

/**
 * Right and forward axes and position of a camera from its column-major world matrix (three.js
 * `camera.matrixWorld.elements`): column 0 is the right, column 2 the back (a camera looks
 * down -z) and column 3 the position.
 */
function cameraBasis(elements: ArrayLike<number>) {
  const at = (index: number) => elements[index] ?? 0
  return {
    right: { x: at(0), y: at(1), z: at(2) },
    forward: { x: -at(8), y: -at(9), z: -at(10) },
    position: { x: at(12), y: at(13), z: at(14) },
  }
}

/** `panFromCamera` for a world-space point, from the camera's world matrix. */
export function panFromCameraMatrix(elements: ArrayLike<number>, point: Vector3Like) {
  const { right, forward, position } = cameraBasis(elements)
  return panFromCamera(right, forward, {
    x: point.x - position.x,
    y: point.y - position.y,
    z: point.z - position.z,
  })
}

/**
 * Where the wind is heard from, for `AmbientEnvironment.windPan`: `direction` is the horizontal
 * direction the wind blows towards (`WindState.direction`, [x, z]), so the sound arrives from
 * the opposite side, upwind of the camera.
 */
export function windPanFromCamera(
  elements: ArrayLike<number>,
  direction: readonly [number, number],
) {
  const { right, forward } = cameraBasis(elements)
  return panFromCamera(right, forward, { x: -direction[0], y: 0, z: -direction[1] })
}

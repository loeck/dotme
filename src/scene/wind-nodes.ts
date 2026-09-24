import { uniform } from 'three/tsl'
import { Vector2, Vector4 } from 'three/webgpu'

/** GPU bindings are separate from the deterministic CPU wind model. */
export function createWindUniforms() {
  return {
    uWindRotation: uniform(new Vector2(1, 0)),
    uWindRotationVelocity: uniform(0),
    uWindResponse: uniform(new Vector4(1, 1, 0, 0)),
  }
}

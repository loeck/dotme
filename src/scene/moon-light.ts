import { Vector3 } from 'three'

/** Offset from the light's target, shared by the scene and future cloud captures. */
export function sampleMoonLight(time: number) {
  const orbit = time * 0.035
  return {
    offset: new Vector3(-35 + Math.sin(orbit) * 12, 48 + Math.sin(orbit * 0.7) * 4, -20),
    intensity: 1.5 * (0.94 + Math.sin(orbit * 1.3) * 0.06),
  }
}

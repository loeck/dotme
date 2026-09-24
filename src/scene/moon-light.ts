import { sampleLighting } from './lighting'

/** Compatibility helper for the isolated night-light GPU experiments. */
export function sampleMoonLight(time: number) {
  const light = sampleLighting(0, time)
  return { offset: light.direction.clone().multiplyScalar(180), intensity: light.intensity }
}

import { PlaneGeometry } from 'three'

import { LAKE_BOUNDS } from './lake-bed'

// A narrow wind spectrum plus two crossing swells. Incommensurate wavelengths
// and phases produce evolving packets instead of parallel, repeating stripes.
export const WIND_WAVES = [
  [0.55, 12.7, 0.024, 1.3],
  [1.92, 8.3, 0.016, 4.7],
  [0.83, 5.1, 0.014, 2.1],
  [0.31, 3.6, 0.011, 5.8],
  [0.97, 2.4, 0.008, 0.4],
  // Calm wind: fade short, fast waves before they dominate the lamp glints.
  // Keep this spectrum uniform across the lake, including the lit left bank.
  [0.63, 1.61, 0.0048, 3.2],
  [1.15, 1.07, 0.0024, 5.1],
  [0.38, 0.72, 0.0012, 1.7],
  [0.78, 0.49, 0.00055, 4.2],
  [1.02, 0.33, 0.00025, 0.9],
  [0.49, 0.22, 0.0001, 3.8],
  [0.86, 0.145, 0.00004, 2.6],
] as const

export function swellHeight(x: number, z: number, time: number) {
  return WIND_WAVES.reduce((height, [angle, wavelength, amplitude, phase]) => {
    const k = (Math.PI * 2) / wavelength
    const spatial = (x * Math.cos(angle) + z * Math.sin(angle)) * k
    const omega = Math.sqrt(9.81 * k)
    const cross =
      (x * -Math.sin(angle) + z * Math.cos(angle)) * k * 0.18 + omega * time * 0.025 + phase * 1.7
    const packet = 0.72 + 0.28 * Math.cos(spatial * 0.14 - omega * time * 0.07 + phase * 2.3)
    return (
      height +
      Math.sin(spatial - omega * time + phase + 0.42 * Math.sin(cross * 0.57)) *
        amplitude *
        packet *
        (0.64 + 0.36 * Math.cos(cross))
    )
  }, 0)
}

const gl = (n: number) => n.toFixed(9)
/** Height and exact wind derivatives share the same spectrum. Small normal
 * waves are evaluated analytically, independently of the simulation's cell size. */
export const WATER_FIELD_GLSL = `
uniform sampler2D uState;
uniform sampler2D uMask;
uniform float uTime;
uniform float uCell;
vec2 fieldUv(vec2 p) { return (p - vec2(${gl(LAKE_BOUNDS.minX)}, ${gl(LAKE_BOUNDS.minZ)})) / ${gl(LAKE_BOUNDS.size)}; }
vec3 windField(vec2 p, float footprint) {
  vec3 field = vec3(0.0);
  ${WIND_WAVES.map(([angle, length, amplitude, phase]) => {
    const k = (Math.PI * 2) / length,
      omega = Math.sqrt(9.81 * k)
    return `{
      vec2 k = vec2(${gl(Math.cos(angle) * k)}, ${gl(Math.sin(angle) * k)});
      float spatial = dot(p, k);
      vec2 crossK = vec2(-k.y, k.x) * 0.18;
      float crossPhase = dot(p, crossK) + uTime * ${gl(omega * 0.025)} + ${gl(phase * 1.7)};
      float phase = spatial - uTime * ${gl(omega)} + ${gl(phase)} + 0.42 * sin(crossPhase * 0.57);
      vec2 phaseGradient = k + crossK * 0.2394 * cos(crossPhase * 0.57);
      float groupPhase = spatial * 0.14 - uTime * ${gl(omega * 0.07)} + ${gl(phase * 2.3)};
      float alongPacket = 0.72 + 0.28 * cos(groupPhase);
      float crossPacket = 0.64 + 0.36 * cos(crossPhase);
      float packet = alongPacket * crossPacket;
      vec2 packetGradient = -k * 0.0392 * sin(groupPhase) * crossPacket
        -crossK * 0.36 * sin(crossPhase) * alongPacket;
      float amplitude = ${gl(amplitude)} * (1.0 - smoothstep(${gl(length * 0.18)}, ${gl(length * 0.5)}, footprint));
      field.x += sin(phase) * amplitude * packet;
      field.yz += amplitude * (phaseGradient * cos(phase) * packet + sin(phase) * packetGradient);
    }`
  }).join('\n')}
  return field;
}
float interactionHeight(vec2 p) {
  vec2 uv = fieldUv(p);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return texture2D(uState, clamp(uv, 0.0, 1.0)).r * inside;
}
float heightAt(vec2 p, float footprint) {
  return windField(p, footprint).x + interactionHeight(p);
}
`

/** More triangles in the near lake; the outer surface still reaches beyond the horizon. */
export function createWaterGeometry(mobile: boolean) {
  const segments = mobile ? 192 : 384
  const geometry = new PlaneGeometry(1, 1, segments, segments)
  const positions = geometry.attributes.position!
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) * 2
    const t = 0.5 + positions.getY(i)
    positions.setXYZ(i, Math.sign(x) * Math.abs(x) ** 2.6 * 500, -(24 - t ** 2.6 * 524), 0)
  }
  geometry.computeBoundingSphere()
  return geometry
}

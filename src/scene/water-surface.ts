import { PlaneGeometry } from 'three'

import { LAKE_BOUNDS } from './lake-bed'
import type { WindState } from './wind'

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

// Precompute the same spectrum coefficients for CPU sampling and GLSL generation.
const WAVE_SPECTRUM = WIND_WAVES.map(([angle, wavelength, amplitude, phase]) => {
  const k = (Math.PI * 2) / wavelength
  const small = Math.max(0, Math.min(1, (5 - wavelength) / 5))
  return {
    wavelength,
    amplitude,
    phase,
    small,
    kx: Math.cos(angle) * k,
    kz: Math.sin(angle) * k,
    omega: Math.sqrt(9.81 * k),
    sensitivity: 0.22 + small * 0.78,
  }
})

/** Same height, spatial gradient and time derivative as the shader, including
 * the packet envelope and the changing wind amplitude. */
export function sampleWindField(
  x: number,
  z: number,
  time: number,
  wind?: WindState,
  footprint = 0,
) {
  const field: [height: number, dx: number, dz: number, velocity: number] = [0, 0, 0, 0]
  const [rotationX, rotationY] = wind?.rotation ?? [1, 0]
  const angularVelocity = wind?.rotationVelocity ?? 0
  const response: WindState['response'] = wind?.response ?? [1, 1, 0, 0]
  for (const {
    wavelength,
    amplitude: baseAmplitude,
    phase,
    kx: baseX,
    kz: baseZ,
    omega,
    small,
    sensitivity,
  } of WAVE_SPECTRUM) {
    const kx = baseX * rotationX - baseZ * rotationY
    const kz = baseZ * rotationX + baseX * rotationY
    const cx = -kz * 0.18,
      cz = kx * 0.18
    const spatial = x * kx + z * kz
    const cross = x * cx + z * cz + omega * time * 0.025 + phase * 1.7
    const wavePhase = spatial - omega * time + phase + 0.42 * Math.sin(cross * 0.57)
    const group = spatial * 0.14 - omega * time * 0.07 + phase * 2.3
    const alongPacket = 0.72 + 0.28 * Math.cos(group)
    const crossPacket = 0.64 + 0.36 * Math.cos(cross)
    const packet = alongPacket * crossPacket
    const strength = response[0] * (1 - small) + response[1] * small
    const velocity = response[2] * (1 - small) + response[3] * small
    const filter = Math.max(0, Math.min(1, (footprint - wavelength * 0.18) / (wavelength * 0.32)))
    const base = baseAmplitude * (1 - filter * filter * (3 - 2 * filter))
    const amplitude = base * (1 + sensitivity * (strength - 1))
    const sine = Math.sin(wavePhase),
      cosine = Math.cos(wavePhase)
    field[0] += sine * amplitude * packet
    const alongGradient =
      amplitude * (cosine * packet - sine * 0.0392 * Math.sin(group) * crossPacket)
    const crossGradient =
      amplitude *
      (cosine * packet * 0.2394 * Math.cos(cross * 0.57) -
        sine * 0.36 * Math.sin(cross) * alongPacket)
    field[1] += kx * alongGradient + cx * crossGradient
    field[2] += kz * alongGradient + cz * crossGradient
    const spatialVelocity = angularVelocity * (-x * kz + z * kx)
    const crossVelocity = angularVelocity * (-x * cz + z * cx) + omega * 0.025
    const groupVelocity = spatialVelocity * 0.14 - omega * 0.07
    const phaseVelocity = spatialVelocity - omega + 0.2394 * Math.cos(cross * 0.57) * crossVelocity
    const packetVelocity =
      -0.28 * Math.sin(group) * groupVelocity * crossPacket -
      0.36 * Math.sin(cross) * crossVelocity * alongPacket
    field[3] +=
      amplitude * (cosine * phaseVelocity * packet + sine * packetVelocity) +
      base * sensitivity * velocity * sine * packet
  }
  return field
}

export function swellHeight(x: number, z: number, time: number, wind?: WindState) {
  return sampleWindField(x, z, time, wind)[0]
}

const gl = (n: number) => n.toFixed(9)
/** Height and exact wind derivatives share the same spectrum. Small normal
 * waves are evaluated analytically, independently of the simulation's cell size. */
export const WIND_FIELD_GLSL = `
uniform float uTime;
uniform vec2 uWindRotation;
uniform float uWindRotationVelocity;
uniform vec4 uWindResponse;
vec4 windField(vec2 p, float footprint) {
  vec4 field = vec4(0.0);
  ${WAVE_SPECTRUM.map(
    ({ wavelength: length, amplitude, phase, kx, kz, omega, small, sensitivity }) => `{
      vec2 k = vec2(${gl(kx)}, ${gl(kz)});
      k = vec2(k.x * uWindRotation.x - k.y * uWindRotation.y, k.x * uWindRotation.y + k.y * uWindRotation.x);
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
      float baseAmplitude = ${gl(amplitude)} * (1.0 - smoothstep(${gl(length * 0.18)}, ${gl(length * 0.5)}, footprint));
      float strength = mix(uWindResponse.x, uWindResponse.y, ${gl(small)});
      float amplitude = baseAmplitude * (1.0 + ${gl(sensitivity)} * (strength - 1.0));
      float amplitudeVelocity = baseAmplitude * ${gl(sensitivity)} * mix(uWindResponse.z, uWindResponse.w, ${gl(small)});
      field.x += sin(phase) * amplitude * packet;
      field.yz += amplitude * (phaseGradient * cos(phase) * packet + sin(phase) * packetGradient);
      float spatialVelocity = uWindRotationVelocity * dot(p, vec2(-k.y, k.x));
      float crossVelocity = uWindRotationVelocity * dot(p, vec2(-crossK.y, crossK.x)) + ${gl(omega * 0.025)};
      float groupVelocity = spatialVelocity * 0.14 - ${gl(omega * 0.07)};
      float phaseVelocity = spatialVelocity - ${gl(omega)} + 0.2394 * cos(crossPhase * 0.57) * crossVelocity;
      float packetVelocity = -0.28 * sin(groupPhase) * groupVelocity * crossPacket
        -0.36 * sin(crossPhase) * crossVelocity * alongPacket;
      field.w += amplitude * (cos(phase) * phaseVelocity * packet + sin(phase) * packetVelocity)
        + amplitudeVelocity * sin(phase) * packet;
    }`,
  ).join('\n')}
  return field;
}
`

export const WATER_FIELD_GLSL = `
${WIND_FIELD_GLSL}
uniform sampler2D uState;
uniform sampler2D uMask;
uniform float uCell;
vec2 fieldUv(vec2 p) { return (p - vec2(${gl(LAKE_BOUNDS.minX)}, ${gl(LAKE_BOUNDS.minZ)})) / ${gl(LAKE_BOUNDS.size)}; }
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

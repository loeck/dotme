import { Fn, float, vec2, vec4, uniform, sin, cos, mix, smoothstep } from 'three/tsl'
import { BufferAttribute, BufferGeometry, Sphere, Vector2, Vector3, Vector4 } from 'three/webgpu'
import type { Node } from 'three/webgpu'

import { LAKE_BOUNDS } from './lake-bed'
import { prepareWaterSurface } from './lake-geometry-data'
import type { PreparedWaterSurface } from './lake-geometry-data'
import type { WindState } from './wind'

// Crossing swells and directionally spread shorter wind waves. Band amplitudes
// set the energy without one coherent family of parallel crests.
export const WIND_WAVES = [
  [0.55, 12.7, 0.024, 1.3],
  [1.92, 8.3, 0.016, 4.7],
  [1.15, 5.1, 0.014, 2.1],
  [-0.15, 3.6, 0.011, 5.8],
  [1.62, 2.4, 0.008, 0.4],
  // Calm wind: fade short, fast waves before they dominate the lamp glints.
  // Keep this spectrum uniform across the lake, including the lit left bank.
  [0.08, 1.61, 0.0048, 3.2],
  [1.48, 1.07, 0.0024, 5.1],
  [-0.4, 0.72, 0.0012, 1.7],
  [1.95, 0.49, 0.00055, 4.2],
  [0.63, 0.33, 0.00025, 0.9],
  [-0.77, 0.22, 0.0001, 3.8],
  [2.16, 0.145, 0.00004, 2.6],
] as const

// Precompute the same spectrum coefficients for CPU sampling and TSL shading.
export const WAVE_SPECTRUM = WIND_WAVES.map(([angle, wavelength, amplitude, phase]) => {
  const k = (Math.PI * 2) / wavelength
  const small = Math.max(0, Math.min(1, (5 - wavelength) / 5))
  return {
    wavelength,
    amplitude,
    phase,
    small,
    // Short waves form shorter transverse packets; amplitudes remain unchanged.
    crossScale: 0.18 + small * 0.22,
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
    crossScale,
  } of WAVE_SPECTRUM) {
    if (footprint >= wavelength * 0.5) continue
    const kx = baseX * rotationX - baseZ * rotationY
    const kz = baseZ * rotationX + baseX * rotationY
    const cx = -kz * crossScale,
      cz = kx * crossScale
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

/** One spectrum shared by CPU buoyancy and GPU shading. */
export function createWindNodes() {
  return {
    uTime: uniform(0),
    uWindRotation: uniform(new Vector2(1, 0)),
    uWindRotationVelocity: uniform(0),
    uWindResponse: uniform(new Vector4(1, 1, 0, 0)),
  }
}

export const windRotate = (u: ReturnType<typeof createWindNodes>, x: number, z: number) =>
  vec2(
    u.uWindRotation.x.mul(x).sub(u.uWindRotation.y.mul(z)),
    u.uWindRotation.y.mul(x).add(u.uWindRotation.x.mul(z)),
  )

export function windFieldNode(
  p: Node<'vec2'>,
  footprint: Node<'float'>,
  u: ReturnType<typeof createWindNodes>,
) {
  return Fn(() => {
    // Separate accumulators avoid mutable vec4 swizzles in the Metal compiler,
    // particularly when this field is evaluated inside shoreline conditionals.
    const height = float(0).toVar()
    const gradient = vec2(0).toVar()
    const velocity = float(0).toVar()
    for (const w of WAVE_SPECTRUM) {
      const k = windRotate(u, w.kx, w.kz)
      const spatial = p.dot(k)
      const crossK = vec2(k.y.negate(), k.x).mul(w.crossScale)
      const crossPhase = p
        .dot(crossK)
        .add(u.uTime.mul(w.omega * 0.025))
        .add(w.phase * 1.7)
      const phase = spatial
        .sub(u.uTime.mul(w.omega))
        .add(w.phase)
        .add(sin(crossPhase.mul(0.57)).mul(0.42))
      const phaseGradient = k.add(crossK.mul(0.2394).mul(cos(crossPhase.mul(0.57))))
      const group = spatial
        .mul(0.14)
        .sub(u.uTime.mul(w.omega * 0.07))
        .add(w.phase * 2.3)
      const alongPacket = cos(group).mul(0.28).add(0.72)
      const crossPacket = cos(crossPhase).mul(0.36).add(0.64)
      const packet = alongPacket.mul(crossPacket)
      const packetGradient = k
        .mul(-0.0392)
        .mul(sin(group))
        .mul(crossPacket)
        .sub(crossK.mul(0.36).mul(sin(crossPhase)).mul(alongPacket))
      const base = float(w.amplitude).mul(
        float(1).sub(smoothstep(w.wavelength * 0.18, w.wavelength * 0.5, footprint)),
      )
      const amplitude = base.mul(
        mix(u.uWindResponse.x, u.uWindResponse.y, w.small).sub(1).mul(w.sensitivity).add(1),
      )
      const amplitudeVelocity = base
        .mul(w.sensitivity)
        .mul(mix(u.uWindResponse.z, u.uWindResponse.w, w.small))
      height.addAssign(sin(phase).mul(amplitude).mul(packet))
      gradient.addAssign(
        amplitude.mul(
          phaseGradient
            .mul(cos(phase))
            .mul(packet)
            .add(packetGradient.mul(sin(phase))),
        ),
      )
      const spatialVelocity = u.uWindRotationVelocity.mul(p.dot(vec2(k.y.negate(), k.x)))
      const crossVelocity = u.uWindRotationVelocity
        .mul(p.dot(vec2(crossK.y.negate(), crossK.x)))
        .add(w.omega * 0.025)
      const groupVelocity = spatialVelocity.mul(0.14).sub(w.omega * 0.07)
      const phaseVelocity = spatialVelocity
        .sub(w.omega)
        .add(cos(crossPhase.mul(0.57)).mul(0.2394).mul(crossVelocity))
      const packetVelocity = sin(group)
        .mul(-0.28)
        .mul(groupVelocity)
        .mul(crossPacket)
        .sub(sin(crossPhase).mul(0.36).mul(crossVelocity).mul(alongPacket))
      velocity.addAssign(
        amplitude
          .mul(cos(phase).mul(phaseVelocity).mul(packet).add(sin(phase).mul(packetVelocity)))
          .add(amplitudeVelocity.mul(sin(phase)).mul(packet)),
      )
    }
    return vec4(height, gradient, velocity)
  })()
}

const RIPPLES = (
  [
    [0.35, 0.93, 0.034, 0.7],
    [-0.9, 0.61, 0.028, 2.9],
    [1.6, 0.43, 0.024, 4.4],
    [-0.2, 0.29, 0.018, 1.2],
    [2.4, 0.19, 0.013, 5.6],
  ] as const
).map(([angle, wavelength, slope, phase]) => {
  const k = (Math.PI * 2) / wavelength
  return {
    wavelength,
    slope,
    phase,
    k,
    dx: Math.cos(angle),
    dz: Math.sin(angle),
    omega: Math.sqrt(9.81 * k),
  }
})

/** Shading-only capillary slopes; heights stay with the shared spectrum. */
export function rippleSlopeNode(
  p: Node<'vec2'>,
  footprint: Node<'float'>,
  strength: Node<'float'>,
  u: ReturnType<typeof createWindNodes>,
) {
  return Fn(() => {
    const slope = vec2(0).toVar()
    for (const w of RIPPLES) {
      const direction = windRotate(u, w.dx, w.dz)
      const crest = sin(
        p
          .dot(vec2(direction.y.negate(), direction.x))
          .mul(3.1 / w.wavelength)
          .add(w.phase * 3),
      )
        .mul(0.5)
        .add(0.5)
      const fade = float(1).sub(smoothstep(w.wavelength * 0.12, w.wavelength * 0.45, footprint))
      const phase = p.dot(direction).mul(w.k).sub(u.uTime.mul(w.omega)).add(w.phase)
      slope.addAssign(direction.mul(cos(phase).mul(w.slope).mul(fade).mul(crest.mul(0.7).add(0.3))))
    }
    return slope.mul(strength)
  })()
}

export function fieldUvNode(p: Node<'vec2'>) {
  return p.sub(vec2(LAKE_BOUNDS.minX, LAKE_BOUNDS.minZ)).div(LAKE_BOUNDS.size)
}

/** More triangles in the near lake; the outer surface still reaches beyond the horizon. */
export function createWaterGeometry(
  mobile: boolean,
  prepared: PreparedWaterSurface = prepareWaterSurface(mobile),
) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(prepared.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(prepared.normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(prepared.uv, 2))
  geometry.setIndex(new BufferAttribute(prepared.indices, 1))
  geometry.boundingSphere = new Sphere(
    new Vector3(...prepared.boundingCenter),
    prepared.boundingRadius,
  )
  return geometry
}

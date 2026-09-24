import type { Vector2, Vector4 } from 'three/webgpu'

import { required } from '../invariant'

export const WIND_BEARING = 0.72
const REFERENCE_SPEED = 3
const TURN_FREQUENCY = 0.023
const GUSTS = [
  [0.17, 0.22],
  [0.071, 0.14],
  [0.31, 0.07],
] as const

export type WindState = Readonly<{
  direction: readonly [number, number]
  speed: number
  displacement: readonly [number, number]
  rotation: readonly [number, number]
  rotationVelocity: number
  response: readonly [swell: number, ripples: number, swellVelocity: number, rippleVelocity: number]
}>

/** Internal controls, also used by the controlled rendering experiments. */
export type WindOptions = Readonly<{
  bearing?: number
  meanSpeed?: number
  gustStrength?: number
  turnStrength?: number
}>

/** Analytic integral and steady-state low-pass responses: no frame-rate-dependent
 * accumulator, no speed*time jumps, and no startup transient after a hidden tab. */
export class WindModel {
  private readonly phases: number[]
  private readonly direction: WindState['direction']
  private readonly bearing: number
  private readonly turnStrength: number
  private readonly meanSpeed: number
  private readonly gustStrength: number

  constructor(seed: number, options: WindOptions = {}) {
    let state = (seed ^ 0xa511e9b3) >>> 0
    this.phases = GUSTS.map(() => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return (state / 0x1_0000_0000) * Math.PI * 2
    })
    const bearing = options.bearing ?? WIND_BEARING
    this.direction = [Math.cos(bearing), Math.sin(bearing)]
    this.bearing = bearing
    this.turnStrength = Math.max(0, Math.min(1, options.turnStrength ?? 1))
    this.meanSpeed = Math.max(0, options.meanSpeed ?? REFERENCE_SPEED)
    this.gustStrength = Math.max(0, Math.min(1, options.gustStrength ?? 1))
  }

  sample(time: number): WindState {
    let speed = this.meanSpeed
    let acceleration = 0
    let distance = this.meanSpeed * time
    const response: [number, number, number, number] = [
      this.meanSpeed / REFERENCE_SPEED,
      this.meanSpeed / REFERENCE_SPEED,
      0,
      0,
    ]
    GUSTS.forEach(([frequency, weight], i) => {
      const phase = required(this.phases[i])
      const amplitude = this.meanSpeed * weight * this.gustStrength
      const angle = frequency * time + phase
      const sine = Math.sin(angle),
        cosine = Math.cos(angle)
      speed += amplitude * sine
      acceleration += amplitude * frequency * cosine
      distance += (amplitude / frequency) * (Math.cos(phase) - cosine)
      for (let band = 0; band < 2; band++) {
        const lag = frequency * (band === 0 ? 8 : 2.5)
        // Expanded sin(angle - atan(lag)) with the filter's attenuation.
        const gain = amplitude / REFERENCE_SPEED / (1 + lag * lag)
        response[band] = required(response[band]) + gain * (sine - lag * cosine)
        response[band + 2] = required(response[band + 2]) + gain * frequency * (cosine + lag * sine)
      }
    })
    // A slow crosswind veers to either side of the prevailing bearing. Both
    // velocity components have exact integrals, including through a left turn.
    const turnPhase = required(this.phases[1])
    const turnAngle = TURN_FREQUENCY * time + turnPhase
    const turnAmplitude = this.meanSpeed * 1.4 * this.turnStrength
    const sine = Math.sin(turnAngle),
      cosine = Math.cos(turnAngle)
    const lateral = turnAmplitude * sine
    const lateralAcceleration = turnAmplitude * TURN_FREQUENCY * cosine
    const lateralDistance = (turnAmplitude / TURN_FREQUENCY) * (Math.cos(turnPhase) - cosine)
    const magnitude = Math.hypot(speed, lateral)
    const bearing = this.bearing + Math.atan2(lateral, speed)
    const [dx, dz] = this.direction
    for (let band = 0; band < 2; band++) {
      const lag = TURN_FREQUENCY * (band === 0 ? 8 : 2.5)
      const gain = turnAmplitude / REFERENCE_SPEED / (1 + lag * lag)
      const filtered = gain * (sine - lag * cosine)
      const derivative = gain * TURN_FREQUENCY * (cosine + lag * sine)
      const strength = Math.hypot(required(response[band]), filtered)
      response[band + 2] =
        strength > 0
          ? (required(response[band]) * required(response[band + 2]) + filtered * derivative) /
            strength
          : 0
      response[band] = strength
    }
    return {
      direction: [Math.cos(bearing), Math.sin(bearing)],
      speed: magnitude,
      displacement: [dx * distance - dz * lateralDistance, dz * distance + dx * lateralDistance],
      rotation: [Math.cos(bearing - WIND_BEARING), Math.sin(bearing - WIND_BEARING)],
      rotationVelocity:
        magnitude > 0
          ? (speed * lateralAcceleration - lateral * acceleration) / (magnitude * magnitude)
          : 0,
      response,
    }
  }
}

export interface WindUniforms {
  readonly uWindRotation: { value: Vector2 }
  readonly uWindRotationVelocity: { value: number }
  readonly uWindResponse: { value: Vector4 }
}

export function updateWindUniforms(uniforms: WindUniforms, wind: WindState) {
  uniforms.uWindRotation.value.fromArray(wind.rotation)
  uniforms.uWindRotationVelocity.value = wind.rotationVelocity
  uniforms.uWindResponse.value.fromArray(wind.response)
}

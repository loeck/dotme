import {
  Fn,
  dFdx,
  dFdy,
  fwidth,
  exp,
  clamp,
  float,
  vec2,
  vec3,
  sin,
  cos,
  mix,
  smoothstep,
  positionWorld,
  uniform,
  max,
  min,
  materialColor,
} from 'three/tsl'
import { Vector3 } from 'three/webgpu'
import type { MeshStandardNodeMaterial } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import { createWindNodes, WAVE_SPECTRUM, windRotate } from './water-surface'
import { updateWindUniforms } from './wind'
import type { WindState } from './wind'
type WaterPointer = Readonly<{ x: number; z: number }>

export class LakeCaustics {
  readonly uniforms = {
    ...createWindNodes(),
    uCausticStrength: uniform(0),
    uCausticPointer: uniform(new Vector3()),
  }
  private readonly restores = new Map<MeshStandardNodeMaterial, () => void>()
  private readonly reducedMotion: boolean
  private previousTime = 0
  private initializedWind = false
  constructor(reducedMotion = false) {
    this.reducedMotion = reducedMotion
  }
  applyTo(material: MeshStandardNodeMaterial) {
    if (this.restores.has(material)) return
    const u = this.uniforms
    const footprint = max(dFdx(positionWorld.xz).length(), dFdy(positionWorld.xz).length())
    const curvature = Fn(() => {
      const result = vec3(0).toVar()
      const p = positionWorld.xz
      for (const w of WAVE_SPECTRUM.filter(
        (wave) => wave.wavelength <= 5.1 && wave.wavelength >= 1.07,
      )) {
        const k = windRotate(u, w.kx, w.kz)
        const spatial = p.dot(k),
          crossK = vec2(k.y.negate(), k.x).mul(w.crossScale)
        const crossPhase = p
          .dot(crossK)
          .add(u.uTime.mul(w.omega * 0.025))
          .add(w.phase * 1.7)
        const phase = spatial
          .sub(u.uTime.mul(w.omega))
          .add(w.phase)
          .add(sin(crossPhase.mul(0.57)).mul(0.42))
        const gradient = k.add(crossK.mul(0.2394).mul(cos(crossPhase.mul(0.57))))
        const group = spatial
          .mul(0.14)
          .sub(u.uTime.mul(w.omega * 0.07))
          .add(w.phase * 2.3)
        const along = cos(group).mul(0.28).add(0.72),
          across = cos(crossPhase).mul(0.36).add(0.64),
          packet = along.mul(across)
        const packetGradient = k
          .mul(-0.0392)
          .mul(sin(group))
          .mul(across)
          .sub(crossK.mul(0.36).mul(sin(crossPhase)).mul(along))
        const kk = vec3(k.x.mul(k.x), k.x.mul(k.y), k.y.mul(k.y))
        const cc = vec3(crossK.x.mul(crossK.x), crossK.x.mul(crossK.y), crossK.y.mul(crossK.y))
        const kc = vec3(
          k.x.mul(crossK.x).mul(2),
          k.x.mul(crossK.y).add(k.y.mul(crossK.x)),
          k.y.mul(crossK.y).mul(2),
        )
        const packetCurvature = kk
          .mul(-0.005488)
          .mul(cos(group))
          .mul(across)
          .sub(cc.mul(0.36).mul(cos(crossPhase)).mul(along))
          .add(kc.mul(0.014112).mul(sin(group)).mul(sin(crossPhase)))
        const phaseCurvature = cc.mul(-0.136458).mul(sin(crossPhase.mul(0.57)))
        const squared = vec3(
          gradient.x.mul(gradient.x),
          gradient.x.mul(gradient.y),
          gradient.y.mul(gradient.y),
        )
        const crossGradient = vec3(
          gradient.x.mul(packetGradient.x).mul(2),
          gradient.x.mul(packetGradient.y).add(gradient.y.mul(packetGradient.x)),
          gradient.y.mul(packetGradient.y).mul(2),
        )
        const amplitude = mix(u.uWindResponse.x, u.uWindResponse.y, w.small)
          .sub(1)
          .mul(w.sensitivity)
          .add(1)
          .mul(w.amplitude)
          .mul(float(1).sub(smoothstep(w.wavelength * 0.18, w.wavelength * 0.5, footprint)))
        result.addAssign(
          sin(phase)
            .mul(packetCurvature.sub(squared.mul(packet)))
            .add(cos(phase).mul(phaseCurvature.mul(packet).add(crossGradient)))
            .mul(amplitude),
        )
      }
      return result
    })()
    const depth = float(WATER_LEVEL).sub(positionWorld.y)
    const depthFade = smoothstep(0.03, 0.24, depth).mul(float(1).sub(smoothstep(2, 6, depth)))
    const cursorFocus = exp(positionWorld.xz.sub(u.uCausticPointer.xy).length().mul(-0.6))
      .mul(u.uCausticPointer.z)
      .mul(0.12)
      .add(1)
    const focusedCurvature = curvature.mul(min(depth, 2.5)).mul(2.8).mul(cursorFocus)
    const jacobian = focusedCurvature.x
      .add(1)
      .mul(focusedCurvature.z.add(1))
      .sub(focusedCurvature.y.mul(focusedCurvature.y))
    const convergence = clamp(float(1).div(max(0.35, jacobian)).sub(1), 0, 1)
    const width = max(fwidth(convergence).mul(1.5), 0.025)
    const line = smoothstep(float(0.02).sub(width), width.add(0.7), convergence)
    const focus = depthFade.mul(u.uCausticStrength).mul(line)
    const previous = material.colorNode
    const color = (previous ?? materialColor).mul(focus.add(1))
    material.colorNode = color
    material.needsUpdate = true
    this.restores.set(material, () => {
      if (material.colorNode === color) material.colorNode = previous
      material.needsUpdate = true
    })
  }
  update(
    time: number,
    wind: WindState,
    lightStrength = 1,
    pointer: WaterPointer | null = null,
    pointerStrength = 1,
  ) {
    const dt = Math.max(0, Math.min(0.1, time - this.previousTime))
    this.previousTime = time
    this.uniforms.uTime.value = this.reducedMotion ? 0 : time
    // Irradiance itself already fades at night; preserve some pattern contrast
    // around lamps/cursor instead of applying the same linear attenuation twice.
    this.uniforms.uCausticStrength.value = 0.85 * Math.sqrt(Math.max(0, Math.min(1, lightStrength)))
    if (!this.reducedMotion || !this.initializedWind) {
      updateWindUniforms(this.uniforms, wind)
      this.initializedWind = true
    }
    const contact = this.uniforms.uCausticPointer.value
    if (pointer) {
      contact.x = pointer.x
      contact.y = pointer.z
    }
    const target = pointer && !this.reducedMotion ? pointerStrength : 0
    contact.z += (target - contact.z) * (1 - Math.exp(-dt * 5))
    if (pointerStrength === 0) contact.z = 0
  }

  dispose() {
    this.uniforms.uCausticStrength.value = 0
    for (const restore of this.restores.values()) restore()
    this.restores.clear()
  }
}

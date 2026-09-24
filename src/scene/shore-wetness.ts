import {
  uniform,
  float,
  smoothstep,
  positionWorld,
  normalWorld,
  mix,
  sin,
  materialColor,
  materialRoughness,
  min,
  max,
  nodeObject,
} from 'three/tsl'
import { ConvertNode } from 'three/webgpu'
import type { MeshStandardNodeMaterial } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'

const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Exact integration: rain soaks stone in seconds, while drying takes minutes. */
export function advanceShoreWetness(wetness: number, rainIntensity: number, delta: number) {
  const previous = unit(wetness)
  const rain = unit(rainIntensity)
  if (!Number.isFinite(delta) || delta <= 0) return previous
  const soak = rain / 8
  const dry = (1 - rain) / 160
  const rate = soak + dry
  const equilibrium = soak / rate
  return unit(equilibrium + (previous - equilibrium) * Math.exp(-rate * delta))
}

/** Node composition preserves previous color/roughness treatments and restores them. */
export class ShoreWetness {
  private readonly amount = uniform(0)
  private readonly restores = new Map<MeshStandardNodeMaterial, () => void>()
  constructor(initialWetness = 0) {
    this.setWetness(initialWetness)
  }
  get wetness() {
    return this.amount.value
  }
  setWetness(value: number) {
    this.amount.value = unit(value)
  }
  update(delta: number, rainIntensity: number) {
    this.setWetness(advanceShoreWetness(this.wetness, rainIntensity, delta))
  }
  applyTo(material: MeshStandardNodeMaterial) {
    if (this.restores.has(material)) return
    const oldColor = material.colorNode,
      oldRoughness = material.roughnessNode
    const low = float(1).sub(smoothstep(WATER_LEVEL + 0.15, 2, positionWorld.y))
    const exposure = mix(0.2, 1, smoothstep(0.1, 0.8, normalWorld.y)).mul(
      smoothstep(-0.8, -0.1, normalWorld.y),
    )
    const patch = sin(positionWorld.x.mul(2.7).add(positionWorld.z.mul(1.3)))
      .mul(0.08)
      .add(0.92)
    const wet = this.amount
      .mul(exposure)
      .mul(mix(0.65, 1, low))
      .mul(patch)
    const baseRoughness = oldRoughness
      ? nodeObject(new ConvertNode<'float'>(oldRoughness, 'float'))
      : materialRoughness
    const color = (oldColor ?? materialColor).mul(float(1).sub(wet.mul(0.28)))
    const roughness = mix(
      baseRoughness,
      min(baseRoughness, max(0.12, baseRoughness.mul(0.46))),
      wet,
    )
    material.colorNode = color
    material.roughnessNode = roughness
    material.needsUpdate = true
    this.restores.set(material, () => {
      if (material.colorNode === color) material.colorNode = oldColor
      if (material.roughnessNode === roughness) material.roughnessNode = oldRoughness
      material.needsUpdate = true
    })
  }
  dispose() {
    this.setWetness(0)
    for (const restore of this.restores.values()) restore()
    this.restores.clear()
  }
}

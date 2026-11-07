import {
  dFdx,
  dFdy,
  float,
  materialColor,
  materialRoughness,
  max,
  mix,
  positionWorld,
  normalView,
  nodeObject,
  sin,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import { ConvertNode } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import { meadowOffset } from './lake-seabed'
import { surfaceGradientNormal } from './surface-detail'
import { contactNoise } from './water-noise'

const RIPPLE_WAVELENGTH = 0.3

export class LakeSand {
  private readonly restores = new Map<MeshStandardNodeMaterial, () => void>()
  private readonly seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  applyTo(material: MeshStandardNodeMaterial) {
    if (this.restores.has(material)) return
    const [ox, oz] = meadowOffset(this.seed)
    const footprint = max(dFdx(positionWorld.xz).length(), dFdy(positionWorld.xz).length())
    const wobble = contactNoise(positionWorld.xz.mul(0.8)).mul(3)
    const stripes = sin(
      positionWorld.xz
        .dot(vec2(0.83, 0.55))
        .mul((Math.PI * 2) / RIPPLE_WAVELENGTH)
        .add(wobble),
    )
    const fade = float(1).sub(
      smoothstep(RIPPLE_WAVELENGTH * 0.18, RIPPLE_WAVELENGTH * 0.5, footprint),
    )
    const depth = float(WATER_LEVEL).sub(positionWorld.y)
    const depthFade = float(1).sub(smoothstep(2.5, 4.5, depth))
    const meadowBand = smoothstep(0.4, 0.9, depth).mul(float(1).sub(smoothstep(2.8, 3.8, depth)))
    const meadow = smoothstep(
      0.48,
      0.62,
      contactNoise(positionWorld.xz.mul(0.15).add(vec2(ox, oz))),
    ).mul(meadowBand)
    const factor = stripes
      .mul(0.1)
      .mul(fade)
      .mul(depthFade)
      .mul(float(1).sub(meadow.mul(0.7)))
      .add(1)
    const previous = material.colorNode
    const previousNormal = material.normalNode
    const previousRoughness = material.roughnessNode
    const color = (previous ?? materialColor)
      .mul(factor)
      .mul(mix(vec3(1), vec3(0.32, 0.48, 0.3), meadow))
    const grainFade = smoothstep(0.012, 0.003, footprint)
    const grain = contactNoise(positionWorld.xz.mul(95)).sub(0.5).mul(grainFade)
    material.colorNode = color.mul(grain.mul(0.13).add(1))
    const composedColor = material.colorNode
    const baseNormal = previousNormal
      ? nodeObject(new ConvertNode<'vec3'>(previousNormal, 'vec3'))
      : normalView
    const normal = surfaceGradientNormal(
      stripes.mul(fade).mul(depthFade).mul(0.0035).add(grain.mul(0.0007)),
      float(1),
      baseNormal,
    )
    const roughness = previousRoughness
      ? nodeObject(new ConvertNode<'float'>(previousRoughness, 'float'))
      : materialRoughness
    material.normalNode = normal
    material.roughnessNode = roughness.mul(grain.mul(0.06).add(1)).clamp(0.65, 1)
    const composedRoughness = material.roughnessNode
    material.needsUpdate = true
    this.restores.set(material, () => {
      if (material.colorNode === composedColor) material.colorNode = previous
      if (material.normalNode === normal) material.normalNode = previousNormal
      if (material.roughnessNode === composedRoughness) material.roughnessNode = previousRoughness
      material.needsUpdate = true
    })
  }

  dispose() {
    for (const restore of this.restores.values()) restore()
    this.restores.clear()
  }
}

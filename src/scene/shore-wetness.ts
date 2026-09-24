import type { MeshStandardMaterial } from 'three'

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

type MaterialHook = MeshStandardMaterial['onBeforeCompile']
type Attachment = {
  material: MeshStandardMaterial
  previousCompile: MaterialHook
  previousCacheKey: MeshStandardMaterial['customProgramCacheKey']
  compile: MaterialHook
  cacheKey: MeshStandardMaterial['customProgramCacheKey']
}

/** A composable surface treatment; base albedo and material parameters stay intact. */
export class ShoreWetness {
  private readonly uniforms = { uShoreWetness: { value: 0 } }
  private readonly attachments: Attachment[] = []

  constructor(initialWetness = 0) {
    this.setWetness(initialWetness)
  }

  get wetness() {
    return this.uniforms.uShoreWetness.value
  }

  setWetness(value: number) {
    this.uniforms.uShoreWetness.value = unit(value)
  }

  update(delta: number, rainIntensity: number) {
    this.setWetness(advanceShoreWetness(this.wetness, rainIntensity, delta))
  }

  applyTo(material: MeshStandardMaterial) {
    if (this.attachments.some((attachment) => attachment.material === material)) return
    const previousCompile = material.onBeforeCompile
    const previousCacheKey = material.customProgramCacheKey
    const previousKey = previousCacheKey.call(material)
    const compile: MaterialHook = (shader, renderer) => {
      previousCompile.call(material, shader, renderer)
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = `varying vec3 vShoreWetnessWorld;
        varying float vShoreWetnessUp;
        ${shader.vertexShader}`
        .replace(
          '#include <defaultnormal_vertex>',
          `#include <defaultnormal_vertex>
            vShoreWetnessUp = inverseTransformDirection(transformedNormal, viewMatrix).y;`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
            vec4 shoreWetnessWorld = vec4(transformed, 1.0);
            #ifdef USE_BATCHING
              shoreWetnessWorld = batchingMatrix * shoreWetnessWorld;
            #endif
            #ifdef USE_INSTANCING
              shoreWetnessWorld = instanceMatrix * shoreWetnessWorld;
            #endif
            vShoreWetnessWorld = (modelMatrix * shoreWetnessWorld).xyz;`,
        )
      shader.fragmentShader = `uniform float uShoreWetness;
        varying vec3 vShoreWetnessWorld;
        varying float vShoreWetnessUp;
        ${shader.fragmentShader}`
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
            // Rain collects on upward faces; runoff leaves weaker marks on sides.
            // Low bank ledges retain more moisture than high, exposed stone.
            float shoreLow = 1.0 - smoothstep(${(WATER_LEVEL + 0.15).toFixed(3)}, 2.0, vShoreWetnessWorld.y);
            float shoreExposure = mix(0.2, 1.0, smoothstep(0.1, 0.8, vShoreWetnessUp));
            shoreExposure *= smoothstep(-0.8, -0.1, vShoreWetnessUp);
            float shorePatch = 0.92 + 0.08 * sin(vShoreWetnessWorld.x * 2.7 + vShoreWetnessWorld.z * 1.3);
            float shoreWet = uShoreWetness * shoreExposure * mix(0.65, 1.0, shoreLow) * shorePatch;
            diffuseColor.rgb *= 1.0 - shoreWet * 0.28;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
            roughnessFactor = mix(roughnessFactor, min(roughnessFactor, max(0.12, roughnessFactor * 0.46)), shoreWet);`,
        )
    }
    const cacheKey = () => `${previousKey}:shore-wetness-v1`
    material.onBeforeCompile = compile
    material.customProgramCacheKey = cacheKey
    material.needsUpdate = true
    this.attachments.push({ material, previousCompile, previousCacheKey, compile, cacheKey })
  }

  dispose() {
    // A later wrapper may still reference our uniforms. Zeroing them is safe in that case.
    this.setWetness(0)
    for (const { material, compile, cacheKey, previousCompile, previousCacheKey } of this
      .attachments) {
      if (material.onBeforeCompile === compile) material.onBeforeCompile = previousCompile
      if (material.customProgramCacheKey === cacheKey)
        material.customProgramCacheKey = previousCacheKey
      material.needsUpdate = true
    }
    this.attachments.length = 0
  }
}

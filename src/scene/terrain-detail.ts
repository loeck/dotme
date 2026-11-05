import { normalWorld, uniform } from 'three/tsl'
import { Color, IrradianceNode } from 'three/webgpu'
import type { MeshStandardNodeMaterial } from 'three/webgpu'

/** Share of the ambient colour added as sky light on a vertical face. */
const SIDE_FILL = 1.6

/**
 * Last Signal's sky light on terrain sides. The probe lights tops from the bright zenith, but a
 * riser samples the dark horizon of islands and water and read nearly black, about a twelfth of
 * a top, where open sky gives a vertical face about half. This adds irradiance, through the
 * diffuse BRDF and occlusion like ambient light, that peaks on vertical faces and vanishes on
 * tops and undersides, tinted and scaled by the current ambient colour.
 */
export class TerrainSkyFill {
  readonly colour = uniform(new Color())
  applyTo(material: MeshStandardNodeMaterial) {
    const side = normalWorld.y.abs().oneMinus()
    const light = new IrradianceNode(this.colour.mul(side.mul(SIDE_FILL)))
    const setup = material.setupMaterialLightings.bind(material)
    const cacheKey = material.customProgramCacheKey.bind(material)
    material.setupMaterialLightings = (builder) => [...setup(builder), light]
    material.customProgramCacheKey = () => `${cacheKey()}:terrain-sky:${this.colour.id}`
  }
  update(ambient: Color) {
    this.colour.value.copy(ambient)
  }
}

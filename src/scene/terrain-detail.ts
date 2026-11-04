import {
  float,
  floor,
  fwidth,
  hash,
  max,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, IrradianceNode } from 'three/webgpu'
import type { MeshStandardNodeMaterial } from 'three/webgpu'

/** Micro-voxel cells per metre: four per 25 cm terrain voxel, about 6 cm each. */
const CELLS = 16
/** Keeps world coordinates positive before the unsigned hash. */
const OFFSET = 4096

/**
 * Last Signal's ground is never one flat colour per block: the top of a voxel breaks into
 * micro-voxels of moss, soil and litter, and its sides into thin strata. This multiplies the
 * vertex colour by a quantised world-space pattern (value ±12%, a slight moss/soil hue shift),
 * fading out where a cell shrinks below about a pixel so distant terrain does not shimmer.
 */
export function applyTerrainDetail(material: MeshStandardNodeMaterial, sky: TerrainSkyFill) {
  sky.applyTo(material)
  const cell = floor(positionWorld.mul(CELLS).add(OFFSET))
  const top = smoothstep(0.5, 0.8, normalWorld.y)
  // Tops: one hash per XZ cell. Sides: horizontal strata, a few cells long along the face.
  // Seeds stay below 2^24 so float32 keeps every cell distinct before the unsigned hash.
  const topSeed = cell.x.add(cell.z.mul(613))
  const along = floor(
    positionWorld.x
      .add(positionWorld.z)
      .mul(CELLS / 3)
      .add(OFFSET),
  )
  const sideSeed = cell.y.mul(911).add(along.mul(7)).add(1_000_003)
  const value = mix(hash(sideSeed), hash(topSeed), top)
  const hue = mix(hash(sideSeed.add(1)), hash(topSeed.add(7)), top)
  // Moss cells lean green, soil cells warm; both stay within the vertex colour's value.
  const tint = mix(vec3(1.06, 0.97, 0.88), vec3(0.94, 1.05, 0.9), hue)
  const shade = float(0.88).add(value.mul(0.24))
  // Fade by on-screen cell size: full detail while a cell spans more than about two pixels.
  const footprint = max(
    fwidth(positionWorld.x),
    max(fwidth(positionWorld.y), fwidth(positionWorld.z)),
  )
  const detail = smoothstep(0.25, 0.5, footprint.mul(CELLS)).oneMinus()
  const strength = detail.mul(mix(0.7, 1, top))
  const factor = mix(vec3(1), tint.mul(shade), strength)
  material.colorNode = vec4(factor, 1)
}

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

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
/** The coarser octave matches the 12.5 cm micro-columns the far terrain erodes into. */
const COARSE_CELLS = 8
/** Keeps world coordinates positive before the unsigned hash. */
const OFFSET = 4096

/**
 * One octave of the micro-cell pattern: a value and hue per square cell (one hash per XZ cell on
 * tops, per cell along and up the face on sides), faded out where a cell spans under about two
 * pixels so it never shimmers.
 */
function microCells(cells: number, salt: number, value: number) {
  const cell = floor(positionWorld.mul(cells).add(OFFSET))
  const top = smoothstep(0.5, 0.8, normalWorld.y)
  // Seeds stay below 2^24 so float32 keeps every cell distinct before the unsigned hash.
  const topSeed = cell.x.add(cell.z.mul(613)).add(salt)
  const along = floor(positionWorld.x.add(positionWorld.z).mul(cells).add(OFFSET))
  const sideSeed = cell.y
    .mul(911)
    .add(along.mul(7))
    .add(1_000_003 + salt)
  const shade = mix(hash(sideSeed), hash(topSeed), top)
  const hue = mix(hash(sideSeed.add(1)), hash(topSeed.add(7)), top)
  // Moss cells lean green, soil cells warm; both stay within the vertex colour's value.
  const tint = mix(vec3(1.06, 0.97, 0.88), vec3(0.94, 1.05, 0.9), hue)
  const factor = tint.mul(float(1 - value).add(shade.mul(2 * value)))
  // Fade by on-screen cell size: full detail while a cell spans more than about four pixels.
  const footprint = max(
    fwidth(positionWorld.x),
    max(fwidth(positionWorld.y), fwidth(positionWorld.z)),
  )
  const detail = smoothstep(0.25, 0.5, footprint.mul(cells)).oneMinus()
  return mix(vec3(1), factor, detail.mul(mix(0.7, 1, top)))
}

/**
 * Last Signal's ground is never one flat colour per block: the top of a voxel breaks into
 * micro-voxels of moss, soil and litter, and its sides into square cells too. This multiplies the
 * vertex colour by two quantised world-space octaves: 6 cm cells (value ±12%, a slight moss/soil
 * hue shift) near the camera, and 12.5 cm cells (±8%) that carry on where the fine ones fade, so
 * the mid-ground and far hills still break into cells instead of flat faces.
 */
export function applyTerrainDetail(material: MeshStandardNodeMaterial, sky: TerrainSkyFill) {
  sky.applyTo(material)
  const fine = microCells(CELLS, 0, 0.12)
  const coarse = microCells(COARSE_CELLS, 5_003_009, 0.08)
  material.colorNode = vec4(fine.mul(coarse), 1)
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

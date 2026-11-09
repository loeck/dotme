import { LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, Texture } from 'three/webgpu'

import { isLowPowerDevice } from './device-profile'
import type { ResourceScope } from './resource-scope'
import { terrainImages } from './terrain-images'
import type { ScanImage, ScanName } from './terrain-images'

export type SurfaceScan = Readonly<{ color: Texture; surface: Texture }>
export type TerrainTextures = Readonly<
  Record<'grass' | 'forest' | 'rock' | 'bark', SurfaceScan | undefined>
>

/**
 * Local CC0 scans; surface packs linear roughness (R) and height (G). The images usually
 * started decoding with world preparation (`terrain-images.ts`); this only wraps them.
 */
export async function loadTerrainTextures(
  resources: ResourceScope,
  anisotropy: number,
  lowPower = isLowPowerDevice(),
): Promise<TerrainTextures> {
  const images = terrainImages(lowPower)
  const wrap = (name: string, { image, flipped }: ScanImage, color: boolean) => {
    const map = resources.own(new Texture(image))
    map.name = name
    map.flipY = !flipped
    map.wrapS = map.wrapT = RepeatWrapping
    // Trilinear with bounded anisotropy: the grazing view minifies the tiles strongly.
    map.minFilter = LinearMipmapLinearFilter
    map.generateMipmaps = true
    map.anisotropy = anisotropy
    if (color) map.colorSpace = SRGBColorSpace
    map.needsUpdate = true
    return map
  }
  const pair = async (name: ScanName): Promise<SurfaceScan | undefined> => {
    try {
      const { color, surface } = await images[name]
      return {
        color: wrap(`${name}-color`, color, true),
        surface: wrap(`${name}-surface`, surface, false),
      }
    } catch {
      // One missing material keeps its procedural fallback without losing the others.
      return undefined
    }
  }
  const [grass, forest, rock, bark] = await Promise.all([
    pair('grass_ground'),
    pair('forest_floor'),
    pair('rock_01'),
    pair('bark_brown_01'),
  ])
  return { grass, forest, rock, bark }
}

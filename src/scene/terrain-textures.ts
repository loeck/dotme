import { RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three/webgpu'
import type { Texture } from 'three/webgpu'

import type { ResourceScope } from './resource-scope'

export type TerrainTextures = Readonly<{
  grass: { color: Texture; surface: Texture }
  forest: { color: Texture; surface: Texture }
}>

/** Local CC0 scans; surface packs linear roughness (R) and height (G). */
export async function loadTerrainTextures(
  resources: ResourceScope,
  anisotropy: number,
): Promise<TerrainTextures | undefined> {
  const loader = new TextureLoader()
  const load = async (name: string, color = false) => {
    const map = resources.own(
      await loader.loadAsync(`${import.meta.env.BASE_URL}textures/terrain/${name}.webp`),
    )
    map.name = name
    map.wrapS = map.wrapT = RepeatWrapping
    map.anisotropy = anisotropy
    if (color) map.colorSpace = SRGBColorSpace
    return map
  }
  try {
    const [grassColor, grassSurface, forestColor, forestSurface] = await Promise.all([
      load('grass_ground-color', true),
      load('grass_ground-surface'),
      load('forest_floor-color', true),
      load('forest_floor-surface'),
    ])
    return {
      grass: { color: grassColor, surface: grassSurface },
      forest: { color: forestColor, surface: forestSurface },
    }
  } catch {
    // A missing scan must not prevent the procedural landscape from starting.
    return undefined
  }
}

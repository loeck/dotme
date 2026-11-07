import { RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three/webgpu'
import type { Texture } from 'three/webgpu'

import type { ResourceScope } from './resource-scope'

export type SurfaceScan = Readonly<{ color: Texture; surface: Texture }>
export type TerrainTextures = Readonly<
  Record<'grass' | 'forest' | 'rock' | 'bark', SurfaceScan | undefined>
>

/** Local CC0 scans; surface packs linear roughness (R) and height (G). */
export async function loadTerrainTextures(
  resources: ResourceScope,
  anisotropy: number,
): Promise<TerrainTextures> {
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
  const pair = async (name: string): Promise<SurfaceScan | undefined> => {
    try {
      const [color, surface] = await Promise.all([
        load(`${name}-color`, true),
        load(`${name}-surface`),
      ])
      return { color, surface }
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

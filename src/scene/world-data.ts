import { createCloudNoiseData } from './cloud-noise'
import {
  prepareSubmergedSurface,
  prepareWaterSurface,
  prepareWaterMask,
} from './lake-geometry-data'
import { prepareVegetation } from './vegetation-placement'
import { prepareTerrain } from './voxel-mesh'
import { createVoxelWorld } from './voxel-world'

export function prepareWorld(seed: number, mobile: boolean) {
  const world = createVoxelWorld(seed, mobile)
  const terrain = prepareTerrain(world)
  const vegetation = prepareVegetation(world, seed >>> 0, mobile)
  // The renderer needs typed mesh/BVH buffers, not 60k structured-cloned objects.
  const { voxels: _voxels, ...data } = world
  return {
    world: data,
    terrain,
    vegetation,
    noise: createCloudNoiseData(seed),
    surfaces: {
      submerged: prepareSubmergedSurface(world.lakeBed),
      water: prepareWaterSurface(mobile),
      mask: prepareWaterMask(world.lakeBed),
    },
  }
}
export type PreparedWorld = ReturnType<typeof prepareWorld>

/** Transfer ownership of every typed buffer, including bathymetry and BVH data. */
export function worldTransfers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  const visit = (child: unknown) => {
    if (ArrayBuffer.isView(child) && child.buffer instanceof ArrayBuffer) buffers.add(child.buffer)
    else if (Array.isArray(child)) for (const item of child) visit(item)
    else if (child && typeof child === 'object')
      for (const item of Object.values(child)) visit(item)
  }
  visit(value)
  return [...buffers]
}

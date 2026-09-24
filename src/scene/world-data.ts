import { createCloudNoiseData } from './cloud-noise'
import { prepareTerrain } from './voxel-mesh'
import { createVoxelWorld } from './voxel-world'

export function prepareWorld(seed: number, mobile: boolean) {
  const world = createVoxelWorld(seed, mobile)
  const terrain = prepareTerrain(world)
  // The renderer needs typed mesh/BVH buffers, not 60k structured-cloned objects.
  const { voxels: _voxels, ...data } = world
  return { world: data, terrain, noise: createCloudNoiseData(seed) }
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

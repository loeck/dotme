import { Scene, Mesh, BufferGeometry, BufferAttribute } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { LakeWaterfall } from './lake-waterfall'
import type { VoxelWaterfall } from './voxel-world'

afterEach(() => vi.restoreAllMocks())

const fall = {
  x: -22,
  z: -18,
  top: 3,
  width: 1.2,
  seed: 42,
  direction: [1, 0],
  basin: [
    { x: -22.53, z: -18, size: 1 },
    { x: -23.53, z: -18, size: 1 },
  ],
} satisfies VoxelWaterfall

describe('lake waterfall lifecycle', () => {
  it('orients impacts into the lake without catching up a suspended emission clock', () => {
    const scene = new Scene()
    const waterfall = new LakeWaterfall(scene, fall, false, false)
    const hits: Array<{ x: number; z: number; radius: number; velocity: number }> = []
    waterfall.onImpact = (x, z, radius, velocity) => hits.push({ x, z, radius, velocity })
    waterfall.update(0, 1, 1)
    waterfall.update(0.3, 1, 1)
    waterfall.update(60, 1, 1)
    waterfall.update(60, 1, 1)
    expect(hits).toHaveLength(2)
    for (const hit of hits) {
      expect(hit.x).toBeGreaterThan(fall.x)
      expect(Math.abs(hit.z - fall.z)).toBeLessThan(fall.width / 2)
      expect(hit.radius).toBeGreaterThan(0)
      expect(hit.velocity).toBeLessThan(0)
    }
    const releases: Array<Mock<() => void>> = []
    waterfall.group.traverse((object) => {
      if (!(object instanceof Mesh) || !(object.geometry instanceof BufferGeometry)) return
      const release = vi.fn<() => void>()
      object.geometry.addEventListener('dispose', release)
      releases.push(release)
    })
    for (const material of waterfall.materials) {
      const release = vi.fn<() => void>()
      material.addEventListener('dispose', release)
      releases.push(release)
    }
    waterfall.dispose()
    waterfall.dispose()
    waterfall.update(120, 1, 1)
    expect(hits).toHaveLength(2)
    expect(scene.children).toHaveLength(0)
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps reduced-motion water visible without emitting impacts', () => {
    const scene = new Scene()
    const waterfall = new LakeWaterfall(scene, fall, true, true)
    const impact = vi.fn<() => void>()
    waterfall.onImpact = impact
    waterfall.update(0, 0, 1)
    waterfall.update(60, 1, 1)
    expect(waterfall.group.visible).toBe(true)
    expect(waterfall.group.children).toHaveLength(5)
    const basin = waterfall.group.getObjectByName('waterfall-basin')
    expect(basin).toBeInstanceOf(Mesh)
    if (!(basin instanceof Mesh) || !(basin.geometry instanceof BufferGeometry))
      throw new Error('Missing basin mesh')
    waterfall.group.updateMatrixWorld(true)
    const positions: unknown = basin.geometry.getAttribute('position')
    if (!(positions instanceof BufferAttribute)) throw new Error('Missing basin positions')
    for (let i = 0; i < positions.count; i++) {
      expect(positions.getY(i) + waterfall.group.position.y).toBeCloseTo(fall.top, 6)
    }
    expect(impact).not.toHaveBeenCalled()
    waterfall.dispose()
  })
})

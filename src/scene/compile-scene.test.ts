import { Group, Mesh, Scene } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { compileWithoutCulling } from './compile-scene'

describe('complete scene compilation', () => {
  it('includes off-axis and temporarily hidden meshes, restoring state before async completion', async () => {
    const scene = new Scene()
    const hidden = new Group()
    hidden.visible = false
    const culled = new Mesh(),
      alwaysVisible = new Mesh()
    alwaysVisible.frustumCulled = false
    culled.position.set(1000, 0, 0)
    hidden.add(culled)
    scene.add(hidden, alwaysVisible)
    const pending = Promise.resolve()
    const result = compileWithoutCulling(scene, () => {
      expect(culled.frustumCulled).toBe(false)
      expect(alwaysVisible.frustumCulled).toBe(false)
      expect(hidden.visible).toBe(false)
      return pending
    })
    expect(result).toBe(pending)
    expect(culled.frustumCulled).toBe(true)
    expect(alwaysVisible.frustumCulled).toBe(false)
    await result
  })

  it('restores culling when render-list collection fails', () => {
    const scene = new Scene(),
      mesh = new Mesh()
    scene.add(mesh)
    expect(() =>
      compileWithoutCulling(scene, () => {
        throw new Error('Compilation failed')
      }),
    ).toThrow('Compilation failed')
    expect(mesh.frustumCulled).toBe(true)
  })
})

import { Mesh } from 'three/webgpu'
import type { Object3D } from 'three/webgpu'

/** Collect every view's mesh variants once; restore culling before async work yields. */
export function compileWithoutCulling(scene: Object3D, compile: () => Promise<void>) {
  const states = new Map<Object3D, boolean>()
  scene.traverse((object) => {
    if (object instanceof Mesh) states.set(object, object.frustumCulled)
  })
  try {
    for (const mesh of states.keys()) mesh.frustumCulled = false
    return compile()
  } finally {
    for (const [mesh, culled] of states) mesh.frustumCulled = culled
  }
}

import type { Object3D, WebGPURenderer } from 'three/webgpu'

import type { SceneElimination, SceneGpuInfo, SceneRenderDiagnostics } from './diagnostics'

/** Clearing layer masks removes a group from every camera without touching visibility state. */
function createElimination(
  groups: Record<string, readonly Object3D[]>,
  requestFrame: () => void,
): SceneElimination {
  const saved = new Map<Object3D, number>()
  const restore = () => {
    for (const [object, mask] of saved) object.layers.mask = mask
    saved.clear()
  }
  return {
    groups: Object.keys(groups).filter((name) => groups[name]?.length),
    hide: (name) => {
      restore()
      for (const root of (name && groups[name]) || [])
        root.traverse((object) => {
          saved.set(object, object.layers.mask)
          object.layers.mask = 0
        })
      requestFrame()
    },
  }
}

/**
 * Narrow benchmark hooks on `window` (GPU counters, pass capture, group elimination); read by
 * page.evaluate, never by the scene itself. Returns their removal, which also disposes the
 * render diagnostics and restores any eliminated group.
 */
export function publishSceneHooks(
  renderer: WebGPURenderer,
  diagnostics: SceneRenderDiagnostics,
  groups: Record<string, readonly Object3D[]>,
  requestFrame: () => void,
) {
  const gpuInfo = (): SceneGpuInfo => ({
    programs: renderer.info.memory.programs,
    frameCalls: renderer.info.render.frameCalls,
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
  })
  window.sceneGpuInfo = gpuInfo
  const renderCapture: Window['sceneRenderCapture'] = {
    start: () => diagnostics.start(renderer),
    stop: () => diagnostics.stop(),
    resolveGpu: () => diagnostics.resolveGpu(),
  }
  window.sceneRenderCapture = renderCapture
  const elimination = createElimination(groups, requestFrame)
  window.sceneElimination = elimination
  return () => {
    if (window.sceneGpuInfo === gpuInfo) delete window.sceneGpuInfo
    if (window.sceneRenderCapture === renderCapture) delete window.sceneRenderCapture
    diagnostics.dispose()
    if (window.sceneElimination === elimination) {
      elimination.hide(null)
      delete window.sceneElimination
    }
  }
}

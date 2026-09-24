import { WebGPURenderer } from 'three/webgpu'

import { isLowPowerDevice, maxPixelRatio } from '../scene/device-profile'

export type GraphicsBackend = 'webgpu' | 'webgl'

/** Owns the sole renderer; scenes only borrow it. */
export class GpuRuntime {
  readonly renderer: WebGPURenderer
  readonly backend: GraphicsBackend
  private disposed = false
  private initialized = false
  private release: Promise<void> | undefined
  onFailure: (() => void) | undefined

  readonly canvas: HTMLCanvasElement
  private readonly device: GPUDevice | undefined

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice | undefined) {
    this.device = device
    this.canvas = canvas
    this.backend = device ? 'webgpu' : 'webgl'
    this.renderer = new WebGPURenderer({
      canvas,
      antialias: false,
      alpha: false,
      ...(device ? { device } : { forceWebGL: true }),
    })
    const lost = () => {
      if (!this.disposed) this.onFailure?.()
    }
    this.renderer.onDeviceLost = lost
    const reportError = this.renderer.onError.bind(this.renderer)
    this.renderer.onError = (error) => {
      reportError(error)
      lost()
    }
    void device?.lost.then(lost)
  }

  static async create(canvas: HTMLCanvasElement, signal: AbortSignal) {
    signal.throwIfAborted()
    const device = await requestDevice(signal)
    if (!device) await restoreWebGLContext(canvas, signal)
    const runtime = new GpuRuntime(canvas, device)
    const abort = () => {
      void runtime.dispose()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await runtime.renderer.init()
      runtime.initialized = true
      signal.throwIfAborted()
      runtime.resize()
      const expected = runtime.backend === 'webgpu' ? 'isWebGPUBackend' : 'isWebGLBackend'
      if (!(expected in runtime.renderer.backend)) throw new Error('Graphics initialization failed')
      if (!device) retainWebGLContext(canvas)
      canvas.dataset.backend = runtime.backend
      return runtime
    } catch (error) {
      await runtime.dispose()
      // Renderer.dispose() deliberately skips an incompletely initialized backend.
      if (!runtime.initialized) {
        const backend = runtime.renderer.backend
        if (hasDispose(backend)) {
          try {
            await backend.dispose()
          } catch {
            /* A failed device may already be gone. */
          }
        }
      }
      device?.destroy()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  resize() {
    if (this.disposed) return
    this.renderer.setPixelRatio(maxPixelRatio(isLowPowerDevice()))
    this.renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight), false)
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.onFailure = undefined
    if (this.initialized)
      this.release ??= Promise.resolve()
        .then(() => this.renderer.dispose())
        .catch(() => {})
        .finally(() => this.device?.destroy())
    return this.release ?? Promise.resolve()
  }
}

/** A WebGPU device, or undefined when the browser can only offer WebGL 2. */
async function requestDevice(signal: AbortSignal) {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  signal.throwIfAborted()
  if (!adapter) return undefined
  const requiredFeatures: GPUFeatureName[] = adapter.features.has('float32-filterable')
    ? ['float32-filterable']
    : []
  const device = await adapter.requestDevice({ requiredFeatures }).catch(() => undefined)
  if (signal.aborted) {
    device?.destroy()
    signal.throwIfAborted()
  }
  return device
}

const webglContexts = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>()

/** The WebGL backend loses the canvas context on dispose; keep it restorable for page restoration. */
function retainWebGLContext(canvas: HTMLCanvasElement) {
  if (webglContexts.has(canvas)) return
  const control = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  if (!control) return
  webglContexts.set(canvas, control)
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault())
}

async function restoreWebGLContext(canvas: HTMLCanvasElement, signal: AbortSignal) {
  const control = webglContexts.get(canvas)
  if (!control || !canvas.getContext('webgl2')?.isContextLost()) return
  const restored = new Promise((resolve) => {
    canvas.addEventListener('webglcontextrestored', resolve, { once: true })
  })
  control.restoreContext()
  await restored
  signal.throwIfAborted()
}

function hasDispose(value: object): value is { dispose(): unknown } {
  return 'dispose' in value && typeof value.dispose === 'function'
}

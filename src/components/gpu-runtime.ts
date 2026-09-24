import { WebGPURenderer } from 'three/webgpu'

/** Owns the sole renderer; scenes only borrow it. */
export class GpuRuntime {
  readonly renderer: WebGPURenderer
  private disposed = false
  private initialized = false
  private release: Promise<void> | undefined
  onFailure: (() => void) | undefined

  readonly canvas: HTMLCanvasElement
  private readonly device: GPUDevice

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.device = device
    this.canvas = canvas
    this.renderer = new WebGPURenderer({ canvas, antialias: false, alpha: false, device })
    const lost = () => {
      if (!this.disposed) this.onFailure?.()
    }
    this.renderer.onDeviceLost = lost
    const reportError = this.renderer.onError.bind(this.renderer)
    this.renderer.onError = (error) => {
      reportError(error)
      lost()
    }
    void device.lost.then(lost)
  }

  static async create(canvas: HTMLCanvasElement, signal: AbortSignal) {
    signal.throwIfAborted()
    const adapter = await navigator.gpu?.requestAdapter()
    signal.throwIfAborted()
    if (!adapter) throw new Error('WebGPU is unavailable')
    const requiredFeatures: GPUFeatureName[] = adapter.features.has('float32-filterable')
      ? ['float32-filterable']
      : []
    const device = await adapter.requestDevice({ requiredFeatures })
    if (signal.aborted) {
      device.destroy()
      signal.throwIfAborted()
    }
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
      const backend = runtime.renderer.backend
      if (!('isWebGPUBackend' in backend)) throw new Error('WebGPU initialization failed')
      canvas.dataset.backend = 'webgpu'
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
      device.destroy()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  resize() {
    if (this.disposed) return
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, innerWidth < 768 ? 1.5 : 1.75))
    this.renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight), false)
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.onFailure = undefined
    if (this.initialized)
      this.release ??= Promise.resolve()
        .then(() => this.renderer.dispose())
        .catch(() => {})
        .finally(() => this.device.destroy())
    return this.release ?? Promise.resolve()
  }
}

function hasDispose(value: object): value is { dispose(): unknown } {
  return 'dispose' in value && typeof value.dispose === 'function'
}

import { TimestampQuery } from 'three/webgpu'
import type { Backend, Camera, ComputeNode, InspectorBase, RenderTarget, Scene } from 'three/webgpu'

export type SceneGpuInfo = {
  programs: number
  frameCalls: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
}

export type ScenePassSample = { cpuMs: number; renderCalls: number; gpuMs: number | null }
export type SceneRenderCapture = {
  intervalsMs: number[]
  frameCpuMs: number[]
  passes: Record<string, ScenePassSample[]>
  /** GPU time summed over the capture by render context: the labeler's name, else the pass's. */
  targets: Record<string, number>
  gpuAvailable: boolean
}

export type RenderLabeler = (
  scene: Scene,
  camera: Camera,
  renderTarget: RenderTarget | null,
) => string | undefined

type PassStart = { name: string; at: number; renderCalls: number }

type TimestampBackend = {
  trackTimestamp: boolean
  getTimestamp: (uid: string) => number | null
  hasTimestampQuery: (uid: string) => boolean
}

export type GpuCaptureRenderer = {
  readonly backend: Backend | TimestampBackend
  readonly inspector: InspectorBase
  hasFeature: (name: string) => boolean
  resolveTimestampsAsync: (type?: TimestampQuery) => Promise<number | undefined>
}

type PendingGpuSample = { sample: ScenePassSample; uids: string[]; rounds: number }

type GpuSession = {
  renderer: GpuCaptureRenderer
  capture: SceneRenderCapture
  labels: Map<string, string>
  backend: TimestampBackend
  trackTimestampBefore: boolean
  beginRenderBefore: InspectorBase['beginRender']
  beginComputeBefore: InspectorBase['beginCompute']
  pending: PendingGpuSample[]
  pendingUids: number
  computeSeen: boolean
  resolving: boolean
}

const TIMESTAMP_FEATURE = 'timestamp-query'
// Three's pool holds 1024 contexts and discards unclaimed timestamps on overflow.
const RESOLVE_AT_UIDS = 600
const MAX_UNRESOLVED_ROUNDS = 2

function timestampBackend(backend: Backend | TimestampBackend): TimestampBackend | null {
  if ('trackTimestamp' in backend && 'getTimestamp' in backend && 'hasTimestampQuery' in backend)
    return backend
  return null
}

/** Collect only while a benchmark is recording. */
export class SceneRenderDiagnostics {
  private static active: SceneRenderDiagnostics | null = null
  private capture: SceneRenderCapture | null = null
  private settled: SceneRenderCapture | null = null
  private gpu: GpuSession | null = null
  private openPasses: { name: string; uids: string[] }[] = []
  private previousFrameAt: number | null = null

  start(renderer?: GpuCaptureRenderer, labeler?: RenderLabeler) {
    this.teardownGpu()
    this.capture = {
      intervalsMs: [],
      frameCpuMs: [],
      passes: {},
      targets: {},
      gpuAvailable: false,
    }
    this.settled = null
    this.openPasses = []
    this.previousFrameAt = null
    if (renderer) this.setupGpu(renderer, this.capture, labeler)
  }

  stop(): SceneRenderCapture | null {
    const result = this.capture
    this.capture = null
    this.settled = result
    this.openPasses = []
    this.previousFrameAt = null
    return result
  }

  async resolveGpu(): Promise<SceneRenderCapture | null> {
    const settled = this.settled
    const gpu = this.gpu
    this.teardownGpu()
    if (!settled) return null
    if (gpu && gpu.pending.length > 0) {
      await this.resolvePools(gpu)
      this.drainGpu(gpu, true)
    }
    return settled
  }

  frameStart(now: number): number {
    if (!this.capture) return 0
    SceneRenderDiagnostics.active = this
    if (this.previousFrameAt !== null) this.capture.intervalsMs.push(now - this.previousFrameAt)
    this.previousFrameAt = now
    return performance.now()
  }

  frameEnd(start: number) {
    if (this.capture) this.capture.frameCpuMs.push(performance.now() - start)
    if (SceneRenderDiagnostics.active === this) SceneRenderDiagnostics.active = null
    void this.maybeResolveGpu()
  }

  static beginActive(name: string, renderCalls: number): PassStart | null {
    return SceneRenderDiagnostics.active?.begin(name, renderCalls) ?? null
  }

  static endActive(start: PassStart | null, renderCalls: number) {
    SceneRenderDiagnostics.active?.end(start, renderCalls)
  }

  begin(name: string, renderCalls: number): PassStart | null {
    if (!this.capture) return null
    this.openPasses.push({ name, uids: [] })
    return { name, at: performance.now(), renderCalls }
  }

  end(start: PassStart | null, renderCalls: number) {
    if (!start || !this.capture) return
    const uids = this.openPasses.pop()?.uids ?? []
    const sample: ScenePassSample = {
      cpuMs: performance.now() - start.at,
      renderCalls: renderCalls - start.renderCalls,
      gpuMs: null,
    }
    ;(this.capture.passes[start.name] ??= []).push(sample)
    if (this.gpu && uids.length > 0) {
      this.gpu.pending.push({ sample, uids, rounds: 0 })
      this.gpu.pendingUids += uids.length
    }
  }

  private setupGpu(
    renderer: GpuCaptureRenderer,
    capture: SceneRenderCapture,
    labeler?: RenderLabeler,
  ) {
    if (!renderer.hasFeature(TIMESTAMP_FEATURE)) return
    const backend = timestampBackend(renderer.backend)
    if (!backend) return
    const inspector = renderer.inspector
    const session: GpuSession = {
      renderer,
      capture,
      labels: new Map(),
      backend,
      trackTimestampBefore: backend.trackTimestamp,
      beginRenderBefore: inspector.beginRender.bind(inspector),
      beginComputeBefore: inspector.beginCompute.bind(inspector),
      pending: [],
      pendingUids: 0,
      computeSeen: false,
      resolving: false,
    }
    inspector.beginRender = (
      uid: string,
      scene: Scene,
      camera: Camera,
      renderTarget: RenderTarget,
    ) => {
      const open = this.openPasses.at(-1)
      if (open) {
        open.uids.push(uid)
        session.labels.set(uid, labeler?.(scene, camera, renderTarget) ?? open.name)
      }
      session.beginRenderBefore(uid, scene, camera, renderTarget)
    }
    inspector.beginCompute = (uid: string, computeNode: ComputeNode) => {
      const open = this.openPasses.at(-1)
      if (open) {
        open.uids.push(uid)
        session.labels.set(uid, `${open.name} compute`)
      }
      session.computeSeen = true
      session.beginComputeBefore(uid, computeNode)
    }
    backend.trackTimestamp = true
    this.gpu = session
    capture.gpuAvailable = true
  }

  private teardownGpu() {
    const gpu = this.gpu
    this.gpu = null
    if (!gpu) return
    const inspector = gpu.renderer.inspector
    inspector.beginRender = gpu.beginRenderBefore
    inspector.beginCompute = gpu.beginComputeBefore
    gpu.backend.trackTimestamp = gpu.trackTimestampBefore
  }

  private async maybeResolveGpu() {
    const gpu = this.gpu
    if (!gpu || gpu.resolving || gpu.pendingUids < RESOLVE_AT_UIDS) return
    gpu.resolving = true
    try {
      await this.resolvePools(gpu)
      if (this.gpu === gpu) this.drainGpu(gpu)
    } finally {
      gpu.resolving = false
    }
  }

  private async resolvePools(gpu: GpuSession) {
    await gpu.renderer.resolveTimestampsAsync(TimestampQuery.RENDER)
    // An empty pool still costs a GPU round trip.
    if (gpu.computeSeen) await gpu.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE)
  }

  private drainGpu(gpu: GpuSession, final = false) {
    const remaining: PendingGpuSample[] = []
    for (const pending of gpu.pending) {
      const missed: string[] = []
      for (const uid of pending.uids) {
        if (gpu.backend.hasTimestampQuery(uid)) {
          const elapsed = gpu.backend.getTimestamp(uid) ?? 0
          pending.sample.gpuMs = (pending.sample.gpuMs ?? 0) + elapsed
          const label = gpu.labels.get(uid) ?? 'render'
          gpu.capture.targets[label] = (gpu.capture.targets[label] ?? 0) + elapsed
          gpu.labels.delete(uid)
        } else missed.push(uid)
      }
      gpu.pendingUids -= pending.uids.length - missed.length
      pending.uids = missed
      pending.rounds += 1
      if (missed.length === 0 || final || pending.rounds > MAX_UNRESOLVED_ROUNDS) {
        pending.sample.gpuMs ??= 0
      } else remaining.push(pending)
    }
    gpu.pending = remaining
  }
}

/** Debug-only scene groups that the perf panel removes one at a time to price them. */
export type SceneElimination = {
  groups: readonly string[]
  hide: (group: string | null) => void
}

declare global {
  interface Window {
    sceneElimination?: SceneElimination
    sceneGpuInfo?: () => SceneGpuInfo
    sceneRenderCapture?: {
      start: () => void
      stop: () => SceneRenderCapture | null
      resolveGpu: () => Promise<SceneRenderCapture | null>
    }
  }
}

/** Public renderer statistics used without depending on either graphics backend. */
export interface DiagnosticRenderer {
  readonly info: {
    autoReset: boolean
    readonly render: {
      readonly calls: number
      readonly drawCalls?: number
      readonly triangles: number
    }
    readonly memory: {
      readonly geometries: number
      readonly textures: number
      readonly programs?: number
    }
    reset(): void
  }
}
export type PassSample = {
  cpuMs: number
  gpuMs: number | null
  calls: number
  triangles: number
  executions: number
}
export type FrameSample = {
  time: number
  intervalMs: number
  cpuMs: number
  passes: Record<string, PassSample>
  resources: { geometries: number; textures: number; programs: number }
}
export type DiagnosticSnapshot = Readonly<{
  gpuTimers: boolean
  frames: readonly Readonly<{
    time: number
    intervalMs: number
    cpuMs: number
    passes: Readonly<Record<string, Readonly<PassSample>>>
    resources: Readonly<FrameSample['resources']>
  }>[]
}>
type Segment = { sample: PassSample; start: number; calls: number; triangles: number }

/** Bounded, opt-in CPU submission diagnostics. GPU timings remain null unless
 * measured by a backend timestamp query; submission time is never presented as GPU time. */
export class RenderDiagnostics {
  private readonly renderer: DiagnosticRenderer
  private readonly stack: Segment[] = []
  private readonly frames: FrameSample[] = []
  private frame: FrameSample | null = null
  private started = 0
  private lastTime: number | null = null
  private readonly autoReset: boolean
  constructor(renderer: DiagnosticRenderer) {
    this.renderer = renderer
    this.autoReset = renderer.info.autoReset
    renderer.info.autoReset = false
  }
  begin(time: number) {
    this.renderer.info.reset()
    this.started = performance.now()
    this.frame = {
      time,
      intervalMs: this.lastTime === null ? 0 : time - this.lastTime,
      cpuMs: 0,
      passes: {},
      resources: { geometries: 0, textures: 0, programs: 0 },
    }
    this.lastTime = time
  }
  measure<T>(name: string, action: () => T): T {
    if (!this.frame) return action()
    const parent = this.stack.at(-1)
    if (parent) this.pause(parent)
    const sample = (this.frame.passes[name] ??= {
      cpuMs: 0,
      gpuMs: null,
      calls: 0,
      triangles: 0,
      executions: 0,
    })
    sample.executions++
    const segment: Segment = { sample, start: 0, calls: 0, triangles: 0 }
    this.stack.push(segment)
    this.resume(segment)
    try {
      return action()
    } finally {
      this.pause(segment)
      this.stack.pop()
      if (parent) this.resume(parent)
    }
  }
  private resume(segment: Segment) {
    segment.start = performance.now()
    segment.calls = this.renderer.info.render.drawCalls ?? this.renderer.info.render.calls
    segment.triangles = this.renderer.info.render.triangles
  }
  private pause(segment: Segment) {
    segment.sample.cpuMs += performance.now() - segment.start
    segment.sample.calls +=
      (this.renderer.info.render.drawCalls ?? this.renderer.info.render.calls) - segment.calls
    segment.sample.triangles += this.renderer.info.render.triangles - segment.triangles
  }
  end() {
    if (!this.frame) return
    this.frame.cpuMs = performance.now() - this.started
    const { geometries, textures, programs = 0 } = this.renderer.info.memory
    this.frame.resources = { geometries, textures, programs }
    this.frames.push(this.frame)
    if (this.frames.length > 3600) this.frames.shift()
    this.frame = null
  }
  snapshot(): DiagnosticSnapshot {
    return { gpuTimers: false, frames: structuredClone(this.frames) }
  }
  dispose() {
    this.stack.length = 0
    this.frames.length = 0
    this.frame = null
    this.renderer.info.autoReset = this.autoReset
  }
}

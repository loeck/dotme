import type { WebGLRenderer } from 'three'

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
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
type Segment = {
  name: string
  sample: PassSample
  start: number
  calls: number
  triangles: number
  query: WebGLQuery | null
}

/** Opt-in, bounded diagnostics. Nested passes split GPU queries into exclusive
 * segments; no blocking query reads, no nested TIME_ELAPSED queries. */
export class RenderDiagnostics {
  private readonly gl: WebGL2RenderingContext
  private readonly extension: TimerExtension | null
  private readonly pending: { query: WebGLQuery; sample: PassSample }[] = []
  private readonly stack: Segment[] = []
  private readonly frames: FrameSample[] = []
  private frame: FrameSample | null = null
  private started = 0
  private lastTime: number | null = null
  private readonly autoReset: boolean
  private disjoint = false
  private readonly gpu = new WeakMap<
    PassSample,
    { pending: number; total: number; invalid: boolean }
  >()

  constructor(private readonly renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext
    this.extension = this.gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as TimerExtension | null
    this.autoReset = renderer.info.autoReset
    renderer.info.autoReset = false
  }

  begin(time: number) {
    this.poll()
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
    if (!this.gpu.has(sample)) this.gpu.set(sample, { pending: 0, total: 0, invalid: false })
    const segment: Segment = { name, sample, start: 0, calls: 0, triangles: 0, query: null }
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
    segment.calls = this.renderer.info.render.calls
    segment.triangles = this.renderer.info.render.triangles
    const gpu = this.gpu.get(segment.sample)!
    segment.sample.gpuMs = null
    if (this.extension && !this.disjoint && this.pending.length < 256 && !this.gl.isContextLost()) {
      segment.query = this.gl.createQuery()
      if (segment.query) {
        gpu.pending++
        this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, segment.query)
      } else gpu.invalid = true
    } else gpu.invalid = true
  }

  private pause(segment: Segment) {
    segment.sample.cpuMs += performance.now() - segment.start
    segment.sample.calls += this.renderer.info.render.calls - segment.calls
    segment.sample.triangles += this.renderer.info.render.triangles - segment.triangles
    if (segment.query && this.extension) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT)
      this.pending.push({ query: segment.query, sample: segment.sample })
      segment.query = null
    }
  }

  private poll() {
    if (!this.extension) return
    this.disjoint =
      this.gl.isContextLost() || !!this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pending = this.pending[i]!
      if (
        this.disjoint ||
        this.gl.getQueryParameter(pending.query, this.gl.QUERY_RESULT_AVAILABLE)
      ) {
        const gpu = this.gpu.get(pending.sample)!
        gpu.pending--
        if (this.disjoint) gpu.invalid = true
        else gpu.total += this.gl.getQueryParameter(pending.query, this.gl.QUERY_RESULT) / 1e6
        pending.sample.gpuMs = gpu.pending === 0 && !gpu.invalid ? gpu.total : null
        this.gl.deleteQuery(pending.query)
        this.pending.splice(i, 1)
      }
    }
  }

  end() {
    if (!this.frame) return
    this.frame.cpuMs = performance.now() - this.started
    this.frame.resources = {
      ...this.renderer.info.memory,
      programs: this.renderer.info.programs?.length ?? 0,
    }
    this.frames.push(this.frame)
    if (this.frames.length > 3600) this.frames.shift()
    this.frame = null
  }

  snapshot() {
    this.poll()
    return { gpuTimers: !!this.extension, frames: structuredClone(this.frames) }
  }

  dispose() {
    for (const { query } of this.pending) this.gl.deleteQuery(query)
    this.pending.length = 0
    this.frames.length = 0
    this.renderer.info.autoReset = this.autoReset
  }
}

export type SceneGpuInfo = {
  programs: number
  frameCalls: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
}

export type ScenePassSample = { cpuMs: number; renderCalls: number }
export type SceneRenderCapture = {
  intervalsMs: number[]
  frameCpuMs: number[]
  passes: Record<string, ScenePassSample[]>
}

type PassStart = { name: string; at: number; renderCalls: number }

/** Collect only while a benchmark is recording. */
export class SceneRenderDiagnostics {
  private static active: SceneRenderDiagnostics | null = null
  private capture: SceneRenderCapture | null = null
  private previousFrameAt: number | null = null

  start() {
    this.capture = { intervalsMs: [], frameCpuMs: [], passes: {} }
    this.previousFrameAt = null
  }

  stop(): SceneRenderCapture | null {
    const result = this.capture
    this.capture = null
    this.previousFrameAt = null
    return result
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
  }

  static beginActive(name: string, renderCalls: number): PassStart | null {
    return SceneRenderDiagnostics.active?.begin(name, renderCalls) ?? null
  }

  static endActive(start: PassStart | null, renderCalls: number) {
    SceneRenderDiagnostics.active?.end(start, renderCalls)
  }

  begin(name: string, renderCalls: number): PassStart | null {
    return this.capture ? { name, at: performance.now(), renderCalls } : null
  }

  end(start: PassStart | null, renderCalls: number) {
    if (!start || !this.capture) return
    ;(this.capture.passes[start.name] ??= []).push({
      cpuMs: performance.now() - start.at,
      renderCalls: renderCalls - start.renderCalls,
    })
  }
}

declare global {
  interface Window {
    sceneGpuInfo?: () => SceneGpuInfo
    sceneRenderCapture?: { start: () => void; stop: () => SceneRenderCapture | null }
  }
}

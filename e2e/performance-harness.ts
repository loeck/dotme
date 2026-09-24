import { VoxelLandscapeEngine } from '../src/scene/VoxelLandscapeEngine'

let engine: VoxelLandscapeEngine | undefined
const state = () =>
  engine as unknown as {
    renderer: import('three').WebGLRenderer
    frame: number
    elapsed: number
    lastFrameAt: number
    introStartedAt: number | null
    options: { reducedMotion: boolean }
    render(now: number): void
    simulation: import('../src/scene/water-simulation').WaterSimulation
  }
let frames: { intervalMs: number; cpuMs: number; calls: number; triangles: number }[] = []

export function start(seed = 9182, diagnostics = false) {
  stop()
  engine = new VoxelLandscapeEngine({
    container: document.querySelector('#scene')!,
    seed,
    reducedMotion: true,
    diagnostics,
    onFirstFrame() {},
    onContextFailure() {
      throw new Error('Context lost')
    },
  })
  cancelAnimationFrame(state().frame)
  state().frame = 0
}

export function capture(time = 18) {
  const s = state(),
    renderer = s.renderer
  cancelAnimationFrame(s.frame)
  s.options.reducedMotion = false
  s.elapsed = time
  s.introStartedAt = performance.now() - 10_000
  // Stabilize the live environment while keeping all clocks and camera fixed.
  for (let i = 0; i < 3; i++) {
    const now = performance.now()
    s.lastFrameAt = now
    s.render(now)
    cancelAnimationFrame(s.frame)
  }
  const gl = renderer.getContext(),
    width = gl.drawingBufferWidth,
    height = gl.drawingBufferHeight
  const pixels = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  return {
    width,
    height,
    pixels: Array.from(pixels),
    channels: s.simulation.channels ?? 4,
    diagnostics: engine!.getDiagnostics?.() ?? null,
  }
}

export function animate() {
  const s = state(),
    renderer = s.renderer
  s.options.reducedMotion = false
  renderer.info.autoReset = false
  let last = performance.now()
  s.lastFrameAt = last
  s.introStartedAt = last - 10_000
  const render = s.render
  s.render = (now) => {
    renderer.info.reset()
    const before = performance.now()
    render(now)
    frames.push({
      intervalMs: now - last,
      cpuMs: performance.now() - before,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    })
    last = now
  }
  s.frame = requestAnimationFrame(s.render)
}

export function samples(reset = false) {
  const result = frames
  if (reset) frames = []
  return result
}

export function stop() {
  engine?.dispose()
  engine = undefined
  frames = []
}

/** Experiment only: retain every bathymetry texture and original vertex attribute.
 * Coarsen just the index grid, retaining the final row/column at the same bounds. */
export function simplifyBed() {
  const bed = engine as unknown as {
    submerged: { geometry: import('three').BufferGeometry }
    bed: { resolution: number }
  }
  const n = bed.bed.resolution,
    indices: number[] = []
  for (let z = 0; z < n - 1; z += 2)
    for (let x = 0; x < n - 1; x += 2) {
      const x1 = Math.min(n - 1, x + 2),
        z1 = Math.min(n - 1, z + 2)
      const a = z * n + x,
        b = z1 * n + x,
        c = z1 * n + x1,
        d = z * n + x1
      indices.push(a, b, d, b, c, d)
    }
  bed.submerged.geometry.setIndex(indices)
}

export function lifecycle() {
  const lifetimes = []
  for (let i = 0; i < 3; i++) {
    start(12, true)
    capture()
    const renderer = state().renderer
    const before = { ...renderer.info.memory }
    engine!.dispose()
    const after = { ...renderer.info.memory }
    lifetimes.push({ before, after, canvases: document.querySelectorAll('canvas').length })
    renderer.forceContextLoss()
    engine = undefined
  }
  return lifetimes
}

export function readDiagnostics() {
  return engine?.getDiagnostics?.() ?? null
}

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
    camera: import('three').PerspectiveCamera
    rain: import('../src/scene/RainEffect').RainEffect
    solarClock: import('../src/scene/solar-clock').SolarClock
    diagnostics?: import('../src/scene/render-diagnostics').RenderDiagnostics
    simulation: import('../src/scene/water-simulation').WaterSimulation
  }
let frames: { intervalMs: number; cpuMs: number; calls: number; triangles: number }[] = []

export function start(seed = 9182, diagnostics = false, instrumentReferenceRain = false) {
  stop()
  // Keep this harness buildable against pre-rain reference commits as well.
  const params = new URLSearchParams(window.location.search)
  const preset: Record<string, number> = { off: 0, light: 0.25, moderate: 0.55, heavy: 1 }
  const rain = params.get('rain') ?? 'moderate'
  engine = new VoxelLandscapeEngine({
    container: document.querySelector('#scene')!,
    seed,
    reducedMotion: false,
    rain: {
      intensity: Object.hasOwn(preset, rain) ? preset[rain]! : Number(rain),
      wind: { x: Number(params.get('windX') ?? 2), z: Number(params.get('windZ') ?? 0.5) },
    },
    diagnostics,
    onFirstFrame() {},
    onContextFailure() {
      throw new Error('Context lost')
    },
  })
  cancelAnimationFrame(state().frame)
  state().frame = 0
  // Older reference engines lack the dedicated rain scopes; add equivalent instrumentation.
  const s = state()
  if (instrumentReferenceRain && s.diagnostics && s.rain) {
    const update = s.rain.update.bind(s.rain)
    const slopes = s.rain.renderSlopes.bind(s.rain)
    s.rain.update = (...args) => s.diagnostics!.measure('rain-update', () => update(...args))
    s.rain.renderSlopes = (...args) => s.diagnostics!.measure('rain-slopes', () => slopes(...args))
  }
}

export function capture(time = 18) {
  const s = state(),
    renderer = s.renderer
  cancelAnimationFrame(s.frame)
  s.options.reducedMotion = false
  s.elapsed = time
  if (s.solarClock) s.solarClock.elapsed = () => time
  // Three seconds of identical fixed rain steps expose established water impacts.
  if (s.rain) {
    while (s.rain.simulation.state.intensity > 0 && s.rain.simulation.time < 3 - 1e-6)
      s.rain.simulation.update(1 / 60)
  }
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

/** Isolate fixed-step CPU cost from frame pacing and GPU contention. */
export function rainCpu(steps = 600) {
  const rain = state().rain.simulation
  const startAt = performance.now()
  for (let i = 0; i < steps; i++) {
    if (i === 120) rain.setRainState({ intensity: 1, wind: { x: -5, z: 3 } })
    if (i === 360) rain.setRainState({ intensity: 1, wind: { x: 2, z: 0.5 } })
    rain.update(1 / 120)
  }
  const cpuMs = performance.now() - startAt
  const values = new Float64Array([
    ...rain.drops.flatMap((d) => [
      d.x,
      d.y,
      d.z,
      d.vx,
      d.vy,
      d.vz,
      d.size,
      d.seed,
      Number(d.alive),
    ]),
    ...rain.impacts.flatMap((i) => [i.x, i.y, i.z, i.vx, i.vz, i.size, i.seed, i.born]),
  ])
  let hash = 2166136261
  for (const byte of new Uint8Array(values.buffer)) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return { cpuMs, steps, hash, alive: rain.drops.filter((d) => d.alive).length }
}

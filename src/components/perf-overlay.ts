import type { WebGPURenderer } from 'three/webgpu'

import type { SceneRenderCapture } from '../scene/diagnostics'

const WINDOW_MS = 4000
// Children run inside their parent's span: list them under it, never in the total.
const NESTED: Record<string, string> = {
  submergedBed: 'submerged',
  submergedFish: 'submerged',
  view: 'main',
  atmosphere: 'main',
  lens: 'main',
  waterfall: 'view',
  waterfallCapture: 'waterfall',
  waterfallFilters: 'waterfall',
}

const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? 0
const p95 = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * 0.95)] ?? 0
const ms = (value: number | null) => (value === null ? '   -' : value.toFixed(1).padStart(4))

function adapterLabel(renderer: WebGPURenderer) {
  const backend: object = renderer.backend
  const device =
    typeof GPUDevice !== 'undefined' && 'device' in backend && backend.device instanceof GPUDevice
      ? backend.device
      : undefined
  if (!device) return 'webgl'
  const info = device.adapterInfo
  return ['webgpu', info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
}

export function summarize(capture: SceneRenderCapture) {
  const interval = median(capture.intervalsMs)
  // Alternate-frame passes are averaged over every frame, not over the frames they ran.
  const frames = Math.max(1, capture.frameCpuMs.length)
  const own = new Map<string, { cpuMs: number; gpuMs: number | null }>()
  for (const [name, samples] of Object.entries(capture.passes)) {
    const gpu = samples.map((sample) => sample.gpuMs).filter((value) => value !== null)
    own.set(name, {
      cpuMs: samples.reduce((total, sample) => total + sample.cpuMs, 0) / frames,
      gpuMs: capture.gpuAvailable && gpu.length ? gpu.reduce((a, b) => a + b, 0) / frames : null,
    })
  }
  // Timestamps go to the innermost open pass, so a parent's GPU time is its own plus
  // its children's, and the frame total is the sum of every pass's own time.
  const children = (parent: string | undefined) =>
    [...own.keys()].filter((name) => NESTED[name] === parent)
  const gpuOf = (name: string): number | null => {
    const parts = [own.get(name)?.gpuMs ?? null, ...children(name).map(gpuOf)]
    const known = parts.filter((value) => value !== null)
    return known.length ? known.reduce((a, b) => a + b, 0) : null
  }
  const lines = [
    `${(1000 / Math.max(interval, 1e-3)).toFixed(0)} fps  frame ${ms(interval)} p95 ${ms(p95(capture.intervalsMs))} ms`,
    `cpu ${ms(median(capture.frameCpuMs))} p95 ${ms(p95(capture.frameCpuMs))} ms`,
    '',
    `${'pass'.padEnd(22)}  cpu   gpu`,
  ]
  const visit = (name: string, level: number) => {
    lines.push(
      `${`${'  '.repeat(level)}${name}`.padEnd(22)} ${ms(own.get(name)?.cpuMs ?? 0)}  ${ms(gpuOf(name))}`,
    )
    for (const child of children(name)) visit(child, level + 1)
  }
  for (const name of children(undefined)) visit(name, 0)
  const gpuTotal = [...own.values()].reduce((total, pass) => total + (pass.gpuMs ?? 0), 0)
  lines.push(`${'gpu total'.padEnd(22)}       ${capture.gpuAvailable ? ms(gpuTotal) : '   -'}`)
  const targets = Object.entries(capture.targets)
    .map(([name, total]) => [name, total / frames] as const)
    .filter(([, gpuMs]) => gpuMs >= 0.05)
    .toSorted((a, b) => b[1] - a[1])
  if (targets.length) lines.push('', 'gpu by target')
  for (const [name, gpuMs] of targets) lines.push(`${name.slice(0, 26).padEnd(28)} ${ms(gpuMs)}`)
  return lines.join('\n')
}

/** Rolling per-pass timings on the device itself, behind `?perf`. */
export function initPerfOverlay(renderer: WebGPURenderer, signal: AbortSignal) {
  const panel = document.createElement('pre')
  panel.setAttribute('aria-hidden', 'true')
  Object.assign(panel.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '2147483647',
    margin: '0',
    padding: '6px 8px',
    font: '10px/1.3 ui-monospace, monospace',
    color: '#d8f5d0',
    background: 'rgb(0 0 0 / 0.72)',
    pointerEvents: 'none',
    whiteSpace: 'pre',
  })
  panel.textContent = 'perf: waiting for scene…'
  document.body.append(panel)
  signal.addEventListener('abort', () => panel.remove(), { once: true })

  const header = () => {
    const canvas = renderer.domElement
    const ratio = canvas.width / Math.max(1, canvas.clientWidth)
    return [
      adapterLabel(renderer),
      `${canvas.width}x${canvas.height}  dpr ${ratio.toFixed(2)} (device ${devicePixelRatio.toFixed(2)})`,
    ].join('\n')
  }
  let timer = 0
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  const schedule = (callback: () => void, delay: number) => {
    if (!signal.aborted) timer = window.setTimeout(callback, delay)
  }
  const finish = async (hook: NonNullable<Window['sceneRenderCapture']>) => {
    hook.stop()
    const capture = await hook.resolveGpu()
    if (signal.aborted) return
    if (capture && capture.frameCpuMs.length > 1)
      panel.textContent = `${header()}\n${summarize(capture)}`
    begin()
  }
  const begin = () => {
    const hook = window.sceneRenderCapture
    if (!hook || document.hidden) return schedule(begin, 500)
    hook.start()
    schedule(() => void finish(hook), WINDOW_MS)
  }
  begin()
}

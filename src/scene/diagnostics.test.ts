import { InspectorBase, PerspectiveCamera, RenderTarget, Scene } from 'three/webgpu'
import { expect, it } from 'vitest'

import { required } from '../invariant'
import { SceneRenderDiagnostics } from './diagnostics'
import type { GpuCaptureRenderer } from './diagnostics'

function createRenderer(timestamps: Map<string, number>, features = true) {
  const inspector = new InspectorBase()
  const backend = {
    trackTimestamp: false,
    getTimestamp: (uid: string) => timestamps.get(uid) ?? null,
    hasTimestampQuery: (uid: string) => timestamps.has(uid),
  }
  const renderer: GpuCaptureRenderer = {
    backend,
    inspector,
    hasFeature: () => features,
    resolveTimestampsAsync: () => Promise.resolve(undefined),
  }
  return { renderer, inspector, backend }
}

function renderInto(inspector: InspectorBase, uid: string) {
  inspector.beginRender(uid, new Scene(), new PerspectiveCamera(), new RenderTarget(1, 1))
}

it('records cpu samples without gpu attribution when no renderer is given', () => {
  const diagnostics = new SceneRenderDiagnostics()
  diagnostics.start()
  const frame = diagnostics.frameStart(100)
  const pass = diagnostics.begin('main', 3)
  diagnostics.end(pass, 9)
  diagnostics.frameEnd(frame)
  const capture = diagnostics.stop()
  expect(capture?.gpuAvailable).toBe(false)
  const sample = required(required(capture?.passes['main'])[0])
  expect(sample.renderCalls).toBe(6)
  expect(sample.gpuMs).toBeNull()
})

it('attributes gpu timestamps to the innermost open pass', async () => {
  const { renderer, inspector } = createRenderer(
    new Map([
      ['u1', 1],
      ['u2', 2],
      ['u3', 4],
    ]),
  )
  const diagnostics = new SceneRenderDiagnostics()
  diagnostics.start(renderer)
  const frame = diagnostics.frameStart(100)
  const main = diagnostics.begin('main', 0)
  renderInto(inspector, 'u1')
  const inner = diagnostics.begin('waterfall', 1)
  renderInto(inspector, 'u2')
  diagnostics.end(inner, 3)
  renderInto(inspector, 'u3')
  diagnostics.end(main, 5)
  diagnostics.frameEnd(frame)
  diagnostics.stop()
  const capture = await diagnostics.resolveGpu()
  expect(capture?.gpuAvailable).toBe(true)
  expect(required(required(capture?.passes['main'])[0]).gpuMs).toBe(5)
  expect(required(required(capture?.passes['waterfall'])[0]).gpuMs).toBe(2)
})

it('restores timestamp tracking and unwraps hooks after the gpu resolve', async () => {
  const { renderer, inspector, backend } = createRenderer(new Map([['u1', 3]]))
  const diagnostics = new SceneRenderDiagnostics()
  diagnostics.start(renderer)
  expect(backend.trackTimestamp).toBe(true)
  diagnostics.stop()
  await diagnostics.resolveGpu()
  expect(backend.trackTimestamp).toBe(false)
  diagnostics.start(renderer)
  const frame = diagnostics.frameStart(100)
  const pass = diagnostics.begin('main', 0)
  renderInto(inspector, 'u1')
  diagnostics.end(pass, 2)
  diagnostics.frameEnd(frame)
  diagnostics.stop()
  const capture = await diagnostics.resolveGpu()
  expect(required(required(capture?.passes['main'])[0]).gpuMs).toBe(3)
})

it('leaves gpu samples empty when the timestamp feature is unavailable', async () => {
  const { renderer, inspector, backend } = createRenderer(new Map([['u1', 1]]), false)
  const diagnostics = new SceneRenderDiagnostics()
  diagnostics.start(renderer)
  const frame = diagnostics.frameStart(100)
  const pass = diagnostics.begin('main', 0)
  renderInto(inspector, 'u1')
  diagnostics.end(pass, 2)
  diagnostics.frameEnd(frame)
  diagnostics.stop()
  const capture = await diagnostics.resolveGpu()
  expect(capture?.gpuAvailable).toBe(false)
  expect(required(required(capture?.passes['main'])[0]).gpuMs).toBeNull()
  expect(backend.trackTimestamp).toBe(false)
})

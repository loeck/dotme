import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { RenderDiagnostics } from './render-diagnostics'
function fixture() {
  const info = {
    autoReset: true,
    render: { calls: 0, drawCalls: 0, triangles: 0 },
    memory: { geometries: 3, textures: 4, programs: 5 },
    reset() {
      this.render.calls = this.render.drawCalls = this.render.triangles = 0
    },
  }
  return { info, diagnostics: new RenderDiagnostics({ info }) }
}
describe('renderer diagnostics', () => {
  it('splits nested submissions without double counting and restores renderer ownership', () => {
    const { diagnostics: d, info } = fixture()
    d.begin(100)
    d.measure('main', () => {
      info.render.drawCalls++
      info.render.triangles += 10
      d.measure('reflection', () => {
        info.render.drawCalls++
        info.render.triangles += 20
      })
      info.render.drawCalls++
      info.render.triangles += 30
    })
    d.end()
    const frame = required(d.snapshot().frames[0])
    expect(frame.passes.main).toMatchObject({ calls: 2, triangles: 40, gpuMs: null })
    expect(frame.passes.reflection).toMatchObject({ calls: 1, triangles: 20, gpuMs: null })
    expect(frame.resources).toEqual({ geometries: 3, textures: 4, programs: 5 })
    d.dispose()
    expect(info.autoReset).toBe(true)
  })
  it('returns isolated snapshots and balances failed submissions', () => {
    const { diagnostics: d } = fixture()
    d.begin(0)
    expect(() =>
      d.measure('failed', () => {
        throw new Error('failure')
      }),
    ).toThrow('failure')
    d.end()
    const snapshot = d.snapshot()
    d.begin(16)
    d.end()
    expect(snapshot.frames).toHaveLength(1)
    expect(d.snapshot().frames).toHaveLength(2)
    d.dispose()
    expect(d.snapshot().frames).toEqual([])
  })
})

import type { WebGLRenderer } from 'three'
import { describe, expect, it } from 'vitest'

import { RenderDiagnostics } from './render-diagnostics'

function fixture() {
  let active = false,
    deleted = 0,
    disjoint = false,
    available = false
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
    createQuery: () => ({}),
    isContextLost: () => false,
    beginQuery: () => {
      if (active) throw new Error('Nested GPU query')
      active = true
    },
    endQuery: () => {
      if (!active) throw new Error('Unbalanced query')
      active = false
    },
    getParameter: () => disjoint,
    getQueryParameter: (_query: unknown, name: number) => (name === 1 ? available : 1_000_000),
    deleteQuery: () => {
      deleted++
    },
  }
  const info = {
    autoReset: true,
    render: { calls: 0, triangles: 0 },
    memory: { geometries: 3, textures: 4 },
    programs: [],
    reset() {
      this.render.calls = this.render.triangles = 0
    },
  }
  const diagnostics = new RenderDiagnostics({
    getContext: () => gl,
    info,
  } as unknown as WebGLRenderer)
  return {
    diagnostics,
    info,
    available: () => {
      available = true
    },
    disjoint: () => {
      disjoint = true
    },
    deleted: () => deleted,
  }
}

describe('asynchronous render diagnostics', () => {
  it('splits nested passes without overlapping timers or double-counting draws', () => {
    const { diagnostics: d, info, available, deleted } = fixture()
    d.begin(100)
    d.measure('main', () => {
      info.render.calls++
      info.render.triangles += 10
      d.measure('reflection', () => {
        info.render.calls++
        info.render.triangles += 20
      })
      info.render.calls++
      info.render.triangles += 30
    })
    d.end()
    expect(d.snapshot().frames[0]!.passes.main!.gpuMs).toBeNull()
    available()
    const frame = d.snapshot().frames[0]!
    expect(frame.passes.main).toMatchObject({ calls: 2, triangles: 40, gpuMs: 2 })
    expect(frame.passes.reflection).toMatchObject({ calls: 1, triangles: 20, gpuMs: 1 })
    expect(deleted()).toBe(3)
    d.dispose()
    expect(info.autoReset).toBe(true)
  })
  it('discards disjoint queries and releases outstanding queries on disposal', () => {
    const { diagnostics: d, disjoint, deleted } = fixture()
    d.begin(0)
    d.measure('clouds', () => {})
    d.end()
    disjoint()
    expect(d.snapshot().frames[0]!.passes.clouds!.gpuMs).toBeNull()
    expect(deleted()).toBe(1)
    d.dispose()
    const pending = fixture()
    pending.diagnostics.begin(0)
    pending.diagnostics.measure('water', () => {})
    pending.diagnostics.end()
    pending.diagnostics.dispose()
    expect(pending.deleted()).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'

import { createFlowGraphData } from './flow-graph'

function containsPoint(data: ReturnType<typeof createFlowGraphData>, x: number, y: number) {
  for (let index = 0; index < data.count; index += 1) {
    const offset = index * 3
    const pointX = data.position[offset]!
    const pointY = data.position[offset + 1]!
    if (Math.hypot(pointX - x, pointY - y) < 0.065) return true
  }
  return false
}

describe('flow graph', () => {
  it('creates deterministic paired line segments with complete attributes', () => {
    const first = createFlowGraphData('desktop')
    const second = createFlowGraphData('desktop')

    expect(first.count).toBeGreaterThan(2_000)
    expect(first.count % 2).toBe(0)
    expect(first.position.length).toBe(first.count * 3)
    expect(first.normal.length).toBe(first.count * 2)
    expect(first.progress.length).toBe(first.count)
    expect(first.reveal.length).toBe(first.count)
    expect(first.alpha.length).toBe(first.count)
    expect(first.layer.length).toBe(first.count)
    expect(first.seed.length).toBe(first.count)
    expect(Array.from(first.position)).toEqual(Array.from(second.position))
  })

  it('routes the desktop network through both configured convergence regions', () => {
    const graph = createFlowGraphData('desktop')

    expect(containsPoint(graph, 0.46, 0.62)).toBe(true)
    expect(containsPoint(graph, 0.72, 0.335)).toBe(true)
  })

  it('keeps the mobile graph out of the upper-left text area', () => {
    const graph = createFlowGraphData('mobile')
    for (let index = 0; index < graph.count; index += 1) {
      const offset = index * 3
      const x = graph.position[offset]!
      const y = graph.position[offset + 1]!
      expect(x < 0.34 && y < 0.44).toBe(false)
    }
  })
})

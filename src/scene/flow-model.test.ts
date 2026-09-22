import { describe, expect, it } from 'vitest'

import { FLOW_BREAKS, FLOW_PATHS, FLOW_QUALITY, nearestPathProgress, pathPoint } from './flow-model'

describe('flow model', () => {
  it('starts and ends on the configured control points', () => {
    expect(pathPoint(FLOW_PATHS.desktop, 0)).toEqual(FLOW_PATHS.desktop[0].start)
    expect(pathPoint(FLOW_PATHS.desktop, 1)).toEqual(FLOW_PATHS.desktop[2].end)
  })

  it('passes exactly through both convergence nodes', () => {
    expect(pathPoint(FLOW_PATHS.desktop, FLOW_BREAKS[0])).toEqual(FLOW_PATHS.desktop[0].end)
    expect(pathPoint(FLOW_PATHS.desktop, FLOW_BREAKS[1])).toEqual(FLOW_PATHS.desktop[1].end)
  })

  it('ships the intended mobile quality budget', () => {
    expect(FLOW_QUALITY.mobile).toMatchObject({
      filaments: 24,
      maxPixelRatio: 1.25,
      particles: 160,
      segments: 96,
    })
  })

  it('finds the closest progress on the flow path', () => {
    const point = pathPoint(FLOW_PATHS.desktop, 0.7)
    expect(nearestPathProgress(FLOW_PATHS.desktop, point, 16 / 9)).toBeCloseTo(0.7, 1)
  })
})

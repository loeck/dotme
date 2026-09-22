import { describe, expect, it } from 'vitest'

import { FLOW_CURVES, FLOW_QUALITY, cubicPoint, filamentPath } from './flow-model'

describe('flow model', () => {
  it('keeps the shared curve deterministic', () => {
    expect(filamentPath('desktop', 0.25, 1.5)).toBe(filamentPath('desktop', 0.25, 1.5))
  })

  it('starts and ends on the configured control points', () => {
    expect(cubicPoint(FLOW_CURVES.desktop, 0)).toEqual(FLOW_CURVES.desktop.start)
    expect(cubicPoint(FLOW_CURVES.desktop, 1)).toEqual(FLOW_CURVES.desktop.end)
  })

  it('ships the intended mobile quality budget', () => {
    expect(FLOW_QUALITY.mobile).toMatchObject({
      filaments: 32,
      maxPixelRatio: 1.25,
      particles: 160,
      segments: 96,
    })
  })
})

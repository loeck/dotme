import { describe, expect, it } from 'vitest'

import { sampleWaterfallHit, seesWorld } from './cursor-world'

const fall = { x: -20, z: -22, top: 6, width: 2, direction: [1, 0] as const }

describe('waterfall cursor hit', () => {
  it('hits the curved sheet inside its bounds', () => {
    const hit = sampleWaterfallHit({ x: -10, y: 3, z: -22 }, { x: -1, y: 0, z: 0 }, fall, 0)
    expect(hit).not.toBeNull()
    expect(hit?.across).toBeCloseTo(0, 6)
    expect(hit?.height).toBeCloseTo(3, 6)
    expect(hit?.distance).toBeCloseTo(9.05062883, 6)
    expect(hit?.strength).toBe(1)
  })

  it('rejects rays parallel to the curtain or pointing away', () => {
    expect(sampleWaterfallHit({ x: -10, y: 3, z: -22 }, { x: 1, y: 0, z: 0 }, fall, 0)).toBeNull()
    expect(sampleWaterfallHit({ x: -10, y: 3, z: -22 }, { x: 0, y: 0, z: -1 }, fall, 0)).toBeNull()
  })

  it('rejects hits outside the curtain and feathers its edges', () => {
    expect(sampleWaterfallHit({ x: -10, y: 3, z: -20 }, { x: -1, y: 0, z: 0 }, fall, 0)).toBeNull()
    expect(sampleWaterfallHit({ x: -10, y: 9, z: -22 }, { x: -1, y: 0, z: 0 }, fall, 0)).toBeNull()
    const edge = sampleWaterfallHit({ x: -10, y: 3, z: -22.96 }, { x: -1, y: 0, z: 0 }, fall, 0)
    expect(edge?.strength).toBe(1)
    const fringe = sampleWaterfallHit({ x: -10, y: 3, z: -23.1 }, { x: -1, y: 0, z: 0 }, fall, 0)
    expect(fringe?.strength).toBeGreaterThan(0)
    expect(fringe?.strength).toBeLessThan(1)
    expect(
      sampleWaterfallHit({ x: -10, y: 3, z: -23.2 }, { x: -1, y: 0, z: 0 }, fall, 0),
    ).toBeNull()
  })
})

const overlayElement = (captured: boolean) => ({
  closest: (selectors: string) => {
    expect(selectors).toContain('a[href]')
    expect(selectors).toContain('dialog')
    return captured ? {} : null
  },
})

describe('overlay hit-testing', () => {
  it('sees the world through plain elements but not through controls', () => {
    expect(seesWorld(overlayElement(false))).toBe(true)
    expect(seesWorld(overlayElement(true))).toBe(false)
    expect(seesWorld(null)).toBe(false)
    expect(seesWorld({})).toBe(false)
  })
})

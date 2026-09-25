import { describe, expect, it } from 'vitest'

import { CursorTrail, SKY_HOLE_LIFETIME, sampleWaterfallHit, seesWorld } from './cursor-world'

const fall = { x: -20, z: -22, top: 6, width: 2, direction: [1, 0] as const }

describe('waterfall cursor hit', () => {
  it('hits the curtain plane inside its bounds', () => {
    const hit = sampleWaterfallHit({ x: -10, y: 3, z: -22 }, { x: -1, y: 0, z: 0 }, fall, 0)
    expect(hit).not.toBeNull()
    expect(hit?.across).toBeCloseTo(0, 6)
    expect(hit?.height).toBeCloseTo(3, 6)
    expect(hit?.distance).toBeCloseTo(10, 6)
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

describe('cursor trail', () => {
  it('recycles the oldest hole and refreshes stacked pushes', () => {
    const trail = new CursorTrail(2)
    expect(trail.push(0, 1, 0, 0)).toBe(true)
    expect(trail.push(0.01, 1, 0, 0.1)).toBe(false)
    expect(trail.push(0.2, 1, 0, 0.2)).toBe(true)
    expect(trail.push(0.4, 1, 0, 0.3)).toBe(true)
    const holes = trail.snapshot(0.3)
    expect(holes).toHaveLength(2)
    expect(holes.map((hole) => hole.x)).toEqual([0.4, 0.2])
    expect(trail.push(0.41, 1, 0, 1)).toBe(false)
    expect(trail.snapshot(1)[0]).toMatchObject({ x: 0.4, born: 1, strength: 1 })
  })

  it('decays holes over their lifetime', () => {
    const trail = new CursorTrail(2)
    trail.push(0, 1, 0, 10)
    const fresh = trail.snapshot(10)
    expect(fresh[0]?.strength).toBeCloseTo(1, 6)
    const old = trail.snapshot(10 + SKY_HOLE_LIFETIME * 6)
    expect(old[0]?.strength).toBeCloseTo(0, 2)
    const aged = trail.snapshot(10 + SKY_HOLE_LIFETIME)
    expect(aged[0]?.strength).toBeCloseTo(Math.exp(-1), 5)
  })
})

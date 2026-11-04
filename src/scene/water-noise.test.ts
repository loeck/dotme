import { describe, expect, it } from 'vitest'

import { loopCells, PATTERN_PERIOD } from './water-noise'

describe('loopCells', () => {
  it('counts the cells a looping rate covers in one pattern period', () => {
    expect(loopCells(0.11)).toBe(66)
    expect(loopCells(1 / 3)).toBe(PATTERN_PERIOD / 3)
  })

  it('rejects a rate whose pattern would jump when the clock wraps', () => {
    expect(() => loopCells(0.32 * 1.1)).toThrow(/does not loop/)
  })
})

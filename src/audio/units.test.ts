import { expect, it } from 'vitest'

import { clampPan, finiteOr, smoothstep, unit } from './units'

it('guards scene values against NaN and range', () => {
  expect(finiteOr(Number.NaN, 2)).toBe(2)
  expect(finiteOr(3, 2)).toBe(3)
  expect(unit(Infinity)).toBe(0)
  expect(unit(2)).toBe(1)
  expect(unit(-1)).toBe(0)
  expect(clampPan(-3)).toBe(-1)
  expect(clampPan(0.9, 0.75)).toBe(0.75)
  expect(clampPan(Number.NaN)).toBe(0)
  expect(smoothstep(8, 12, 10)).toBe(0.5)
  expect(smoothstep(8, 12, 0)).toBe(0)
  expect(smoothstep(8, 12, 20)).toBe(1)
})

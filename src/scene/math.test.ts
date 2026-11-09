import { describe, expect, it } from 'vitest'

import { latticeHash } from './hash'
import { clamp, mix, saturate, smoothstep } from './math'

// Captured from the implementations these helpers replaced (lake-world.ts, vegetation-meshes.ts
// and the engine), before any call site changed: world generation must stay bit-identical.
describe('shared scalar helpers', () => {
  it('reproduce the replaced smoothstep, mix and clamp exactly', () => {
    expect(smoothstep(0.15, 0.7, 0.33)).toBe(0.2512156273478588)
    expect(smoothstep(0, 0.62, 0.1)).toBe(0.06965190829445135)
    expect(smoothstep(4, 9, 7.3)).toBe(0.7318079999999999)
    expect(smoothstep(0.12, 0.55, 1)).toBe(1)
    expect(mix(1, 3.7, 0.31)).toBe(1.8370000000000002)
    expect(mix(-2, 5, 1.7)).toBe(9.9)
    expect(clamp(1.5, 0, 1)).toBe(1)
    expect(clamp(-0.2, 0, 1)).toBe(0)
    expect(clamp(0.3, -1, 1)).toBe(0.3)
    expect(saturate(-0.2)).toBe(0)
    expect(saturate(0.4)).toBe(0.4)
    expect(Number.isNaN(smoothstep(0, 1, Number.NaN))).toBe(true)
  })
})

describe('latticeHash', () => {
  it('reproduces the lake and forest generators’ hash', () => {
    expect(latticeHash(9182, 3, -7, 0)).toBe(0.06987030897289515)
    expect(latticeHash(9182, -120, 44, 5)).toBe(0.5697618830017745)
    expect(latticeHash(1, 0, 0)).toBe(0.40834908187389374)
    expect(latticeHash(0xffffffff, 123456, -654321, 0x51ed270b)).toBe(0.511185749899596)
  })

  it('reproduces the mesh and grass builders’ hash with seed 0, truncating coordinates', () => {
    expect(latticeHash(0, 3, -7, 0)).toBe(0.5721179856918752)
    expect(latticeHash(0, 2.7, -1.2, 11)).toBe(0.4195523962844163)
    expect(latticeHash(0, -99999, 77777, 0x2c1b3c6d)).toBe(0.5920529530849308)
  })
})

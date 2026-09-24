import { describe, expect, it } from 'vitest'

import { updateDetailEnvironment } from './scene-details'

describe('detail environment bridge', () => {
  it('preserves independent solar/rain inputs when either source updates', () => {
    const state = updateDetailEnvironment({ rainIntensity: 0.6, daylight: 0.2 }, { daylight: 0.8 })
    expect(state).toEqual({ rainIntensity: 0.6, daylight: 0.8 })
    expect(updateDetailEnvironment(state, { rainIntensity: 0 })).toEqual({
      rainIntensity: 0,
      daylight: 0.8,
    })
  })

  it('bounds external values and ignores non-finite data', () => {
    const current = { rainIntensity: 0.4, daylight: 0.7 }
    expect(updateDetailEnvironment(current, { rainIntensity: NaN, daylight: Infinity })).toEqual(
      current,
    )
    expect(updateDetailEnvironment(current, { rainIntensity: 3, daylight: -1 })).toEqual({
      rainIntensity: 1,
      daylight: 0,
    })
  })
})

import { expect, it } from 'vitest'

import { coversSky, isWeatherPreset, WEATHER } from './weather'

it('recognises exactly the sky presets, fog and snow included', () => {
  for (const preset of Object.keys(WEATHER)) expect(isWeatherPreset(preset)).toBe(true)
  for (const value of ['invalid', 'rain', 'thunderstorm', 'toString', '', null, undefined])
    expect(isWeatherPreset(value)).toBe(false)
  expect(isWeatherPreset('fog')).toBe(true)
  expect(isWeatherPreset('snow')).toBe(true)
})

it('gives snow the overcast deck and fog a thin one over the thickest air', () => {
  expect(WEATHER.snow.coverage).toBe(WEATHER.overcast.coverage)
  expect(WEATHER.fog.coverage).toBeLessThan(WEATHER.cloudy.coverage)
  for (const preset of ['fog', 'snow'] as const) expect(coversSky(preset)).toBe(true)
  expect(WEATHER.fog.extinction).toBeGreaterThan(WEATHER.overcast.extinction)
  expect(WEATHER.fog.diffuse).toBeLessThan(WEATHER.cloudy.diffuse)
  expect(coversSky('clear')).toBe(false)
  expect(coversSky('partly-cloudy')).toBe(false)
  expect(coversSky('cloudy')).toBe(true)
})

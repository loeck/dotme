export type WeatherPreset = 'clear' | 'partly-cloudy' | 'cloudy' | 'overcast'

// Morphology and air are independent: an opaque cloud bank need not create shafts.
export const WEATHER = {
  clear: { coverage: 0, density: 0, bodyScale: 1, extinction: 0.0012, diffuse: 1 },
  'partly-cloudy': { coverage: 0, density: 2.2, bodyScale: 1, extinction: 0.0025, diffuse: 0.9 },
  cloudy: { coverage: 0.16, density: 2.5, bodyScale: 1.35, extinction: 0.003, diffuse: 0.75 },
  overcast: { coverage: 0.35, density: 2.0, bodyScale: 1.8, extinction: 0.0035, diffuse: 0.65 },
} as const

export function parseWeather(value: string | null): WeatherPreset {
  return value === 'clear' ||
    value === 'partly-cloudy' ||
    value === 'cloudy' ||
    value === 'overcast'
    ? value
    : 'partly-cloudy'
}

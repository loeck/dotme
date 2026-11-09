// Morphology and air are independent: an opaque cloud bank need not create shafts.
export const WEATHER = {
  clear: { coverage: 0, density: 0, bodyScale: 1, extinction: 0.0012, diffuse: 1 },
  // Fair-weather cumulus: separate, mid-sized clouds over a clear blue sky.
  'partly-cloudy': { coverage: 0, density: 2.2, bodyScale: 0.8, extinction: 0.0022, diffuse: 0.9 },
  cloudy: { coverage: 0.16, density: 2.5, bodyScale: 1.35, extinction: 0.003, diffuse: 0.75 },
  overcast: { coverage: 0.35, density: 2.0, bodyScale: 1.8, extinction: 0.0035, diffuse: 0.65 },
  // Ground fog lies under a thin, broken deck, so a pale sun can show through it; its own banks
  // and veil are drawn by the air (`volumetric-light.ts`). Snow keeps the overcast deck.
  fog: { coverage: 0.08, density: 1.6, bodyScale: 1.7, extinction: 0.0045, diffuse: 0.72 },
  snow: { coverage: 0.35, density: 2.0, bodyScale: 1.8, extinction: 0.0035, diffuse: 0.65 },
} as const

export type WeatherPreset = keyof typeof WEATHER

export function isWeatherPreset(value: string | null | undefined): value is WeatherPreset {
  return typeof value === 'string' && Object.hasOwn(WEATHER, value)
}

/** A full cloud deck: no stars, shooting stars or wishes behind it. */
export function coversSky(weather: WeatherPreset) {
  return weather !== 'clear' && weather !== 'partly-cloudy'
}

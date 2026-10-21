import { required } from './invariant'
export type GpsPosition = Readonly<{ latitude: number; longitude: number }>
export const PARIS: GpsPosition = { latitude: 48.8566, longitude: 2.3522 }
export const MIN_TIME_SCALE = 1
export const MAX_TIME_SCALE = 100
const KEYS = new Set(['seed', 'coordinates', 'startTime', 'timeScale'])
// Diagnostics survive reloads on a phone but are not part of the public scene API.
const DEBUG_KEYS = new Set(['perf', 'dpr', 'wx'])

/** The complete public URL API. Missing/invalid values use the scene defaults. */
export function sceneParams(search: string) {
  const params = new URLSearchParams(search)
  const rawSeed = params.get('seed') ?? ''
  const seed =
    /^(?:0|[1-9]\d{0,9})$/.test(rawSeed) && Number(rawSeed) <= 0xffff_ffff
      ? Number(rawSeed)
      : undefined
  const rawGps = params.get('coordinates') ?? ''
  let position = PARIS
  if (/^[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?$/.test(rawGps)) {
    const [latitude, longitude] = rawGps.split(',').map(Number)
    if (Math.abs(required(latitude)) <= 90 && Math.abs(required(longitude)) <= 180)
      position = { latitude: required(latitude), longitude: required(longitude) }
  }
  const rawTime = params.get('startTime') ?? ''
  const startTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : undefined
  const rawScale = Number(params.get('timeScale') ?? 1)
  const timeScale = Number.isFinite(rawScale)
    ? Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, rawScale))
    : 1
  return { seed, position, startTime, timeScale }
}

export function cleanSceneUrl(url: URL) {
  // Existing shared links keep their location/hour but expose only canonical keys.
  for (const [oldKey, key] of [
    ['gps', 'coordinates'],
    ['time', 'startTime'],
  ] as const) {
    if (!url.searchParams.has(key) && url.searchParams.has(oldKey))
      url.searchParams.set(key, required(url.searchParams.get(oldKey)))
  }
  const obsolete = [...url.searchParams.keys()].filter(
    (key) => !KEYS.has(key) && !DEBUG_KEYS.has(key),
  )
  for (const key of obsolete) url.searchParams.delete(key)
  return url
}

/** `?perf` shows per-pass timings on the device (`perf=split` prices scene groups); `dpr` overrides the pixel-ratio cap. */
export function debugParams(search: string) {
  const params = new URLSearchParams(search)
  const rawRatio = Number(params.get('dpr') ?? Number.NaN)
  const pixelRatio =
    Number.isFinite(rawRatio) && rawRatio > 0 ? Math.min(3, Math.max(0.25, rawRatio)) : undefined
  const raw = params.get('perf')
  const mode: 'live' | 'split' | 'water' = raw === 'split' || raw === 'water' ? raw : 'live'
  const perf = params.has('perf') ? mode : null
  return { perf, pixelRatio }
}

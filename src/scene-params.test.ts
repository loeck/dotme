import { describe, expect, it } from 'vitest'

import { cleanSceneUrl, PARIS, sceneParams } from './scene-params'

describe('public scene URLs', () => {
  it('bounds the solar speed and rejects non-finite input', () => {
    for (const timeScale of [1, 2, 10, 20, 100])
      expect(sceneParams(`?timeScale=${timeScale}`).timeScale).toBe(timeScale)
    expect(sceneParams('?timeScale=1000').timeScale).toBe(100)
    expect(sceneParams('?timeScale=-5').timeScale).toBe(1)
    for (const value of ['', 'Infinity', 'NaN', 'fast'])
      expect(sceneParams(`?timeScale=${value}`).timeScale).toBe(1)
  })
  it('migrates old shared links without overriding explicit canonical values', () => {
    const url = cleanSceneUrl(
      new URL('https://example.com/?gps=25.2048,55.2708&time=08:00&timeScale=20'),
    )
    expect(url.searchParams.get('coordinates')).toBe('25.2048,55.2708')
    expect(url.searchParams.get('startTime')).toBe('08:00')
    expect(url.searchParams.has('gps')).toBe(false)
    expect(url.searchParams.has('time')).toBe(false)
    const explicit = cleanSceneUrl(
      new URL('https://example.com/?gps=1,2&coordinates=3,4&time=08:00&startTime=12:00'),
    )
    expect(sceneParams(explicit.search).position).toEqual({ latitude: 3, longitude: 4 })
    expect(sceneParams(explicit.search).startTime).toBe('12:00')
  })
  it('accepts seed zero, GPS coordinates in either hemisphere and a 24-hour clock', () => {
    expect(sceneParams('?seed=0&coordinates=-33.8688,151.2093&startTime=23:59')).toEqual({
      seed: 0,
      position: { latitude: -33.8688, longitude: 151.2093 },
      timeScale: 1,
      startTime: '23:59',
    })
    expect(sceneParams('?seed=4294967295&coordinates=0,0&startTime=00:00')).toEqual({
      seed: 4294967295,
      position: { latitude: 0, longitude: 0 },
      timeScale: 1,
      startTime: '00:00',
    })
  })
  it('falls back safely for malformed or out-of-range coordinates, seeds and hours', () => {
    for (const gps of ['91,0', '0,181', 'NaN,0', '1,', ',2', '1,2,3', ''])
      expect(sceneParams(`?coordinates=${gps}`).position).toEqual(PARIS)
    for (const seed of ['-1', '1.5', '4294967296', 'abc', ''])
      expect(sceneParams(`?seed=${seed}`).seed).toBeUndefined()
    for (const time of ['24:00', '12:60', '1:30', 'invalid', ''])
      expect(sceneParams(`?startTime=${time}`).startTime).toBeUndefined()
  })
  it('removes retired controls while preserving the four supported parameters and fragments', () => {
    const url = cleanSceneUrl(
      new URL(
        'https://example.com/?seed=42&coordinates=1,2&startTime=12:00&timeScale=20&weather=clear&rain=off&sun=hidden&windX=2&loader=loop#about',
      ),
    )
    expect([...url.searchParams.keys()]).toEqual(['seed', 'coordinates', 'startTime', 'timeScale'])
    expect(url.hash).toBe('#about')
  })
})

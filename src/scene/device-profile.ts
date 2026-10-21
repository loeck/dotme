import { debugParams } from '../scene-params'

/** Touch-first devices get the reduced GPU budget whatever their orientation. */
export function isLowPowerDevice(width = window.innerWidth) {
  return width < 768 || window.matchMedia('(pointer: coarse)').matches
}

export function maxPixelRatio(lowPower: boolean) {
  const cap = debugParams(location.search).pixelRatio ?? (lowPower ? 1.25 : 1.75)
  return Math.min(window.devicePixelRatio || 1, cap)
}

export const LOW_POWER_FPS = 30

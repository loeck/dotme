/** Touch-first devices get the reduced GPU budget whatever their orientation. */
export function isLowPowerDevice(width = window.innerWidth) {
  return width < 768 || window.matchMedia('(pointer: coarse)').matches
}

export function maxPixelRatio(lowPower: boolean) {
  return Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 1.75)
}

export const LOW_POWER_FPS = 30

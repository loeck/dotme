import { debugParams } from '../scene-params'

/** Touch-first devices get the reduced GPU budget whatever their orientation. */
export function isLowPowerDevice(width = window.innerWidth) {
  return width < 768 || window.matchMedia('(pointer: coarse)').matches
}

/**
 * Drawing-buffer pixels the scene may fill: past this, a larger or denser screen only gets a
 * lower pixel ratio. Desktop at 1.75 × 1280×720 is 2.8 MP; a 1440p window at ratio 1 is 3.7 MP.
 */
export const PIXEL_BUDGET = { desktop: 2_200_000, lowPower: 1_200_000 } as const

/** Pixel ratio for a viewport: the device ratio, capped per profile and by the pixel budget. */
export function pixelRatioFor(
  options: Readonly<{
    lowPower: boolean
    devicePixelRatio: number
    width: number
    height: number
    /** `?dpr=` debug override: replaces both caps, still bounded by the device. */
    override?: number | undefined
  }>,
) {
  const device = options.devicePixelRatio > 0 ? options.devicePixelRatio : 1
  if (options.override !== undefined) return Math.min(device, options.override)
  const budget = options.lowPower ? PIXEL_BUDGET.lowPower : PIXEL_BUDGET.desktop
  const area = Math.max(1, options.width) * Math.max(1, options.height)
  return Math.min(device, options.lowPower ? 1.25 : 1.75, Math.sqrt(budget / area))
}

export function maxPixelRatio(
  lowPower: boolean,
  width = window.innerWidth,
  height = window.innerHeight,
) {
  return pixelRatioFor({
    lowPower,
    devicePixelRatio: window.devicePixelRatio,
    width,
    height,
    override: debugParams(location.search).pixelRatio,
  })
}

export const LOW_POWER_FPS = 30

import { debugParams } from '../scene-params'

/** Touch-first devices get the reduced GPU budget whatever their orientation. */
export function isLowPowerDevice(width = window.innerWidth) {
  return width < 768 || window.matchMedia('(pointer: coarse)').matches
}

/**
 * Pixels the scene's own targets may fill: past this, a larger or denser screen renders the
 * scene at a lower resolution, which the lens upsamples. The canvas itself, where the profile
 * text and icons are drawn, keeps the display's ratio (`canvasPixelRatio`), so they stay sharp.
 */
export const PIXEL_BUDGET = { desktop: 2_200_000, lowPower: 1_200_000 } as const

/** Scene pixel ratio for a viewport: the device ratio, capped per profile and by the budget. */
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

/** Canvas pixel ratio: the device ratio capped per profile, without the pixel budget. */
export function canvasPixelRatio(lowPower: boolean) {
  return pixelRatioFor({
    lowPower,
    devicePixelRatio: window.devicePixelRatio,
    width: 1,
    height: 1,
    override: debugParams(location.search).pixelRatio,
  })
}

/**
 * Share of the canvas resolution the scene renders at under the pixel budget (at most 1). The
 * dynamic render scale multiplies it.
 */
export function budgetScale(
  lowPower: boolean,
  width = window.innerWidth,
  height = window.innerHeight,
) {
  const scene = pixelRatioFor({
    lowPower,
    devicePixelRatio: window.devicePixelRatio,
    width,
    height,
    override: debugParams(location.search).pixelRatio,
  })
  return Math.min(1, scene / canvasPixelRatio(lowPower))
}

export const LOW_POWER_FPS = 30

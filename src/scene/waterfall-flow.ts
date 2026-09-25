/** The centre of the falling sheet follows the parcels' initial forward speed. */
export const WATERFALL_LIP_Z = 0.05
export const WATERFALL_EXIT_DRIFT = 1.15

export function waterfallDrift(top: number, height: number) {
  return WATERFALL_LIP_Z + WATERFALL_EXIT_DRIFT * Math.sqrt((2 * Math.max(0, top - height)) / 9.81)
}

/** Small numeric guards shared by the audio modules: every input from the scene may be NaN. */

/** `value` when finite, otherwise `fallback`. */
export const finiteOr = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback

/** Clamped to 0–1; non-finite values count as 0. */
export const unit = (value: number) => Math.max(0, Math.min(1, finiteOr(value, 0)))

/** A stereo position within ±`limit`; non-finite values sit in the centre. */
export const clampPan = (value: number, limit = 1) =>
  Math.max(-limit, Math.min(limit, finiteOr(value, 0)))

/** Hermite smoothstep from 0 at `edge0` to 1 at `edge1`. */
export function smoothstep(edge0: number, edge1: number, value: number) {
  const t = unit((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

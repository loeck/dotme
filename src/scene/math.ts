/**
 * Scalar helpers shared by world generation and the frame loop. World generation is
 * deterministic per seed: these keep the exact operation order of the copies they replace, so
 * every call site computes bit-identical doubles. Non-finite input passes through (NaN stays NaN).
 */

/** `value` limited to [min, max]. */
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

/** `value` limited to [0, 1]. */
export const saturate = (value: number) => Math.max(0, Math.min(1, value))

/** `value` limited to [0, 1], with non-finite or missing input read as 0 (for reported data). */
export const finiteUnit = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? saturate(value) : 0

/** Linear interpolation from `a` (t = 0) to `b` (t = 1); not clamped. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t

/** Hermite step from 0 at `edge0` to 1 at `edge1`, as GLSL's `smoothstep`. */
export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = saturate((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

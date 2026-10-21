import type { SceneRenderCapture } from './diagnostics'

// Shared by the on-device panel and the benchmark so both report the same numbers.
// Type-only imports keep this loadable by the benchmark under plain Node.

export const quantile = (values: readonly number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * q)] ?? 0

/** Alternate-frame passes are averaged over every frame, not over the frames they ran. */
export const perFrame = (capture: SceneRenderCapture, total: number) =>
  total / Math.max(1, capture.frameCpuMs.length)

export const targetsPerFrame = (capture: SceneRenderCapture) =>
  Object.fromEntries(
    Object.entries(capture.targets).map(([name, total]) => [name, perFrame(capture, total)]),
  )

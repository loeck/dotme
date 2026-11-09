/** Browser environment guards shared by the page, the scene and the weather. */

/**
 * The page's localStorage, or undefined where there is none (workers, tests) or where reading
 * it throws (blocked storage, some private modes). Callers still guard each read and write.
 */
export function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** The visitor's reduced-motion preference, as a live media query. */
export function reducedMotionQuery(): MediaQueryList {
  return matchMedia('(prefers-reduced-motion: reduce)')
}

import type { StoneTouchdownEvent } from '../scene/VoxelLandscapeEngine'

/** A stone the visitor threw by touch answers in the hand: a short buzz per touchdown. */
export function stoneHaptics(event: StoneTouchdownEvent) {
  if (event.pointerType !== 'touch' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(Math.round(6 + 14 * Math.max(0, Math.min(1, event.energy))))
}

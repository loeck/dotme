import type { ShockwaveEvent, StoneTouchdownEvent } from '../scene/landscape-input'

/** A stone the visitor threw by touch answers in the hand: a short buzz per touchdown. */
export function stoneHaptics(event: StoneTouchdownEvent) {
  if (event.pointerType !== 'touch' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(Math.round(6 + 14 * Math.max(0, Math.min(1, event.energy))))
}

/** A released long press answers with one firmer buzz, longer for a fuller charge. */
export function shockwaveHaptics(event: ShockwaveEvent) {
  if (event.pointerType !== 'touch' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(Math.round(20 + 30 * Math.max(0, Math.min(1, event.charge))))
}

import { reducedMotionQuery } from '../env'
import { CursorMotion } from './cursor-motion'

/**
 * Same rule as the engine's `seesWorld`: only controls and dialogs hide the landscape. Over
 * them the point gives way to the browser's own cursor (index.html scopes the custom one).
 */
const SCENE_BLOCKERS = 'dialog, a[href], button, [role="button"]'
/** Radius of the resting point, in CSS pixels (`.scene-cursor-point`). */
const POINT_RADIUS = 3

const closest = (target: EventTarget | null, selector: string) =>
  target instanceof Element && target.closest(selector) !== null

/**
 * The position is immediate and never eased; only the point's shape trails behind
 * the motion. It exists over the landscape only: controls and the dialog keep native
 * cursors. A press tightens the point and releases a faint echo.
 */
export function initSceneCursor(element: HTMLDivElement): () => void {
  const point = element.querySelector<HTMLElement>('.scene-cursor-point')
  const echo = element.querySelector<HTMLElement>('.scene-cursor-echo')
  if (!point || !echo || typeof element.showPopover !== 'function') return () => {}
  const root = document.documentElement
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
  const reducedMotion = reducedMotionQuery()
  const lifetime = new AbortController()
  const { signal } = lifetime
  const motion = new CursorMotion()
  let frame = 0
  let frameTime = 0
  let echoAnimation: Animation | undefined

  const draw = () => {
    point.style.transform = motion.strain(POINT_RADIUS)
  }
  const tick = (now: number) => {
    frame = 0
    // The first frame after a rest can carry a timestamp from before the waking event (frame
    // callbacks share the frame's start time); step it as one nominal frame instead of none.
    const dt = now - frameTime
    const moving = motion.step(dt > 0 ? dt : 1000 / 60)
    frameTime = now
    draw()
    if (moving) frame = requestAnimationFrame(tick)
  }
  const animate = () => {
    if (frame || reducedMotion.matches) return
    frameTime = performance.now()
    frame = requestAnimationFrame(tick)
  }
  const release = () => {
    delete element.dataset.pressed
  }
  const hide = () => {
    cancelAnimationFrame(frame)
    frame = 0
    motion.reset()
    release()
    echoAnimation?.cancel()
    delete root.dataset.cursorActive
    if (element.matches(':popover-open')) element.hidePopover()
    draw()
  }
  const move = (event: PointerEvent) => {
    if (
      !finePointer.matches ||
      event.pointerType !== 'mouse' ||
      closest(event.target, SCENE_BLOCKERS)
    ) {
      hide()
      return
    }
    const { clientX: x, clientY: y } = event
    // Never interpolate the position or put a transition on this outer element.
    element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
    if (!element.matches(':popover-open')) element.showPopover()
    root.dataset.cursorActive = 'true'
    // A press ending outside the window never reports its pointerup here.
    if (element.dataset.pressed !== undefined && (event.buttons & 1) === 0) release()
    if (reducedMotion.matches) return
    motion.moveTo(x, y)
    animate()
  }
  const press = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || !finePointer.matches) return
    move(event)
    if (!root.dataset.cursorActive) return
    element.dataset.pressed = ''
    if (reducedMotion.matches) return
    echoAnimation?.cancel()
    echoAnimation = echo.animate(
      [
        { opacity: 0.55, scale: 0.15 },
        { opacity: 0, scale: 1 },
      ],
      { duration: 620, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    )
  }
  const lift = (event: PointerEvent) => {
    if (event.button === 0) release()
  }
  // The native dialog takes over the cursor when it opens under a resting mouse.
  const dialog = document.querySelector('.scene-info-dialog')
  const observer = new MutationObserver(() => {
    if (dialog?.hasAttribute('open')) hide()
  })
  if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] })
  window.addEventListener('pointermove', move, { passive: true, signal })
  window.addEventListener('pointerover', move, { passive: true, signal })
  window.addEventListener('pointerdown', press, { passive: true, signal })
  window.addEventListener('pointerup', lift, { passive: true, signal })
  window.addEventListener('pointercancel', hide, { signal })
  window.addEventListener('blur', hide, { signal })
  document.addEventListener('visibilitychange', hide, { signal })
  root.addEventListener('pointerleave', hide, { signal })
  finePointer.addEventListener('change', hide, { signal })
  reducedMotion.addEventListener('change', hide, { signal })
  return () => {
    lifetime.abort()
    observer.disconnect()
    hide()
  }
}

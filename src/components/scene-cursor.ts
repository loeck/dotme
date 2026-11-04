import { CursorMotion } from './cursor-motion'

const CONTROLS = 'a[href], button, [role="button"]'
/** Same rule as the engine's `seesWorld`: only controls and dialogs hide the landscape. */
const SCENE_BLOCKERS = `dialog, ${CONTROLS}`
/** Radius of the resting point, in CSS pixels (`.scene-cursor-point`). */
const POINT_RADIUS = 3
/** Longest drift of the hover ring behind the point, in CSS pixels. */
const RING_LAG = 4

const closest = (target: EventTarget | null, selector: string) =>
  target instanceof Element && target.closest(selector) !== null

/**
 * The position is immediate and never eased; only the point's shape trails behind
 * the motion. Over controls the point opens into a ring, a press tightens it, and a
 * press on the landscape releases a faint echo.
 */
export function initSceneCursor(element: HTMLDivElement): () => void {
  const point = element.querySelector<HTMLElement>('.scene-cursor-point')
  const ring = element.querySelector<HTMLElement>('.scene-cursor-ring')
  const echo = element.querySelector<HTMLElement>('.scene-cursor-echo')
  if (!point || !ring || !echo || typeof element.showPopover !== 'function') return () => {}
  const root = document.documentElement
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const lifetime = new AbortController()
  const { signal } = lifetime
  const motion = new CursorMotion()
  let frame = 0
  let frameTime = 0
  let target: EventTarget | null = null
  let interactive = false
  let echoAnimation: Animation | undefined

  const draw = () => {
    point.style.transform = motion.strain(POINT_RADIUS)
    ring.style.translate = interactive ? motion.lag(RING_LAG) : ''
  }
  const tick = (now: number) => {
    frame = 0
    const moving = motion.step(now - frameTime)
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
    target = null
    interactive = false
    motion.reset()
    release()
    echoAnimation?.cancel()
    delete root.dataset.cursorActive
    delete element.dataset.interactive
    if (element.matches(':popover-open')) element.hidePopover()
    draw()
  }
  const move = (event: PointerEvent) => {
    if (!finePointer.matches || event.pointerType !== 'mouse') {
      hide()
      return
    }
    const { clientX: x, clientY: y } = event
    // Never interpolate the position or put a transition on this outer element.
    element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
    if (!element.matches(':popover-open')) element.showPopover()
    root.dataset.cursorActive = 'true'
    if (event.target !== target) {
      target = event.target
      interactive = closest(target, CONTROLS)
      element.dataset.interactive = String(interactive)
      if (!interactive) ring.style.translate = ''
    }
    // A press ending outside the window never reports its pointerup here.
    if (element.dataset.pressed !== undefined && (event.buttons & 1) === 0) release()
    if (reducedMotion.matches) return
    motion.moveTo(x, y)
    animate()
  }
  const press = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || !finePointer.matches) return
    move(event)
    element.dataset.pressed = ''
    if (reducedMotion.matches || closest(event.target, SCENE_BLOCKERS)) return
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
  // Keep the point above the native dialog when it opens under a resting mouse.
  const observer = new MutationObserver(() => {
    target = null
    if (element.matches(':popover-open')) {
      element.hidePopover()
      element.showPopover()
    }
  })
  const dialog = document.querySelector('.scene-info-dialog')
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

const interactive = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('a[href], button, [role="button"]'))

/** The position is immediate; only the point's shape deforms with pointer speed. */
export function initSceneCursor(element: HTMLDivElement): () => void {
  const shape = element.firstElementChild as HTMLElement | null
  if (!shape || typeof element.showPopover !== 'function') return () => {}
  const root = document.documentElement
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const lifetime = new AbortController()
  const { signal } = lifetime
  let previous: { x: number; y: number; time: number } | undefined
  let releaseTimer = 0

  const relax = () => {
    delete element.dataset.stretched
    shape.style.transform = 'none'
  }
  const hide = () => {
    clearTimeout(releaseTimer)
    previous = undefined
    delete root.dataset.cursorActive
    delete element.dataset.interactive
    if (element.matches(':popover-open')) element.hidePopover()
    relax()
  }
  const move = (event: PointerEvent) => {
    if (!finePointer.matches || event.pointerType !== 'mouse') {
      hide()
      return
    }
    const { clientX: x, clientY: y, timeStamp: time } = event
    // Never interpolate the position or put a transition on this outer element.
    element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
    if (!element.matches(':popover-open')) element.showPopover()
    root.dataset.cursorActive = 'true'
    element.dataset.interactive = String(interactive(event.target))
    // Boundary events can repeat a move at the same position and timestamp.
    // Keep them from resetting the velocity sample or delaying the return to rest.
    if (previous?.x === x && previous.y === y) return
    const last = previous
    previous = { x, y, time }
    if (!last || reducedMotion.matches) return
    const dt = time - last.time
    if (dt <= 0 || dt >= 100) return
    const dx = x - last.x
    const dy = y - last.y
    const distance = Math.hypot(dx, dy)
    const stretch = 1 + 1.8 * (1 - Math.exp(-distance / dt / 0.35))
    const squash = 1 / Math.sqrt(stretch)
    const ux = dx / distance
    const uy = dy / distance
    // Symmetric strain: no rotation flip when the pointer reverses direction.
    const a = stretch * ux * ux + squash * uy * uy
    const b = (stretch - squash) * ux * uy
    const d = stretch * uy * uy + squash * ux * ux
    element.dataset.stretched = ''
    shape.style.transform = `matrix(${a}, ${b}, ${b}, ${d}, 0, 0)`
    clearTimeout(releaseTimer)
    releaseTimer = window.setTimeout(relax, 65)
  }
  // Keep the point above the native dialog when it opens under a resting mouse.
  const observer = new MutationObserver(() => {
    if (element.matches(':popover-open')) {
      element.hidePopover()
      element.showPopover()
    }
  })
  const dialog = document.querySelector('.scene-info-dialog')
  if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] })
  window.addEventListener('pointermove', move, { passive: true, signal })
  window.addEventListener('pointerover', move, { passive: true, signal })
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

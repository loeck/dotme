import type { createCursorSmoke } from '../scene/cursor-smoke'

export function initSceneCursor(element: HTMLDivElement): () => void {
  const host = document.querySelector('main')
  if (!host) return () => {}
  const root = document.documentElement
  const dialog = document.querySelector<HTMLDialogElement>('.scene-info-dialog')
  const supportsPopover = typeof element.showPopover === 'function'
  const smokeCanvas = element.querySelector('canvas')
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let previousX = 0
  let previousY = 0
  let previousTime = 0
  let tiltX = 0
  let tiltY = 0
  let targetX = 0
  let targetY = 0
  let lastFrame = 0
  let visible = false
  const lifetime = new AbortController()
  const { signal } = lifetime
  let smoke: ReturnType<typeof createCursorSmoke> | undefined
  let smokeAttempted = false
  let smokeTime = 0

  const animate = (now: number) => {
    const dt = Math.min((now - lastFrame) / 1000, 0.05)
    lastFrame = now
    smokeTime += dt
    smoke?.render(smokeTime)
    const follow = 1 - Math.exp(-dt * 18)
    tiltX += (targetX - tiltX) * follow
    tiltY += (targetY - tiltY) * follow
    targetX *= Math.exp(-dt * 7)
    targetY *= Math.exp(-dt * 7)
    element.style.setProperty('--cursor-tilt-x', `${tiltX.toFixed(2)}deg`)
    element.style.setProperty('--cursor-tilt-y', `${tiltY.toFixed(2)}deg`)
    frame =
      visible &&
      !reducedMotion.matches &&
      (smoke || Math.abs(tiltX) + Math.abs(tiltY) + Math.abs(targetX) + Math.abs(targetY) > 0.03)
        ? requestAnimationFrame(animate)
        : 0
  }
  const resume = () => {
    if (reducedMotion.matches) smoke?.render(smokeTime)
    else if (!frame) {
      lastFrame = performance.now()
      frame = requestAnimationFrame(animate)
    }
  }
  const hide = () => {
    visible = false
    element.dataset.visible = 'false'
    element.dataset.pressed = 'false'
    delete host.dataset.cursorActive
    delete root.dataset.cursorActive
    cancelAnimationFrame(frame)
    frame = 0
    tiltX = tiltY = targetX = targetY = 0
    element.style.setProperty('--cursor-tilt-x', '0deg')
    element.style.setProperty('--cursor-tilt-y', '0deg')
  }
  // Native dialogs occupy the top layer. Reinsert our non-interactive popover
  // after one opens, so the same cursor stays above the dialog and its backdrop.
  const raise = () => {
    if (!supportsPopover || !visible) return
    if (element.matches(':popover-open')) element.hidePopover()
    element.showPopover()
  }
  const dialogObserver = new MutationObserver(raise)
  if (dialog) dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] })
  const loadSmoke = async (canvas: HTMLCanvasElement) => {
    try {
      // Keep Three.js out of the initial UI bundle and off touch-only devices.
      const { createCursorSmoke } = await import('../scene/cursor-smoke')
      if (signal.aborted) return
      smoke = createCursorSmoke(canvas)
      if (visible) resume()
    } catch {
      // The ring remains usable when WebGL is unavailable.
    }
  }
  const startSmoke = () => {
    if (visible && !smokeAttempted && smokeCanvas && !root.dataset.sceneLoading) {
      smokeAttempted = true
      void loadSmoke(smokeCanvas)
    }
  }
  // A pointer already resting on the loader should gain its smoke as soon as
  // loading ends, without needing a second movement or loading Three.js early.
  const loadingObserver = new MutationObserver(startSmoke)
  loadingObserver.observe(root, { attributes: true, attributeFilter: ['data-scene-loading'] })
  const move = (event: PointerEvent) => {
    if (!supportsPopover || !finePointer.matches || event.pointerType !== 'mouse') {
      hide()
      return
    }
    const bounds = host.getBoundingClientRect()
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      hide()
      return
    }
    // The luminous center stays on the hit point; only the surrounding ring tilts.
    element.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) translate(-50%, -50%)`
    element.dataset.interactive = String(
      event.target instanceof Element &&
        Boolean(event.target.closest('a, button, [role="button"]')),
    )
    if (visible && !reducedMotion.matches) {
      const dt = Math.max(8, Math.min(40, event.timeStamp - previousTime))
      targetX = Math.max(-12, Math.min(12, (-(event.clientY - previousY) * 8) / dt))
      targetY = Math.max(-12, Math.min(12, ((event.clientX - previousX) * 8) / dt))
    }
    previousX = event.clientX
    previousY = event.clientY
    previousTime = event.timeStamp
    visible = true
    if (!element.matches(':popover-open')) element.showPopover()
    element.dataset.visible = 'true'
    host.dataset.cursorActive = 'true'
    root.dataset.cursorActive = 'true'
    startSmoke()
    resume()
  }
  const press = (event: PointerEvent) => {
    if (visible && event.pointerType === 'mouse') element.dataset.pressed = 'true'
  }
  const release = () => {
    element.dataset.pressed = 'false'
  }
  window.addEventListener('pointermove', move, { passive: true, signal })
  window.addEventListener('pointerdown', press, { passive: true, signal })
  window.addEventListener('pointerup', release, { signal })
  window.addEventListener('pointercancel', hide, { signal })
  window.addEventListener('blur', hide, { signal })
  document.addEventListener('visibilitychange', hide, { signal })
  document.documentElement.addEventListener('pointerleave', hide, { signal })
  finePointer.addEventListener('change', hide, { signal })
  reducedMotion.addEventListener('change', hide, { signal })
  return () => {
    lifetime.abort()
    dialogObserver.disconnect()
    loadingObserver.disconnect()
    hide()
    if (supportsPopover && element.matches(':popover-open')) element.hidePopover()
    smoke?.dispose()
    // Disposal loses the WebGL context; a restored page needs a fresh canvas.
    if (smoke && smokeCanvas) smokeCanvas.replaceWith(smokeCanvas.cloneNode())
  }
}

import { useEffect, useRef } from 'react'

import type { createCursorSmoke } from '../scene/cursor-smoke'

export function SceneCursor() {
  const cursor = useRef<HTMLDivElement>(null)
  const smokeCanvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = cursor.current
    const host = element?.closest('main')
    if (!element || !host) return
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
    let lastPointer: PointerEvent | null = null
    const lightsEnabled = () => host.dataset.localLights === 'true'
    let disposed = false
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
      cancelAnimationFrame(frame)
      frame = 0
      tiltX = tiltY = targetX = targetY = 0
      element.style.setProperty('--cursor-tilt-x', '0deg')
      element.style.setProperty('--cursor-tilt-y', '0deg')
    }
    const loadSmoke = async (canvas: HTMLCanvasElement) => {
      try {
        // Keep Three.js out of the initial UI bundle and off touch-only devices.
        const { createCursorSmoke } = await import('../scene/cursor-smoke')
        if (disposed) return
        smoke = createCursorSmoke(canvas)
        if (visible) resume()
      } catch {
        // The ring remains usable when WebGL is unavailable.
      }
    }
    const move = (event: PointerEvent) => {
      lastPointer = event
      if (!finePointer.matches || event.pointerType !== 'mouse') {
        lastPointer = null
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
        lastPointer = null
        hide()
        return
      }
      if (!lightsEnabled()) {
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
      element.dataset.visible = 'true'
      host.dataset.cursorActive = 'true'
      if (!smokeAttempted && smokeCanvas.current) {
        smokeAttempted = true
        void loadSmoke(smokeCanvas.current)
      }
      resume()
    }
    const press = (event: PointerEvent) => {
      if (visible && event.pointerType === 'mouse') element.dataset.pressed = 'true'
    }
    const release = () => {
      element.dataset.pressed = 'false'
    }
    const leave = () => {
      lastPointer = null
      hide()
    }
    const lightingObserver = new MutationObserver(() => {
      if (!lightsEnabled()) hide()
      else if (lastPointer && !document.hidden) move(lastPointer)
    })
    lightingObserver.observe(host, { attributes: true, attributeFilter: ['data-local-lights'] })
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerdown', press, { passive: true })
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', leave)
    window.addEventListener('blur', leave)
    document.addEventListener('visibilitychange', leave)
    document.documentElement.addEventListener('pointerleave', leave)
    finePointer.addEventListener('change', leave)
    reducedMotion.addEventListener('change', leave)
    return () => {
      disposed = true
      lightingObserver.disconnect()
      hide()
      smoke?.dispose()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', leave)
      window.removeEventListener('blur', leave)
      document.removeEventListener('visibilitychange', leave)
      document.documentElement.removeEventListener('pointerleave', leave)
      finePointer.removeEventListener('change', leave)
      reducedMotion.removeEventListener('change', leave)
    }
  }, [])

  return (
    <div ref={cursor} className="scene-cursor" aria-hidden="true">
      <div className="scene-cursor__halo" />
      <canvas ref={smokeCanvas} className="scene-cursor__smoke" />
      <div className="scene-cursor__ring">
        <div className="scene-cursor__glint" />
      </div>
      <div className="scene-cursor__core" />
    </div>
  )
}

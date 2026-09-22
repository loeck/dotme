import { createClientOnlyFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'

import { FlowFallbackSvg } from '../scene/FlowFallbackSvg'
import type { FlowFieldEngine } from '../scene/FlowFieldEngine'

const loadEngine = createClientOnlyFn(async () => {
  const engineModule = await import('../scene/FlowFieldEngine')
  return engineModule.FlowFieldEngine
})

type FlowFieldProps = Readonly<{
  className?: string
  onAvailabilityChange?: (available: boolean) => void
  paused?: boolean
}>

export function FlowField({ className, onAvailabilityChange, paused = false }: FlowFieldProps) {
  const canvasHost = useRef<HTMLDivElement>(null)
  const engine = useRef<FlowFieldEngine | null>(null)
  const pausedRef = useRef(paused)
  const [webglReady, setWebglReady] = useState(false)

  useEffect(() => {
    const host = canvasHost.current
    if (!host) return

    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    const stop = () => {
      resizeObserver?.disconnect()
      resizeObserver = undefined
      engine.current?.dispose()
      engine.current = null
      setWebglReady(false)
    }

    const start = async () => {
      if (disposed || reducedMotion.matches || engine.current) {
        if (reducedMotion.matches) onAvailabilityChange?.(false)
        return
      }
      try {
        const Engine = await loadEngine()
        if (disposed || reducedMotion.matches) return
        const instance = new Engine({
          container: host,
          onContextFailure: () => {
            setWebglReady(false)
            onAvailabilityChange?.(false)
          },
          onFirstFrame: () => {
            setWebglReady(true)
            onAvailabilityChange?.(true)
          },
        })
        engine.current = instance
        instance.setPaused(pausedRef.current)
        resizeObserver = new ResizeObserver(instance.resize)
        resizeObserver.observe(host)
      } catch {
        setWebglReady(false)
        onAvailabilityChange?.(false)
      }
    }

    const updateMotionPreference = () => {
      if (reducedMotion.matches) {
        stop()
        onAvailabilityChange?.(false)
      } else void start()
    }

    reducedMotion.addEventListener('change', updateMotionPreference)
    void start()
    return () => {
      disposed = true
      reducedMotion.removeEventListener('change', updateMotionPreference)
      stop()
    }
  }, [onAvailabilityChange])

  useEffect(() => {
    pausedRef.current = paused
    engine.current?.setPaused(paused)
  }, [paused])

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${className ?? ''}`}
      aria-hidden="true"
    >
      <div
        className={`absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none ${webglReady ? 'opacity-0' : 'opacity-100'}`}
      >
        <FlowFallbackSvg className="flow-fallback" />
      </div>
      <div
        ref={canvasHost}
        className={`pointer-events-auto absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none ${webglReady ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}

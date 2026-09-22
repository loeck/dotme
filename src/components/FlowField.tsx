import { createClientOnlyFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'

import { FlowFallbackSvg } from '../scene/FlowFallbackSvg'
import type { FlowFieldEngine } from '../scene/FlowFieldEngine'
import { SceneControls } from './SceneControls'

const loadEngine = createClientOnlyFn(async () => {
  const engineModule = await import('../scene/FlowFieldEngine')
  return engineModule.FlowFieldEngine
})

export function FlowField() {
  const canvasHost = useRef<HTMLDivElement>(null)
  const engine = useRef<FlowFieldEngine | null>(null)
  const [paused, setPaused] = useState(false)
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
        return
      }
      try {
        const Engine = await loadEngine()
        if (disposed || reducedMotion.matches) return
        const instance = new Engine({
          container: host,
          onContextFailure: () => {
            setWebglReady(false)
          },
          onFirstFrame: () => {
            setWebglReady(true)
          },
        })
        engine.current = instance
        resizeObserver = new ResizeObserver(instance.resize)
        resizeObserver.observe(host)
      } catch {
        setWebglReady(false)
      }
    }

    const updateMotionPreference = () => {
      if (reducedMotion.matches) {
        stop()
      } else void start()
    }

    reducedMotion.addEventListener('change', updateMotionPreference)
    void start()
    return () => {
      disposed = true
      reducedMotion.removeEventListener('change', updateMotionPreference)
      stop()
    }
  }, [])

  useEffect(() => {
    engine.current?.setPaused(paused)
  }, [paused])

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
        <div
          className={`absolute inset-0 transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${webglReady ? 'opacity-0' : 'opacity-100'}`}
        >
          <FlowFallbackSvg />
        </div>
        <div
          ref={canvasHost}
          className={`pointer-events-auto absolute inset-0 transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${webglReady ? 'opacity-100' : 'opacity-0'}`}
        />
      </div>
      <SceneControls
        available={webglReady}
        paused={paused}
        onToggle={() => setPaused((value) => !value)}
      />
    </>
  )
}

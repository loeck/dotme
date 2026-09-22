import { createClientOnlyFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'

import type { FlowFieldEngine } from '../scene/FlowFieldEngine'

const loadEngine = createClientOnlyFn(async () => {
  const engineModule = await import('../scene/FlowFieldEngine')
  return engineModule.FlowFieldEngine
})

export function FlowField() {
  const canvasHost = useRef<HTMLDivElement>(null)
  const engine = useRef<FlowFieldEngine | null>(null)
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

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div className={`absolute inset-0 ${webglReady ? 'opacity-100' : 'opacity-0'}`}>
        <div
          className={`absolute top-[35.5%] left-[71%] size-[22rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,191,0.11)_0%,rgba(14,32,50,0.04)_38%,transparent_72%)] blur-2xl transition-opacity delay-500 duration-1000 ease-out motion-reduce:transition-none max-md:top-[31%] max-md:left-[69%] max-md:size-[16rem] ${webglReady ? 'opacity-100' : 'opacity-0'}`}
        />
        <div
          className={`absolute top-[62%] left-[46%] size-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(91,151,202,0.075)_0%,transparent_70%)] blur-xl transition-opacity delay-300 duration-700 ease-out motion-reduce:transition-none max-md:hidden ${webglReady ? 'opacity-100' : 'opacity-0'}`}
        />
        <div ref={canvasHost} className="pointer-events-auto absolute inset-0" />
      </div>
    </div>
  )
}

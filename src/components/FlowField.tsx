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
          className={`absolute top-[33.5%] left-[73.8%] size-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(174,211,239,0.1)_0%,rgba(41,87,123,0.045)_22%,transparent_70%)] blur-2xl transition-opacity delay-500 duration-1000 ease-out motion-reduce:transition-none max-md:top-[31%] max-md:left-[69%] max-md:size-[16rem] ${webglReady ? 'opacity-100' : 'opacity-0'}`}
        />
        <div
          className={`absolute top-[62%] left-[46%] size-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(190,220,244,0.08)_0%,rgba(35,71,99,0.025)_30%,transparent_72%)] blur-xl transition-opacity delay-300 duration-700 ease-out motion-reduce:transition-none max-md:hidden ${webglReady ? 'opacity-100' : 'opacity-0'}`}
        />
        <div
          className={`absolute top-[40%] right-[-8rem] h-[34rem] w-[54rem] rounded-full bg-[radial-gradient(ellipse,rgba(45,78,105,0.04)_0%,transparent_70%)] blur-3xl transition-opacity delay-700 duration-1000 motion-reduce:transition-none max-md:hidden ${webglReady ? 'opacity-100' : 'opacity-0'}`}
        />
        <div ref={canvasHost} className="pointer-events-auto absolute inset-0" />
        <div className="absolute top-0 left-0 hidden h-[37%] w-[90%] bg-[radial-gradient(ellipse_at_top_left,#080a0d_0%,#080a0d_68%,rgba(8,10,13,0.96)_82%,transparent_100%)] max-md:block" />
      </div>
    </div>
  )
}

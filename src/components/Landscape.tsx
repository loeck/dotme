import { createClientOnlyFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'

import { queryRainState } from '../scene/rain-simulation'
import type { VoxelLandscapeEngine } from '../scene/VoxelLandscapeEngine'

const loadEngine = createClientOnlyFn(async () => {
  const engineModule = await import('../scene/VoxelLandscapeEngine')
  return engineModule.VoxelLandscapeEngine
})

function querySeed(search: string): number | undefined {
  const value = new URLSearchParams(search).get('seed')
  if (!value || !/^(?:0|[1-9]\d{0,9})$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 0xffff_ffff ? parsed >>> 0 : undefined
}

function randomSeed(): number {
  const value = new Uint32Array(1)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(value)
    return value[0]!
  }
  // A fresh tab has distinct time and Math.random entropy even in older non-secure contexts.
  let fallback =
    (Date.now() ^
      Math.floor(performance.now() * 1000) ^
      Math.floor(Math.random() * 0xffff_ffff)) >>>
    0
  fallback = Math.imul(fallback ^ (fallback >>> 16), 0x7feb352d)
  fallback = Math.imul(fallback ^ (fallback >>> 15), 0x846ca68b)
  return (fallback ^ (fallback >>> 16)) >>> 0
}

export function Landscape() {
  const canvasHost = useRef<HTMLDivElement>(null)
  const engine = useRef<VoxelLandscapeEngine | null>(null)
  const seed = useRef<number | undefined>(undefined)
  const [webglReady, setWebglReady] = useState(false)

  useEffect(() => {
    const host = canvasHost.current
    if (!host) return

    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    let startVersion = 0
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (seed.current === undefined) seed.current = querySeed(window.location.search) ?? randomSeed()

    const stop = () => {
      startVersion += 1
      resizeObserver?.disconnect()
      resizeObserver = undefined
      engine.current?.dispose()
      engine.current = null
      setWebglReady(false)
    }

    const start = async () => {
      if (disposed || engine.current) return
      const version = ++startVersion
      try {
        const Engine = await loadEngine()
        if (disposed || engine.current || version !== startVersion) return
        const instance = new Engine({
          container: host,
          onContextFailure: () => {
            setWebglReady(false)
          },
          onFirstFrame: () => {
            setWebglReady(true)
          },
          reducedMotion: reducedMotion.matches,
          seed: seed.current,
          rain: queryRainState(window.location.search),
        })
        engine.current = instance
        resizeObserver = new ResizeObserver(instance.resize)
        resizeObserver.observe(host)
      } catch {
        setWebglReady(false)
      }
    }

    const updateMotionPreference = () => {
      stop()
      void start()
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
      <div
        ref={canvasHost}
        className={`pointer-events-auto absolute inset-0 transition-opacity duration-300 ease-out motion-reduce:transition-none ${webglReady ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}

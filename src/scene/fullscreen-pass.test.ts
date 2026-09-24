import { vec4 } from 'three/tsl'
import {
  LinearSRGBColorSpace,
  NoToneMapping,
  ReinhardToneMapping,
  RenderTarget,
  SRGBColorSpace,
} from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { FullscreenPass } from './fullscreen-pass'
import type { FullscreenRenderer } from './fullscreen-pass'

describe('fullscreen preparation', () => {
  it('restores loader render state before compilation yields, including rejection', async () => {
    const original = new RenderTarget(1, 1)
    const destination = new RenderTarget(2, 2)
    let target: RenderTarget | null = original
    let face = 4
    let mip = 2
    let rejectCompile: ((error: Error) => void) | undefined
    const pending = new Promise<void>((_resolve, reject) => {
      rejectCompile = reject
    })
    const compile = vi.fn<FullscreenRenderer['compileAsync']>(() => {
      expect(target).toBe(destination)
      expect(renderer.toneMapping).toBe(NoToneMapping)
      expect(renderer.outputColorSpace).toBe(LinearSRGBColorSpace)
      expect(renderer.xr.enabled).toBe(false)
      return pending
    })
    const renderer: FullscreenRenderer = {
      toneMapping: ReinhardToneMapping,
      outputColorSpace: SRGBColorSpace,
      xr: { enabled: true },
      getRenderTarget: () => target,
      getActiveCubeFace: () => face,
      getActiveMipmapLevel: () => mip,
      setRenderTarget: (value, cubeFace = 0, mipLevel = 0) => {
        target = value
        face = cubeFace
        mip = mipLevel
      },
      compileAsync: compile,
      render: vi.fn<FullscreenRenderer['render']>(),
    }
    const pass = new FullscreenPass(renderer, vec4(1), true)
    try {
      const compiling = pass.compileAsync(destination)
      expect(compile).toHaveBeenCalledOnce()
      expect(target).toBe(original)
      expect(face).toBe(4)
      expect(mip).toBe(2)
      expect(renderer.toneMapping).toBe(ReinhardToneMapping)
      expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
      expect(renderer.xr.enabled).toBe(true)
      if (!rejectCompile) throw new Error('Compilation did not start')
      rejectCompile(new Error('Compilation cancelled'))
      await expect(compiling).rejects.toThrow('Compilation cancelled')
      expect(target).toBe(original)
    } finally {
      pass.dispose()
      original.dispose()
      destination.dispose()
    }
  })
})

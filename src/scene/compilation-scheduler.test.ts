import { afterEach, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { installCompilationScheduler } from './compilation-scheduler'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('preserves a native scheduler without allocating fallback resources', () => {
  const native = { yield: () => Promise.resolve() }
  const host = { scheduler: native }
  const createChannel = vi.fn<() => void>()
  vi.stubGlobal('MessageChannel', createChannel)
  const dispose = installCompilationScheduler(host)
  expect(host.scheduler).toBe(native)
  dispose()
  expect(host.scheduler.yield).toBe(native.yield)
  expect(createChannel).not.toHaveBeenCalled()
})

it('yields through tasks, gives frames an 8ms budget, and releases pending work on disposal', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const visibility = new EventTarget()
  Object.assign(visibility, { hidden: false })
  vi.stubGlobal('document', visibility)
  const tasks: Array<() => void> = []
  let present: FrameRequestCallback | undefined
  const cancelFrame = vi.fn<(frame: number) => void>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    present = callback
    return 7
  })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  const closeInput = vi.fn<() => void>(),
    closeOutput = vi.fn<() => void>()
  vi.stubGlobal(
    'MessageChannel',
    class {
      private listener: (() => void) | undefined
      readonly port1 = {
        addEventListener: (_event: string, callback: () => void) => {
          this.listener = callback
        },
        removeEventListener: () => {
          this.listener = undefined
        },
        start: () => {},
        close: closeInput,
      }
      readonly port2 = {
        close: closeOutput,
        postMessage: () => {
          tasks.push(() => this.listener?.())
        },
      }
    },
  )
  const postTask = vi.fn<() => void>()
  const host: { scheduler: { postTask: typeof postTask; yield?: () => Promise<void> } } = {
    scheduler: { postTask },
  }
  const dispose = installCompilationScheduler(host)
  const yieldTask = required(host.scheduler.yield)
  let resolved = false
  const first = yieldTask().then(() => {
    resolved = true
    return undefined
  })
  expect(resolved).toBe(false)
  required(tasks.shift())()
  await first
  expect(resolved).toBe(true)
  now = 10
  const second = yieldTask()
  required(tasks.shift())()
  expect(present).toBeDefined()
  required(present)(now)
  await second
  now = 20
  const hidden = yieldTask()
  required(tasks.shift())()
  Object.assign(visibility, { hidden: true })
  visibility.dispatchEvent(new Event('visibilitychange'))
  await hidden
  expect(cancelFrame).toHaveBeenCalledWith(7)
  Object.assign(visibility, { hidden: false })
  now = 30
  const cancelled = yieldTask()
  required(tasks.shift())()
  dispose()
  await cancelled
  expect(cancelFrame).toHaveBeenCalledWith(7)
  expect(closeInput).toHaveBeenCalledOnce()
  expect(closeOutput).toHaveBeenCalledOnce()
  expect(host.scheduler).toEqual({ postTask })
  dispose()
  await yieldTask()
})

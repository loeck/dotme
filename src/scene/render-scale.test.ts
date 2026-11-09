import { describe, expect, it } from 'vitest'

import { PIXEL_BUDGET, pixelRatioFor } from './device-profile'
import { RENDER_SCALE, RenderScaleController } from './render-scale'

const BUDGET = 1000 / 60

/** Feeds frames of `interval` ms (and `cpu` ms of work) for `duration` ms; returns the end time. */
function run(
  controller: RenderScaleController,
  from: number,
  duration: number,
  interval: number,
  cpu = 4,
  changes: number[] = [],
) {
  let now = from
  while (now < from + duration) {
    now += interval
    if (controller.sample(now, interval, cpu)) changes.push(now)
  }
  return now
}

describe('render scale controller', () => {
  it('ignores the intro, then steps down one quantized step per hold', () => {
    const controller = new RenderScaleController(BUDGET)
    const changes: number[] = []
    let now = run(controller, 0, RENDER_SCALE.warmupMs - 100, 40, 4, changes)
    expect(changes).toEqual([])
    expect(controller.scale).toBe(1)
    now = run(controller, now, 20_000, 40, 4, changes)
    expect(controller.scale).toBe(RENDER_SCALE.steps[0])
    for (let i = 1; i < changes.length; i++)
      expect((changes[i] ?? 0) - (changes[i - 1] ?? 0)).toBeGreaterThanOrEqual(RENDER_SCALE.holdMs)
    expect(RENDER_SCALE.steps.some((step) => step === controller.scale)).toBe(true)
  })

  it('holds the scale for frames within budget and for occasional late frames', () => {
    const controller = new RenderScaleController(BUDGET)
    let now = run(controller, 0, 30_000, BUDGET)
    expect(controller.scale).toBe(1)
    // One late frame in twenty stays under the 90th percentile.
    for (let i = 0; i < 2000; i++) {
      const interval = i % 20 === 0 ? 2 * BUDGET : BUDGET
      now += interval
      expect(controller.sample(now, interval, 4)).toBe(false)
    }
    expect(controller.scale).toBe(1)
  })

  it('does not lower the resolution when the main thread is the bottleneck', () => {
    const controller = new RenderScaleController(BUDGET)
    run(controller, 0, 30_000, 2 * BUDGET, BUDGET * 1.5)
    expect(controller.scale).toBe(1)
    expect(controller.degraded).toBe(false)
  })

  it('climbs back after calm frames and backs off after a failed attempt', () => {
    const controller = new RenderScaleController(BUDGET)
    let now = run(controller, 0, RENDER_SCALE.warmupMs + 4000, 30)
    const lowered = controller.scale
    expect(lowered).toBeLessThan(1)
    const changes: number[] = []
    now = run(controller, now, 8000, BUDGET, 4, changes)
    expect(controller.scale).toBeGreaterThan(lowered)
    const firstCalm = (changes[0] ?? now) - (now - 8000)
    // The step up overloads again: undo it, then wait twice as long before retrying.
    now = run(controller, now, 3000, 30)
    const retry: number[] = []
    const calmFrom = now
    run(controller, now, 30_000, BUDGET, 4, retry)
    expect((retry[0] ?? Infinity) - calmFrom).toBeGreaterThan(firstCalm)
  })

  it('switches to the reduced budget only after staying late at the smallest step', () => {
    const controller = new RenderScaleController(BUDGET)
    let now = run(controller, 0, 15_000, 40)
    expect(controller.scale).toBe(RENDER_SCALE.steps[0])
    expect(controller.degraded).toBe(false)
    now = run(controller, now, RENDER_SCALE.degradeAfterMs + RENDER_SCALE.windowMs + 1000, 40)
    expect(controller.degraded).toBe(true)
  })

  it('keeps the full image when the browser holds the page at 30 Hz', () => {
    const controller = new RenderScaleController(BUDGET)
    const changes: number[] = []
    // A battery saver: every frame 2 × 16.7 ms whatever the resolution, little main-thread work.
    let now = run(controller, 0, 60_000, 2 * BUDGET, 2, changes)
    expect(controller.scale).toBe(1)
    expect(controller.degraded).toBe(false)
    // One trial descent through the steps, undone once even the smallest did not help; the
    // controller then aims for 30 Hz and never tries again.
    expect(changes.length).toBe(RENDER_SCALE.steps.length)
    // A real overload above that rate still lowers the resolution.
    now = run(controller, now, 15_000, 3.4 * BUDGET, 2)
    expect(controller.scale).toBeLessThan(1)
  })

  it('still lowers the resolution for a GPU that a smaller image speeds up', () => {
    const controller = new RenderScaleController(BUDGET)
    let now = 0
    // Vsynced at 30 Hz at full size, 60 Hz once the image is small enough.
    while (now < 40_000) {
      const interval = controller.scale > 0.75 ? 2 * BUDGET : BUDGET
      now += interval
      controller.sample(now, interval, 2)
    }
    expect(controller.scale).toBeLessThan(1)
    expect(controller.degraded).toBe(false)
  })

  it('treats long gaps as pauses and restarts its window', () => {
    const controller = new RenderScaleController(BUDGET)
    let now = run(controller, 0, RENDER_SCALE.warmupMs + 100, BUDGET)
    for (let i = 0; i < 40; i++) {
      now += 1000
      expect(controller.sample(now, 1000, 1)).toBe(false)
    }
    expect(controller.scale).toBe(1)
  })
})

const desktop = (width: number, height: number, devicePixelRatio = 2) =>
  pixelRatioFor({ lowPower: false, devicePixelRatio, width, height })

describe('pixel ratio', () => {
  it('caps the drawing buffer by pixel count as well as ratio', () => {
    expect(desktop(1280, 720)).toBeCloseTo(Math.sqrt(PIXEL_BUDGET.desktop / (1280 * 720)))
    expect(desktop(800, 600)).toBe(1.75)
    expect(desktop(1280, 720, 1)).toBe(1)
    expect(2560 * 1440 * desktop(2560, 1440) ** 2).toBeLessThanOrEqual(PIXEL_BUDGET.desktop + 1)
    expect(desktop(3840, 2160, 1)).toBeLessThan(1)
  })

  it('uses the smaller budget on low-power devices', () => {
    const ratio = pixelRatioFor({ lowPower: true, devicePixelRatio: 3, width: 412, height: 915 })
    expect(ratio).toBe(1.25)
    const tablet = pixelRatioFor({ lowPower: true, devicePixelRatio: 2, width: 1024, height: 1366 })
    expect(1024 * 1366 * tablet ** 2).toBeCloseTo(PIXEL_BUDGET.lowPower, -2)
  })

  it('lets the debug override replace both caps', () => {
    expect(
      pixelRatioFor({
        lowPower: false,
        devicePixelRatio: 2,
        width: 3840,
        height: 2160,
        override: 2,
      }),
    ).toBe(2)
    expect(
      pixelRatioFor({ lowPower: true, devicePixelRatio: 1, width: 400, height: 800, override: 2 }),
    ).toBe(1)
  })
})

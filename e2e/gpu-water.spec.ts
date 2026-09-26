import { expect, test } from '@playwright/test'

for (const backend of ['webgpu', 'webgl'] as const)
  test(`${backend} water matches fixed-step reference and dissipates energy`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:4175/e2e/gpu-water.html?backend=${backend}`)
    await page.waitForFunction(() => Boolean(window.gpuWater || window.gpuWaterError))
    expect(await page.evaluate(() => window.gpuWaterError)).toBeUndefined()
    const result = await page.evaluate(async () => {
      if (!window.gpuWater) throw new Error('Water harness failed to initialize')
      const actualBackend = window.gpuWater.backend
      const odd = await window.gpuWater.verify(1)
      const diagnostics = await window.gpuWater.verify(24)
      const wind = await window.gpuWater.verifyWind()
      const shore = await window.gpuWater.verifyShore()
      await window.gpuWater.dispose()
      return { backend: actualBackend, oddError: odd.maxError, wind, shore, ...diagnostics }
    })
    expect(result.backend).toBe(backend)
    expect(result.finite).toBe(true)
    expect(result.oddError).toBeLessThan(0.0001)
    expect(result.maxError).toBeLessThan(0.0001)
    expect(result.height).toBeGreaterThan(0)
    expect(result.height).toBeLessThan(0.22)
    expect(result.velocity).toBeLessThan(1.5)
    expect(result.laterEnergy).toBeLessThan(result.energy)
    expect(result.wind.samples).toBe(9216)
    for (const error of result.wind.maxErrors) expect(error).toBeLessThan(0.0001)
    expect(result.shore.finite).toBe(true)
    expect(result.shore.maskedHeight).toBe(0)
    expect(result.shore.height).toBeGreaterThan(0)
    expect(result.shore.height).toBeLessThan(0.22)
    expect(result.shore.laterEnergy).toBeLessThan(result.shore.energy)
  })

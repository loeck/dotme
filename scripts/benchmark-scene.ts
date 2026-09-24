// GPU samples must run sequentially to avoid measurement contention.
/* eslint-disable no-await-in-loop */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { chromium, webkit, devices } from '@playwright/test'
import { preview } from 'vite'

import { chromiumLaunchOptions } from '../e2e/browser-options.ts'
import { parisWeatherFixture } from '../src/weather/paris.fixture.ts'

type LoadingMetrics = {
  complete: boolean
  frames: number
  maxLoadingFrameGapMs: number
  loadingLongTaskCount: number | null
  maxLoadingLongTaskMs: number | null
}
declare global {
  interface Window {
    sceneLoadingMetrics?: LoadingMetrics
  }
}

const seconds = Number(process.env.BENCH_SECONDS ?? 30)
const repeats = Number(process.env.BENCH_REPEATS ?? 3)
if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(repeats) || repeats < 1)
  throw new Error('BENCH_SECONDS must be positive and BENCH_REPEATS a positive integer')
const output = resolve(process.env.BENCH_OUTPUT ?? 'artifacts/performance')
const profiles = (process.env.BENCH_PROFILES ?? 'desktop,mobile').split(',')
const server = process.env.BENCH_URL
  ? undefined
  : await preview({ preview: { host: '127.0.0.1', port: 0 } })
const baseURL = process.env.BENCH_URL ?? server?.resolvedUrls?.local[0]
if (!baseURL) throw new Error('No preview URL available; build the site first')
const quantile = (values: readonly number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * q)] ?? 0
const runs: {
  profile: string
  scenario: string
  repeat: number
  backend: string | null
  frames: number
  medianMs: number
  p95Ms: number
  loaderMs: number
  readyMs: number
  maxLoadingFrameGapMs: number
  loadingLongTaskCount: number | null
  maxLoadingLongTaskMs: number | null
}[] = []
const loadingRuns: (LoadingMetrics & { profile: string; scenario: string; repeat: number })[] = []
const unsupportedProfiles = new Set<string>()
const browserErrors: { profile: string; scenario: string; repeat: number; message: string }[] = []
await mkdir(output, { recursive: true })
try {
  // Run sequentially: competing browser contexts distort GPU measurements.
  for (const profile of profiles) {
    const browser =
      profile === 'mobile' ? await webkit.launch() : await chromium.launch(chromiumLaunchOptions())
    try {
      const context = await browser.newContext(
        profile === 'mobile'
          ? { ...devices['iPhone 13'] }
          : { viewport: { width: 1280, height: 720 } },
      )
      for (const scenario of ['day', 'night', 'rain']) {
        if (unsupportedProfiles.has(profile)) break
        for (let repeat = 0; repeat < repeats; repeat++) {
          const page = await context.newPage()
          const errors: string[] = []
          const recordError = (message: string) => {
            errors.push(message)
            browserErrors.push({ profile, scenario, repeat, message })
          }
          page.on('pageerror', (error) => recordError(error.message))
          page.on('console', (message) => {
            if (message.type() === 'error') recordError(message.text())
          })
          await page.addInitScript(() => {
            const supported =
              typeof PerformanceObserver !== 'undefined' &&
              PerformanceObserver.supportedEntryTypes.includes('longtask')
            const metrics: LoadingMetrics = {
              complete: false,
              frames: 0,
              maxLoadingFrameGapMs: 0,
              loadingLongTaskCount: supported ? 0 : null,
              maxLoadingLongTaskMs: supported ? 0 : null,
            }
            window.sceneLoadingMetrics = metrics
            let ended = Infinity
            if (supported) {
              // Keep observing until page disposal so the task containing the final
              // loading frame can be delivered, but exclude tasks that start later.
              const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  if (entry.startTime >= ended) continue
                  metrics.loadingLongTaskCount = (metrics.loadingLongTaskCount ?? 0) + 1
                  metrics.maxLoadingLongTaskMs = Math.max(
                    metrics.maxLoadingLongTaskMs ?? 0,
                    entry.duration,
                  )
                }
              })
              observer.observe({ type: 'longtask', buffered: true })
            }
            let previous = performance.now()
            const sample = (now: number) => {
              metrics.frames++
              metrics.maxLoadingFrameGapMs = Math.max(metrics.maxLoadingFrameGapMs, now - previous)
              previous = now
              const state = document.documentElement.dataset.sceneLoading
              if (state === 'ready' || state === 'failed') {
                ended = now
                metrics.complete = true
              } else requestAnimationFrame(sample)
            }
            requestAnimationFrame(sample)
          })
          const weather = parisWeatherFixture()
          if (scenario === 'rain')
            Object.assign(weather.current, { weather_code: 65, rain: 2, cloud_cover: 100 })
          await page.route('https://api.open-meteo.com/**', (route) =>
            route.fulfill({ json: weather }),
          )
          const started = performance.now()
          await page.goto(
            `${baseURL}?seed=9182&startTime=${scenario === 'night' ? '00:00' : '12:00'}`,
            { waitUntil: 'domcontentloaded' },
          )
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLCanvasElement>('canvas')?.dataset.loaderRendered ===
                'true' || document.documentElement.dataset.sceneLoading === 'failed',
          )
          const loaderMs = performance.now() - started
          await page.waitForFunction(() => window.sceneLoadingMetrics?.complete)
          const loading = await page.evaluate(() => {
            const metrics = window.sceneLoadingMetrics
            if (!metrics) throw new Error('Loading metrics were not initialized')
            return metrics
          })
          const loadingRun = { profile, scenario, repeat, ...loading }
          loadingRuns.push(loadingRun)
          if ((await page.locator('html').getAttribute('data-scene-loading')) === 'failed') {
            const supported = await page.evaluate(async () =>
              navigator.gpu
                ? Boolean(await navigator.gpu.requestAdapter().catch(() => null))
                : false,
            )
            if (profile !== 'mobile' || supported)
              throw new Error(`${profile}: WebGPU scene failed to initialize`)
            unsupportedProfiles.add(profile)
            console.log(
              JSON.stringify({
                profile,
                status: 'static-profile',
                reason: 'WebGPU adapter unavailable',
              }),
            )
            await page.close()
            break
          }
          await page.locator('html[data-scene-loading="ready"]').waitFor({ state: 'attached' })
          const readyMs = performance.now() - started
          const intervals = await page.evaluate(
            (duration) =>
              new Promise<number[]>((resolveSamples) => {
                const samples: number[] = []
                const start = performance.now()
                let previous = start
                const sample = (now: number) => {
                  if (now - start > 2000) samples.push(now - previous)
                  previous = now
                  if (now - start < (duration + 2) * 1000) requestAnimationFrame(sample)
                  else resolveSamples(samples)
                }
                requestAnimationFrame(sample)
              }),
            seconds,
          )
          const backend = await page.locator('canvas[data-backend]').getAttribute('data-backend')
          await page.screenshot({ path: resolve(output, `${profile}-${scenario}-${repeat}.png`) })
          const loadingTasks = await page.evaluate(() => window.sceneLoadingMetrics)
          if (!loadingTasks) throw new Error('Loading metrics were lost')
          Object.assign(loadingRun, loadingTasks)
          if (errors.length) throw new Error(errors.join('\n'))
          const run = {
            profile,
            scenario,
            repeat,
            backend,
            frames: intervals.length,
            medianMs: quantile(intervals, 0.5),
            p95Ms: quantile(intervals, 0.95),
            loaderMs,
            readyMs,
            maxLoadingFrameGapMs: loading.maxLoadingFrameGapMs,
            loadingLongTaskCount: loadingTasks.loadingLongTaskCount,
            maxLoadingLongTaskMs: loadingTasks.maxLoadingLongTaskMs,
          }
          runs.push(run)
          console.log(JSON.stringify(run))
          await page.close()
        }
      }
      await context.close()
    } finally {
      await browser.close()
    }
  }
} finally {
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        seconds,
        repeats,
        adapter: process.env.WEBGPU_ADAPTER ?? 'native',
        runs,
        loadingRuns,
        unsupportedProfiles: [...unsupportedProfiles],
        browserErrors,
      },
      null,
      2,
    ),
  )
  if (server)
    await new Promise<void>((resolveClose, rejectClose) =>
      server.httpServer.close((error) => (error ? rejectClose(error) : resolveClose())),
    )
}

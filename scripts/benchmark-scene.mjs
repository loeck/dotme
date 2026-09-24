// Independent contexts must run sequentially to avoid competing for the GPU.
/* eslint-disable no-await-in-loop */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium, webkit, devices } from '@playwright/test'
import { build } from 'vite'

const quantile = (values, q) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * q)]

// Detect other automated browsers without inspecting profiles or stopping them.
function competingBrowsers() {
  if (process.platform === 'win32') return null
  const processes = execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []
    })
  const parents = new Map(processes.map((p) => [p.pid, p.parent]))
  return processes
    .filter((p) => {
      if (!/chrome-headless-shell|MiniBrowser/.test(p.command) || p.command.includes('--type='))
        return false
      // Ignore command lines that merely mention this process test (shell/rg).
      if (!/^\S*(?:chrome-headless-shell|MiniBrowser)(?:\s|$)/.test(p.command)) return false
      let ancestor = p.pid
      while (ancestor > 1 && parents.has(ancestor)) {
        if (ancestor === process.pid) return false
        ancestor = parents.get(ancestor)
      }
      return true
    })
    .map((p) => p.pid)
}

async function waitForQuiet() {
  const until = Date.now() + 120_000
  while ((competingBrowsers()?.length ?? 0) > 0 && Date.now() < until)
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
}

// Production bundles, sequential A/B runs. No application source is modified.
const reference = process.argv[2] ?? 'HEAD'
const output = resolve(process.env.BENCH_OUTPUT ?? 'artifacts/performance')
const repetitions = Number(process.env.BENCH_REPEATS ?? 3)
const seconds = Number(process.env.BENCH_SECONDS ?? 30)
const profiles = (process.env.BENCH_PROFILES ?? 'desktop,mobile').split(',')
const query = process.env.BENCH_QUERY ?? 'startTime=00:00&rain=heavy&weather=partly-cloudy'
const seeds = (process.env.BENCH_SEEDS ?? '0,12,9182').split(',').map(Number)
const rainCpuOnly = process.env.BENCH_RAIN_CPU === '1'
const diagnosticRuns = process.env.BENCH_DIAGNOSTICS === '1'
const captureOnly = process.env.BENCH_CAPTURE_ONLY === '1'
const bedExperiment = process.env.BENCH_BED_EXPERIMENT === '1'
const workspace = process.cwd()
const temporary = await mkdtemp(join(tmpdir(), 'dotme-performance-'))
let browser
let server
const report = {
  reference: bedExperiment ? 'working-tree-full-bed' : reference,
  seconds,
  repetitions,
  query,
  diagnosticRuns,
  runs: [],
  images: [],
  rainCpu: [],
}
try {
  await mkdir(output, { recursive: true })
  const baseline = join(temporary, 'baseline')
  await mkdir(baseline)
  const archive = execFileSync('git', ['archive', reference, 'src'])
  execFileSync('tar', ['-x', '-C', baseline], { input: archive })
  await symlink(join(workspace, 'node_modules'), join(baseline, 'node_modules'))
  await mkdir(join(baseline, 'e2e'))
  await cp('e2e/performance-harness.ts', join(baseline, 'e2e/performance-harness.ts'))
  for (const [name, entry] of [
    ['baseline', join(baseline, 'e2e/performance-harness.ts')],
    ['optimized', resolve('e2e/performance-harness.ts')],
  ]) {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: join(temporary, name + '-bundle'),
        lib: { entry, formats: ['es'], fileName: () => 'harness.js' },
      },
    })
  }
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div>',
      )
      return
    }
    const match = path.match(/^\/(baseline|optimized)\/(harness\.js|assets\/[\w.-]+)$/)
    if (!match) {
      response.writeHead(404)
      response.end()
      return
    }
    try {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(await readFile(join(temporary, match[1] + '-bundle', match[2])))
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const url = `http://127.0.0.1:${server.address().port}`
  for (const profile of profiles) {
    browser = await (profile === 'desktop' ? chromium : webkit).launch(
      profile === 'desktop' && process.platform === 'darwin' ? { args: ['--use-angle=metal'] } : {},
    )
    const context = await browser.newContext(
      profile === 'desktop'
        ? { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }
        : { ...devices['iPhone 13'], viewport: { width: 390, height: 664 } },
    )
    if (rainCpuOnly) {
      for (let repeat = 0; repeat < repetitions; repeat++) {
        for (const variant of repeat % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
          const page = await context.newPage()
          await page.goto(`${url}/?${query}`)
          const result = await page.evaluate(async (v) => {
            const module = await import(`/${v}/harness.js`)
            module.start(9182)
            const sample = module.rainCpu()
            module.stop()
            return sample
          }, variant)
          report.rainCpu.push({ profile, variant, repeat, ...result })
          console.log(JSON.stringify({ profile, variant, repeat, ...result }))
          await page.close()
        }
      }
    }
    for (const seed of rainCpuOnly ? [] : seeds) {
      const captures = []
      for (const variant of ['baseline', 'optimized']) {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text())
        })
        await page.goto(`${url}/?${query}`)
        const data = await page.evaluate(
          async ({ variant: v, seed: s, bedExperiment: bed }) => {
            const module = await import(`/${bed ? 'optimized' : v}/harness.js`)
            module.start(s, v === 'optimized')
            if (bed && v === 'optimized') module.simplifyBed()
            return module.capture(18)
          },
          { variant, seed, bedExperiment },
        )
        await page.screenshot({ path: join(output, `${profile}-${seed}-${variant}.png`) })
        if (variant === 'optimized')
          data.diagnostics = await page.evaluate(async () =>
            (await import('/optimized/harness.js')).readDiagnostics(),
          )
        captures.push(data)
        await page.close()
        if (errors.length) throw new Error(errors.join('\n'))
      }
      const [a, b] = captures
      let sum = 0,
        max = 0,
        changed = 0
      for (let i = 0; i < a.pixels.length; i += 4) {
        let pixel = 0
        for (let c = 0; c < 3; c++) {
          const difference = Math.abs(a.pixels[i + c] - b.pixels[i + c])
          sum += difference
          max = Math.max(max, difference)
          pixel = Math.max(pixel, difference)
        }
        if (pixel > 3) changed++
      }
      const result = {
        profile,
        seed,
        meanAbsoluteByteDifference: sum / (a.pixels.length * 0.75),
        maxByteDifference: max,
        fractionPixelsOver3: changed / (a.pixels.length / 4),
        channels: b.channels,
        diagnostics: b.diagnostics,
      }
      report.images.push(result)
      console.log(JSON.stringify({ ...result, diagnostics: undefined }))
    }
    if (!captureOnly && !bedExperiment && !rainCpuOnly)
      for (let repeat = 0; repeat < repetitions; repeat++) {
        for (const variant of repeat % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
          await waitForQuiet()
          const page = await context.newPage()
          await page.goto(`${url}/?${query}`)
          await page.evaluate(
            async ({ v, diagnostics }) => {
              const module = await import(`/${v}/harness.js`)
              module.start(9182, diagnostics, v === 'baseline')
              module.animate()
            },
            { v: variant, diagnostics: diagnosticRuns },
          )
          const competing = new Set(competingBrowsers() ?? [])
          const monitor = setInterval(() => {
            for (const pid of competingBrowsers() ?? []) competing.add(pid)
          }, 500)
          monitor.unref()
          await page.waitForTimeout(5000)
          await page.evaluate(
            async (v) => (await import(`/${v}/harness.js`)).samples(true),
            variant,
          )
          await page.waitForTimeout(seconds * 1000)
          const diagnosticData = diagnosticRuns
            ? await page.evaluate(
                async (v) => (await import(`/${v}/harness.js`)).readDiagnostics(),
                variant,
              )
            : null
          const frames = await page.evaluate(async (v) => {
            const module = await import(`/${v}/harness.js`)
            const data = module.samples()
            module.stop()
            return data
          }, variant)
          clearInterval(monitor)
          const result = {
            contentionDetected: process.platform === 'win32' ? null : competing.size > 0,
            competingBrowserPids: [...competing],
            profile,
            variant,
            repeat,
            frames: frames.length,
            medianMs: quantile(
              frames.map((f) => f.intervalMs),
              0.5,
            ),
            p95Ms: quantile(
              frames.map((f) => f.intervalMs),
              0.95,
            ),
            cpuMedianMs: quantile(
              frames.map((f) => f.cpuMs),
              0.5,
            ),
            calls: quantile(
              frames.map((f) => f.calls),
              0.5,
            ),
            triangles: quantile(
              frames.map((f) => f.triangles),
              0.5,
            ),
          }
          if (diagnosticData)
            await writeFile(
              join(output, `${profile}-${variant}-${repeat}-passes.json`),
              JSON.stringify(diagnosticData),
            )
          report.runs.push(result)
          await writeFile(
            join(output, `${profile}-${variant}-${repeat}.json`),
            JSON.stringify(frames),
          )
          console.log(JSON.stringify(result))
          await page.close()
        }
      }
    await context.close()
    await browser.close()
    browser = undefined
  }
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  server?.close()
  await rm(temporary, { recursive: true, force: true })
}

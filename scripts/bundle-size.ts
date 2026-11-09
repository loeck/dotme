import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** Gzip of everything that must load before the loader's first frame (docs/bundle-size.md). */
const FIRST_RENDER_BUDGET = 260_000
/**
 * Generous gzip ceiling for everything the scene needs before it is ready: the first-render
 * set, the landscape graph, weather, the world worker and Rapier (JavaScript and WebAssembly).
 * It catches accidental multi-megabyte regressions; it is not a startup-time measurement.
 */
const READY_BUDGET = 2_000_000

type Chunk = { file: string; imports: string[]; dynamicImports: string[]; assets: string[] }
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string'))
    throw new Error('Invalid manifest dependency list')
  return value
}
function parseManifest(value: unknown): Map<string, Chunk> {
  if (!value || typeof value !== 'object') throw new Error('Invalid Vite manifest')
  const chunks = new Map<string, Chunk>()
  for (const [key, item] of Object.entries(value)) {
    const chunk: unknown = item
    if (!chunk || typeof chunk !== 'object' || !('file' in chunk) || typeof chunk.file !== 'string')
      throw new Error(`Invalid manifest chunk: ${key}`)
    chunks.set(key, {
      file: chunk.file,
      imports: 'imports' in chunk ? strings(chunk.imports) : [],
      dynamicImports: 'dynamicImports' in chunk ? strings(chunk.dynamicImports) : [],
      assets: 'assets' in chunk ? strings(chunk.assets) : [],
    })
  }
  return chunks
}
const directory = resolve(process.argv[2] ?? 'dist')
const html = await readFile(resolve(directory, 'index.html'), 'utf8')
const manifest = parseManifest(
  JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8')),
)
const byFile = new Map([...manifest.values()].map((chunk) => [chunk.file, chunk]))

/** Adds a chunk's static import closure to `files`. */
function includeImports(chunk: Chunk, files: Set<string>) {
  for (const key of chunk.imports) {
    const imported = manifest.get(key)
    if (!imported) throw new Error(`Missing static dependency: ${key}`)
    if (files.has(imported.file)) continue
    files.add(imported.file)
    includeImports(imported, files)
  }
}

const initial = new Set<string>()
const blockingCss = new Set<string>()
for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
  const url = tag.match(/(?:src|href)="\/?([^"?]+)/)?.[1]
  if (!url) continue
  if (/type="module"|rel="modulepreload"/.test(tag) && url.endsWith('.js')) initial.add(url)
  // Stylesheets in the document block its first render, so they count with the loader.
  if (/rel="stylesheet"/.test(tag) && url.endsWith('.css')) blockingCss.add(url)
}
for (const file of initial) {
  const chunk = byFile.get(file)
  if (chunk) includeImports(chunk, initial)
}
const landscape = manifest.get('src/components/landscape.ts')
if (!landscape || initial.has(landscape.file))
  throw new Error('Landscape must be a deferred import')
const weather = manifest.get('src/weather/scene.ts')
if (weather && initial.has(weather.file)) throw new Error('Weather must be a deferred import')

const assets = (await readdir(resolve(directory, 'assets'))).toSorted()
const resources = await Promise.all(
  assets
    .filter((file) => /\.(?:js|css|wasm)$/.test(file))
    .map(async (file) => {
      const data = await readFile(resolve(directory, 'assets', file))
      return {
        file: `assets/${file}`,
        bytes: data.length,
        gzip: gzipSync(data).length,
        brotli: brotliCompressSync(data, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        }).length,
      }
    }),
)
type Size = { bytes: number; gzip: number; brotli: number }
const sum = (rows: readonly Size[]) =>
  rows.reduce(
    (total, row) => ({
      bytes: total.bytes + row.bytes,
      gzip: total.gzip + row.gzip,
      brotli: total.brotli + row.brotli,
    }),
    { bytes: 0, gzip: 0, brotli: 0 },
  )
const select = (files: ReadonlySet<string>) => resources.filter((row) => files.has(row.file))

// Include independent inline rescue JavaScript in the first-render budget too.
const inlineSource = Buffer.from(
  [
    ...html.matchAll(
      /<script(?![^>]*(?:src=|type="application\/ld\+json"))[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ]
    .map((match) => match[1] ?? '')
    .join('\n'),
)
const inline: Size = {
  bytes: inlineSource.length,
  gzip: gzipSync(inlineSource).length,
  brotli: brotliCompressSync(inlineSource).length,
}
const initialJs = sum(select(initial))
const css = sum(select(blockingCss))
const firstRender = sum([initialJs, css, inline])

// Everything else the scene loads before it is ready. Rapier is matched by name so a
// separate WebAssembly file or a renamed chunk is still counted.
const ready = new Set([...initial, ...blockingCss, landscape.file])
includeImports(landscape, ready)
for (const key of ['src/weather/scene.ts', 'src/weather/current.ts']) {
  const chunk = manifest.get(key)
  if (!chunk) continue
  ready.add(chunk.file)
  includeImports(chunk, ready)
}
for (const row of resources)
  if (/^assets\/(?:rapier|world\.worker)[-.]/.test(row.file)) ready.add(row.file)
const readyPath = sum([...select(ready), inline])

console.log(
  JSON.stringify(
    {
      firstRender: { ...firstRender, budgetGzip: FIRST_RENDER_BUDGET },
      initialJs,
      blockingCss: css,
      inline,
      readyPath: { ...readyPath, budgetGzip: READY_BUDGET, files: [...ready].toSorted() },
      total: sum(resources),
      resources,
    },
    null,
    2,
  ),
)
if (firstRender.gzip > FIRST_RENDER_BUDGET)
  throw new Error(`Loader budget exceeded: ${firstRender.gzip} > ${FIRST_RENDER_BUDGET} bytes gzip`)
if (readyPath.gzip > READY_BUDGET)
  throw new Error(`Ready-path budget exceeded: ${readyPath.gzip} > ${READY_BUDGET} bytes gzip`)

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

type Chunk = { file: string; imports: string[]; dynamicImports: string[] }
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
    })
  }
  return chunks
}
const directory = resolve(process.argv[2] ?? 'dist')
const html = await readFile(resolve(directory, 'index.html'), 'utf8')
const manifest = parseManifest(
  JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8')),
)
const initial = new Set<string>()
for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
  if (!/type="module"|rel="modulepreload"/.test(tag)) continue
  const url = tag.match(/(?:src|href)="\/?([^"?]+)/)?.[1]
  if (url?.endsWith('.js')) initial.add(url)
}
function includeImports(chunk: Chunk) {
  for (const key of chunk.imports) {
    const imported = manifest.get(key)
    if (!imported) throw new Error(`Missing static dependency: ${key}`)
    if (initial.has(imported.file)) continue
    initial.add(imported.file)
    includeImports(imported)
  }
}
for (const chunk of manifest.values()) if (initial.has(chunk.file)) includeImports(chunk)
const landscape = manifest.get('src/components/landscape.ts')
if (!landscape || initial.has(landscape.file))
  throw new Error('Landscape must be a deferred import')
const chunks = await Promise.all(
  (await readdir(resolve(directory, 'assets')))
    .filter((file) => file.endsWith('.js'))
    .toSorted()
    .map(async (file) => {
      const data = await readFile(resolve(directory, 'assets', file))
      return {
        file,
        bytes: data.length,
        gzip: gzipSync(data).length,
        initial: initial.has(`assets/${file}`),
      }
    }),
)
const sum = (rows: typeof chunks) =>
  rows.reduce(
    (total, chunk) => ({
      bytes: total.bytes + chunk.bytes,
      gzip: total.gzip + chunk.gzip,
    }),
    { bytes: 0, gzip: 0 },
  )
const entry = sum(chunks.filter((chunk) => chunk.initial))
// Include independent inline rescue JavaScript in the first-render budget too.
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1] ?? '')
  .join('\n')
const firstRenderGzip = entry.gzip + gzipSync(inline).length
const budget = 260_000
console.log(
  JSON.stringify(
    {
      initial: entry,
      inlineGzip: gzipSync(inline).length,
      firstRenderGzip,
      budget,
      total: sum(chunks),
      chunks,
    },
    null,
    2,
  ),
)
if (firstRenderGzip > budget)
  throw new Error(`Loader budget exceeded: ${firstRenderGzip} > ${budget} bytes gzip`)

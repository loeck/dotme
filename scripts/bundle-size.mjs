import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const directory = resolve(process.argv[2] ?? 'dist')
const html = await readFile(process.argv[3] ?? resolve(directory, 'index.html'), 'utf8')
const files = (await readdir(resolve(directory, 'assets')))
  .filter((file) => file.endsWith('.js'))
  .toSorted()
const initial = new Set()
for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
  if (!/type="module"|rel="modulepreload"/.test(tag)) continue
  const url = tag.match(/(?:src|href)="\/?([^"?]+)/)?.[1]
  if (url?.endsWith('.js')) initial.add(url)
}
// Include static imports of entry/preload chunks, but exclude dynamic imports.
let manifest = {}
try {
  manifest = JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
function includeImports(chunk) {
  for (const key of chunk.imports ?? []) {
    const imported = manifest[key]
    if (!imported || initial.has(imported.file)) continue
    initial.add(imported.file)
    includeImports(imported)
  }
}
for (const chunk of Object.values(manifest)) {
  if (initial.has(chunk.file)) includeImports(chunk)
}
const chunks = await Promise.all(
  files.map(async (file) => {
    const data = await readFile(resolve(directory, 'assets', file))
    return {
      file,
      bytes: data.length,
      gzip: gzipSync(data).length,
      initial: initial.has(`assets/${file}`),
    }
  }),
)
const sum = (rows) =>
  rows.reduce(
    (total, chunk) => ({ bytes: total.bytes + chunk.bytes, gzip: total.gzip + chunk.gzip }),
    { bytes: 0, gzip: 0 },
  )
console.log(
  JSON.stringify(
    { initial: sum(chunks.filter((chunk) => chunk.initial)), total: sum(chunks), chunks },
    null,
    2,
  ),
)

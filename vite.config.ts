import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'

import { headersFor, readHeaderRules } from './scripts/vercel-headers.ts'

// Run after Vite resolves directory URLs and before it serves their HTML.
function configureNotFoundPage(server: ViteDevServer | PreviewServer) {
  const root =
    'transformIndexHtml' in server
      ? server.config.root
      : resolve(server.config.root, server.config.build.outDir)
  return () =>
    // All asynchronous failures are caught and forwarded to Connect's next().
    // eslint-disable-next-line oxc/no-async-endpoint-handlers
    server.middlewares.use(async (request, response, next) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return next()
      if (['/index.html', '/404.html'].includes(request.url?.split('?')[0] ?? '')) return next()
      try {
        let html = await readFile(resolve(root, '404.html'), 'utf8')
        if ('transformIndexHtml' in server)
          html = await server.transformIndexHtml('/404.html', html)
        response.statusCode = 404
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(request.method === 'HEAD' ? undefined : html)
      } catch (error) {
        next(error)
      }
    })
}

const RAPIER_WASM_URL = resolve(import.meta.dirname, 'src/scene/rapier-wasm-url.ts')
const RAPIER_PACKAGE = /[\\/]@dimforge[\\/]rapier3d-compat[\\/]dist[\\/]rapier\.mjs$/
// The decoded bytes' `.buffer` is part of the expression the module replaces.
const RAPIER_INLINE = /[\w$]+\.toByteArray\("(AGFzbQ[\w+/=]+)"\)(?:\.buffer)?/g

/** The single base64 WebAssembly literal Rapier's compat build inlines, or a build error. */
function inlinedRapierWasm(code: string) {
  const matches = [...code.matchAll(RAPIER_INLINE)]
  const [match] = matches
  if (matches.length !== 1 || !match?.[1])
    throw new Error('rapier-wasm-file: expected one inlined WebAssembly module in Rapier')
  return { call: match[0], base64: match[1] }
}

/**
 * Production builds ship Rapier's WebAssembly as a hashed file instead of 2 MB of base64 in
 * JavaScript: the module compiles while it streams (src/scene/rapier-wasm.ts) and the script
 * no longer parses the string. Development keeps the package as published.
 */
function rapierWasmFile(): Plugin {
  let build = false
  return {
    name: 'rapier-wasm-file',
    enforce: 'pre',
    configResolved(config) {
      build = config.command === 'build'
    },
    async load(id) {
      if (!build || id !== RAPIER_WASM_URL) return undefined
      const rapier = await this.resolve('@dimforge/rapier3d-compat')
      if (!rapier) throw new Error('rapier-wasm-file: @dimforge/rapier3d-compat is not installed')
      const { base64 } = inlinedRapierWasm(await readFile(rapier.id, 'utf8'))
      const reference = this.emitFile({
        type: 'asset',
        name: 'rapier.wasm',
        source: Buffer.from(base64, 'base64'),
      })
      return `export default import.meta.ROLLUP_FILE_URL_${reference}`
    },
    transform(code, id) {
      if (!build || !RAPIER_PACKAGE.test(id)) return undefined
      const { call } = inlinedRapierWasm(code)
      const loader = JSON.stringify(resolve(import.meta.dirname, 'src/scene/rapier-wasm.ts'))
      return {
        code: `import { rapierWasm as __rapierWasm } from ${loader};\n${code.replace(call, '__rapierWasm()')}`,
        map: null,
      }
    },
  }
}

/** Serves the build with vercel.json's headers, CSP included, so browser tests run under them. */
async function configureProductionHeaders(server: PreviewServer) {
  const rules = await readHeaderRules(server.config.root)
  // Registered directly, so the headers precede Vite's static file handler.
  server.middlewares.use((request, response, next) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    for (const [key, value] of headersFor(rules, path)) response.setHeader(key, value)
    next()
  })
}

export default defineConfig({
  appType: 'mpa',
  plugins: [
    tailwindcss(),
    rapierWasmFile(),
    {
      name: 'static-not-found',
      configureServer: configureNotFoundPage,
      configurePreviewServer: configureNotFoundPage,
    },
    { name: 'production-headers', configurePreviewServer: configureProductionHeaders },
  ],
  build: {
    manifest: true,
    // The loader entry carries the Three.js WebGPU runtime (about 640 kB minified); its
    // compressed size is budgeted by scripts/bundle-size.ts instead.
    chunkSizeWarningLimit: 800,
    rolldownOptions: { input: ['index.html', '404.html'] },
  },
})

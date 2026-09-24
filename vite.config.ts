import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { PreviewServer, ViteDevServer } from 'vite'

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
      if (
        'transformIndexHtml' in server &&
        request.url?.startsWith('/e2e/') &&
        request.url.split('?')[0]?.endsWith('.html')
      )
        return next()
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

export default defineConfig({
  appType: 'mpa',
  plugins: [
    tailwindcss(),
    {
      name: 'static-not-found',
      configureServer: configureNotFoundPage,
      configurePreviewServer: configureNotFoundPage,
    },
  ],
  build: {
    manifest: true,
    rolldownOptions: { input: ['index.html', '404.html'] },
  },
})

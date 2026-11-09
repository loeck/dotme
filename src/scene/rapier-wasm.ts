import wasmUrl from './rapier-wasm-url'

let compiling: Promise<WebAssembly.Module> | undefined

async function compile(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Rapier WebAssembly request failed: ${response.status}`)
  // Streaming compilation runs off the main thread while the bytes arrive; it needs the
  // application/wasm type, so a misconfigured server falls back to compiling the buffer.
  if (response.headers.get('Content-Type')?.startsWith('application/wasm'))
    return WebAssembly.compileStreaming(response)
  return WebAssembly.compile(await response.arrayBuffer())
}

/**
 * Starts (once) downloading and compiling Rapier's WebAssembly, so the module is ready when the
 * physics package initializes. Undefined when the build inlines it (development).
 */
export function rapierWasm(): Promise<WebAssembly.Module> | undefined {
  if (!wasmUrl) return undefined
  if (!compiling) {
    const request = compile(wasmUrl)
    compiling = request
    // A failed request is retried by the next caller rather than cached.
    request.catch(() => {
      if (compiling === request) compiling = undefined
    })
  }
  return compiling
}

/** The scene backend a browser can offer; pass to `page.evaluate`, it captures nothing. */
export async function availableBackend() {
  if (await navigator.gpu?.requestAdapter().catch(() => null)) return 'webgpu'
  return document.createElement('canvas').getContext('webgl2') ? 'webgl' : null
}

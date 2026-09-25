import type { LaunchOptions } from '@playwright/test'

/** Use native graphics locally and an explicit software WebGPU adapter on CI. */
export function chromiumLaunchOptions(): LaunchOptions {
  const adapter = process.env.WEBGPU_ADAPTER ?? 'native'
  if (adapter !== 'native' && adapter !== 'swiftshader')
    throw new Error('WEBGPU_ADAPTER must be native or swiftshader')
  const args =
    adapter === 'swiftshader'
      ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader']
      : process.platform === 'darwin'
        ? ['--use-angle=metal']
        : ['--enable-unsafe-webgpu']
  // Force every repeat cold: without this, repeat 0 populates the Dawn blob
  // cache and later repeats in the same browser profile measure warm compiles.
  if (process.env.BENCH_COLD === '1') args.push('--enable-dawn-features=disable_blob_cache')
  return { args }
}

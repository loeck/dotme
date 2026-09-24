import type { LaunchOptions } from '@playwright/test'

/** Use native graphics locally and an explicit software WebGPU adapter on CI. */
export function chromiumLaunchOptions(): LaunchOptions {
  const adapter = process.env.WEBGPU_ADAPTER ?? 'native'
  if (adapter !== 'native' && adapter !== 'swiftshader')
    throw new Error('WEBGPU_ADAPTER must be native or swiftshader')
  return {
    args:
      adapter === 'swiftshader'
        ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']
        : process.platform === 'darwin'
          ? ['--use-angle=metal']
          : ['--enable-unsafe-webgpu'],
  }
}

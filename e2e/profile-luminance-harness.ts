// One meter/query is deliberately exercised sequentially.
/* eslint-disable no-await-in-loop */
import { DataTexture, FloatType, NearestFilter, RGBAFormat, WebGLRenderer } from 'three'

import { ProfileLuminance } from '../src/scene/profile-luminance'

export async function verify() {
  const renderer = new WebGLRenderer()
  renderer.setSize(16, 16)
  const meter = new ProfileLuminance()
  const gl = renderer.getContext()
  let copies = 0
  const readPixels = gl.readPixels.bind(gl)
  gl.readPixels = (...args: Parameters<typeof readPixels>) => {
    copies++
    return readPixels(...args)
  }
  const cases: { expected: boolean; actual: boolean; encoded: number; threshold: number }[] = []
  const canvas = new DOMRect(0, 0, 8, 4)
  try {
    // Include both sides of each hysteresis threshold, HDR colors, exposure and
    // a cropped panel. Texture samples are averaged after tone mapping.
    for (const encoded of [0, 40, 41, 42, 50, 51, 52, 53, 128, 240]) {
      const values = new Float32Array(8 * 4 * 4)
      for (let i = 0; i < 32; i++) {
        const gray = (encoded + (i % 8 < 4 ? -0.2 : 0.2)) / 255
        values.fill(Math.max(0, gray / (1 - gray)), i * 4, i * 4 + 3)
        values[i * 4 + 3] = 1
      }
      const texture = new DataTexture(values, 8, 4, RGBAFormat, FloatType)
      texture.minFilter = texture.magFilter = NearestFilter
      texture.needsUpdate = true
      try {
        for (const exposure of [1, 1.4]) {
          renderer.toneMappingExposure = exposure
          for (const threshold of [0.16, 0.2]) {
            for (const width of [4, 8]) {
              let sum = 0
              for (let y = 0; y < 4; y++)
                for (let x = 0; x < width; x++) {
                  const value = values[(y * 8 + x) * 4]! * exposure
                  sum += value / (1 + value)
                }
              const expected = Math.round((sum / (width * 4)) * 255) / 255 > threshold
              const actual = await meter.read(
                renderer,
                texture,
                new DOMRect(0, 0, width, 4),
                canvas,
                threshold,
              )
              cases.push({ encoded, threshold, expected, actual })
            }
          }
        }
      } finally {
        texture.dispose()
      }
    }
    return { cases, copies, error: gl.getError() }
  } finally {
    meter.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  }
}

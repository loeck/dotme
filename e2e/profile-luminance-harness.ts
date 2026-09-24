import {
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'

import { SceneContrast } from '../src/scene/scene-contrast'

export async function verify() {
  document.body.style.margin = '0'
  const renderer = new WebGLRenderer()
  renderer.setSize(128, 64)
  document.body.append(renderer.domElement)
  const host = document.createElement('main')
  host.innerHTML =
    '<header class="profile-panel"><h1 style="position:absolute;left:12px;top:4px;margin:0;font:48px/1 monospace">M</h1></header>'
  document.body.append(host)
  const values = new Float32Array(128 * 64 * 4)
  const texture = new DataTexture(values, 128, 64, RGBAFormat, FloatType)
  texture.minFilter = texture.magFilter = NearestFilter
  const fill = (reverse: boolean) => {
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 128; x++) {
        const offset = (y * 128 + x) * 4
        values.fill(y >= 32 !== reverse ? 2 : 0.001, offset, offset + 3)
        values[offset + 3] = 1
      }
    texture.needsUpdate = true
  }
  const contrast = new SceneContrast(host, () => {})
  const scene = new Scene(),
    camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const geometry = new PlaneGeometry(2, 2)
  const material = new ShaderMaterial({
    uniforms: { tScene: { value: texture } },
    vertexShader: 'varying vec2 vUv; void main() {vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader:
      'uniform sampler2D tScene; varying vec2 vUv; void main(){vec3 c=texture2D(tScene,vUv).rgb;gl_FragColor=vec4(c/(1.+c),1.);}',
    depthTest: false,
    depthWrite: false,
  })
  scene.add(new Mesh(geometry, material))
  const target = new WebGLRenderTarget(128, 64, { depthBuffer: false })
  const capture = async (reverse: boolean) => {
    fill(reverse)
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    contrast.render(renderer, texture)
    const pixels = new Uint8Array(128 * 64 * 4)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 64, pixels)
    const count = (x0: number, x1: number, top: boolean) => {
      let black = 0,
        white = 0
      for (let y = top ? 32 : 8; y < (top ? 60 : 32); y++)
        for (let x = x0; x < x1; x++) {
          const value = pixels[(y * 128 + x) * 4]!
          if (value < 20) black++
          if (value > 235) white++
        }
      return { black, white }
    }
    return {
      glyphTop: count(12, 43, true),
      glyphBottom: count(12, 43, false),
    }
  }
  try {
    const initial = await capture(false)
    const changed = await capture(true)
    const rendererState = renderer.autoClear
    contrast.dispose()
    return {
      initial,
      changed,
      rendererState,
      cleaned: !host.hasAttribute('data-ui-mask'),
      error: renderer.getContext().getError(),
    }
  } finally {
    contrast.dispose()
    host.remove()
    renderer.domElement.remove()
    target.dispose()
    material.dispose()
    geometry.dispose()
    texture.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  }
}

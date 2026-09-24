import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector4,
  WebGLRenderTarget,
} from 'three'
import type { Texture, WebGLRenderer } from 'three'

/** Meter the rendered backdrop, not the DOM text, with one asynchronous pixel. */
export class ProfileLuminance {
  private readonly target = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly scene = new Scene()
  private readonly material = new ShaderMaterial({
    uniforms: {
      tScene: { value: null as Texture | null },
      uBounds: { value: new Vector4() },
      uExposure: { value: 1 },
    },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tScene;
      uniform vec4 uBounds;
      uniform float uExposure;
      void main() {
        float luminance = 0.0;
        for (int y = 0; y < 4; y++) for (int x = 0; x < 8; x++) {
          vec2 uv = mix(uBounds.xy, uBounds.zw, (vec2(float(x), float(y)) + 0.5) / vec2(8.0, 4.0));
          vec3 color = texture2D(tScene, uv).rgb * uExposure;
          // Match the final lens pass's Reinhard mapping. Keep linear luminance
          // for contrast comparisons (before the sRGB display transfer).
          color = color / (1.0 + color);
          luminance += dot(color, vec3(0.2126, 0.7152, 0.0722));
        }
        gl_FragColor = vec4(vec3(luminance / 32.0), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })

  constructor() {
    this.scene.add(new Mesh(this.geometry, this.material))
  }

  async read(renderer: WebGLRenderer, texture: Texture, panel: DOMRect, canvas: DOMRect) {
    this.material.uniforms.tScene!.value = texture
    this.material.uniforms.uExposure!.value = renderer.toneMappingExposure
    this.material.uniforms.uBounds!.value.set(
      (panel.left - canvas.left) / canvas.width,
      1 - (panel.bottom - canvas.top) / canvas.height,
      (panel.right - canvas.left) / canvas.width,
      1 - (panel.top - canvas.top) / canvas.height,
    )
    const previous = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(this.target)
      renderer.render(this.scene, this.camera)
    } finally {
      renderer.setRenderTarget(previous)
    }
    const pixel = new Uint8Array(4)
    await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, pixel)
    return pixel[0]! / 255
  }

  dispose() {
    this.target.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}

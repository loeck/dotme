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

/** Classify the rendered backdrop without a GPU buffer readback. */
export class ProfileLuminance {
  private cancelRead?: () => void
  private disposed = false
  private readonly target = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly scene = new Scene()
  private readonly material = new ShaderMaterial({
    uniforms: {
      tScene: { value: null as Texture | null },
      uBounds: { value: new Vector4() },
      uExposure: { value: 1 },
      uThresholdByte: { value: 51 },
    },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tScene;
      uniform vec4 uBounds;
      uniform float uExposure;
      uniform float uThresholdByte;
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
        // Preserve the former RGBA8 meter's quantization and hysteresis thresholds.
        float measured = floor(clamp(luminance / 32.0, 0.0, 1.0) * 255.0 + 0.5);
        if (measured <= uThresholdByte) discard;
        gl_FragColor = vec4(1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })

  constructor() {
    this.scene.add(new Mesh(this.geometry, this.material))
  }

  async read(
    renderer: WebGLRenderer,
    texture: Texture,
    panel: DOMRect,
    canvas: DOMRect,
    threshold: number,
  ): Promise<boolean> {
    if (this.disposed || this.cancelRead) throw new Error('Backdrop meter unavailable')
    const gl = renderer.getContext() as WebGL2RenderingContext
    if (gl.isContextLost()) throw new Error('Backdrop meter context lost')
    const query = gl.createQuery()
    if (!query) throw new Error('Backdrop query unavailable')
    this.material.uniforms.tScene!.value = texture
    this.material.uniforms.uExposure!.value = renderer.toneMappingExposure
    this.material.uniforms.uThresholdByte!.value = Math.floor(threshold * 255)
    this.material.uniforms.uBounds!.value.set(
      (panel.left - canvas.left) / canvas.width,
      1 - (panel.bottom - canvas.top) / canvas.height,
      (panel.right - canvas.left) / canvas.width,
      1 - (panel.top - canvas.top) / canvas.height,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const previous = renderer.getRenderTarget()
      try {
        renderer.setRenderTarget(this.target)
        gl.beginQuery(gl.ANY_SAMPLES_PASSED, query)
        try {
          renderer.render(this.scene, this.camera)
        } finally {
          gl.endQuery(gl.ANY_SAMPLES_PASSED)
        }
      } finally {
        renderer.setRenderTarget(previous)
      }
      // Even fenced getBufferSubData can stall Chrome behind later queued frames.
      // Poll the classification on later tasks, including in reduced motion.
      return await new Promise<boolean>((resolve, reject) => {
        this.cancelRead = () => reject(new Error('Backdrop meter disposed'))
        const poll = () => {
          try {
            if (gl.isContextLost()) throw new Error('Backdrop meter context lost')
            if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
              resolve(!!gl.getQueryParameter(query, gl.QUERY_RESULT))
            else timer = setTimeout(poll, 16)
          } catch (error) {
            reject(error)
          }
        }
        timer = setTimeout(poll, 16)
      })
    } finally {
      clearTimeout(timer)
      gl.deleteQuery(query)
      this.cancelRead = undefined
    }
  }

  dispose() {
    this.disposed = true
    this.cancelRead?.()
    this.target.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}

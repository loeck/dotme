import {
  CanvasTexture,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
} from 'three'
import type { Texture, WebGLRenderer } from 'three'

export const CONTRAST_FRAGMENT = `
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tMask;
  uniform float uExposure;
  uniform vec2 uSize;
  float backdropLuminance(vec2 uv) {
    vec3 scene = texture2D(tScene, uv).rgb * uExposure;
    scene = scene / (1.0 + scene);
    return dot(scene, vec3(0.2126, 0.7152, 0.0722));
  }
  void main() {
    // The mask stores the dark stroke in alpha and white glyph coverage in RGB.
    // Build both once on the CPU, avoiding a dilation pass on every scene pixel.
    vec4 mask = texture2D(tMask, vUv);
    float alpha = mask.r * mask.a;
    float expanded = mask.a;
    if (expanded < 0.002) discard;
    if (alpha > 0.0) {
      // Canvas ignores the DOM's grayscale font smoothing. A subpixel erosion
      // restores the original regular weight, retaining layout and sharp edges.
      vec2 inset = vec2(0.2) / uSize;
      vec4 left = texture2D(tMask, vUv - vec2(inset.x, 0.0));
      vec4 right = texture2D(tMask, vUv + vec2(inset.x, 0.0));
      vec4 above = texture2D(tMask, vUv + vec2(0.0, inset.y));
      vec4 below = texture2D(tMask, vUv - vec2(0.0, inset.y));
      alpha = min(alpha, min(min(left.r * left.a, right.r * right.a), min(above.r * above.a, below.r * below.a)));
    }
    // Smooth the backdrop without blurring glyph coverage.
    vec2 tap = vec2(1.5) / uSize;
    float luminance = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      float weight = (x == 0 ? 0.5 : 0.25) * (y == 0 ? 0.5 : 0.25);
      luminance += backdropLuminance(vUv + vec2(float(x), float(y)) * tap) * weight;
    }
    float transition = 0.025;
    float ink = 1.0 - smoothstep(0.179 - transition, 0.179 + transition, luminance);
    // A continuous dark keyline preserves the silhouette even when the fluid
    // ink passes through the same gray as the sky. Coverage stays subpixel thin.
    // Dark ink already contrasts with a bright scene: do not thicken it.
    float support = smoothstep(0.08, 0.35, ink) * 0.7;
    float outline = max(0.0, expanded - alpha) * support;
    float coverage = alpha + outline;
    gl_FragColor = vec4(vec3(ink * alpha / max(coverage, 0.001)), coverage);
    #include <colorspace_fragment>
  }
`

/** Rasterize DOM glyph coverage only when layout changes; shade it on the GPU every frame. */
export class SceneContrast {
  private readonly canvas = document.createElement('canvas')
  private texture = new CanvasTexture(this.canvas)
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly material = new ShaderMaterial({
    vertexShader:
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: CONTRAST_FRAGMENT,
    uniforms: {
      tScene: { value: null },
      tMask: { value: this.texture },
      uExposure: { value: 1 },
      uSize: { value: new Vector2() },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly lifetime = new AbortController()
  private readonly observer: ResizeObserver
  private readonly dialogObserver: MutationObserver
  private dirty = true
  private disposed = false
  private width = 0
  private height = 0
  private dpr = 0

  constructor(
    private readonly host: HTMLElement | null,
    private readonly redraw: () => void,
  ) {
    this.texture.minFilter = this.texture.magFilter = LinearFilter
    this.texture.generateMipmaps = false
    this.scene.add(new Mesh(this.geometry, this.material))
    const signal = this.lifetime.signal
    const invalidate = () => {
      this.invalidate()
      this.redraw()
    }
    this.observer = new ResizeObserver(invalidate)
    if (host) {
      const profile = host.querySelector('.profile-panel')
      if (profile) this.observer.observe(profile)
      for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout'])
        host.addEventListener(event, invalidate, { signal })
    }
    this.dialogObserver = new MutationObserver(() => this.redraw())
    const dialog = document.querySelector('.scene-info-dialog')
    if (dialog) this.dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] })
    void document.fonts.ready.then(() => {
      if (!this.disposed) invalidate()
      return undefined
    })
  }

  private drawSvg(ctx: CanvasRenderingContext2D, svg: SVGSVGElement, origin: DOMRect) {
    const rect = svg.getBoundingClientRect(),
      box = svg.viewBox.baseVal
    ctx.save()
    ctx.translate(rect.left - origin.left, rect.top - origin.top)
    ctx.scale(rect.width / (box.width || 24), rect.height / (box.height || 24))
    ctx.translate(-box.x, -box.y)
    for (const shape of svg.querySelectorAll('path, circle')) {
      const path = new Path2D()
      if (shape.tagName === 'path') path.addPath(new Path2D(shape.getAttribute('d') ?? ''))
      else
        path.arc(
          Number(shape.getAttribute('cx')),
          Number(shape.getAttribute('cy')),
          Number(shape.getAttribute('r')),
          0,
          Math.PI * 2,
        )
      const style = getComputedStyle(shape)
      ctx.strokeStyle = 'black'
      ctx.lineWidth =
        (style.stroke !== 'none' ? Number.parseFloat(style.strokeWidth) : 0) +
        (0.65 * (box.width || 24)) / rect.width
      ctx.stroke(path)
      ctx.strokeStyle = 'white'
      // Canvas path filling, not Array.fill.
      // eslint-disable-next-line unicorn/no-array-fill-with-reference-type
      if (style.fill !== 'none') ctx.fill(path)
      if (style.stroke !== 'none') {
        ctx.lineWidth = Number.parseFloat(style.strokeWidth)
        ctx.stroke(path)
      }
    }
    ctx.restore()
  }

  private rebuild(bounds: DOMRect) {
    if (!this.host) return false
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return false
    const width = Math.ceil(bounds.width * this.dpr)
    const height = Math.ceil(bounds.height * this.dpr)
    const resized = this.canvas.width !== width || this.canvas.height !== height
    this.canvas.width = width
    this.canvas.height = height
    if (resized) {
      // WebGL2 texture storage is immutable: a viewport resize needs a new
      // allocation, not a sub-image upload into the previous dimensions.
      this.texture.dispose()
      this.texture = new CanvasTexture(this.canvas)
      this.texture.minFilter = this.texture.magFilter = LinearFilter
      this.texture.generateMipmaps = false
      this.material.uniforms.tMask!.value = this.texture
    }
    ctx.scale(this.dpr, this.dpr)
    ctx.fillStyle = 'white'
    ctx.strokeStyle = 'black'
    ctx.lineWidth = 0.65
    ctx.lineJoin = 'round'
    const profile = this.host.querySelector('.profile-panel')
    if (profile) {
      const walker = document.createTreeWalker(profile, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        const parent = node.parentElement!
        if (!node.textContent?.trim() || parent.closest('.sr-only, svg')) continue
        const style = getComputedStyle(parent)
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        for (let i = 0; i < node.length; i++) {
          const char = node.data[i]!
          if (!char.trim()) continue
          range.setStart(node, i)
          range.setEnd(node, i + 1)
          const rect = range.getBoundingClientRect()
          const metrics = ctx.measureText(char)
          const ascent = metrics.fontBoundingBoxAscent ?? Number.parseFloat(style.fontSize) * 0.8
          const descent = metrics.fontBoundingBoxDescent ?? Number.parseFloat(style.fontSize) * 0.2
          const x = rect.left - bounds.left
          const y = rect.top - bounds.top + (rect.height - ascent - descent) / 2 + ascent
          ctx.strokeText(char, x, y)
          ctx.fillText(char, x, y)
        }
      }
      for (const svg of profile.querySelectorAll<SVGSVGElement>('svg'))
        this.drawSvg(ctx, svg, bounds)
      for (const link of profile.querySelectorAll('a:hover, a:focus-visible')) {
        const rect = link.getBoundingClientRect()
        ctx.fillRect(rect.left - bounds.left, rect.bottom - bounds.top - 2, rect.width, 1)
      }
    }
    const icon = this.host.querySelector<SVGSVGElement>('.scene-info-trigger svg')
    if (icon) this.drawSvg(ctx, icon, bounds)
    this.texture.needsUpdate = true
    this.dirty = false
    return true
  }

  render(renderer: WebGLRenderer, sceneTexture: Texture) {
    if (!this.host || this.disposed) return
    const bounds = renderer.domElement.getBoundingClientRect()
    const dpr = renderer.getPixelRatio()
    if (this.width !== bounds.width || this.height !== bounds.height || this.dpr !== dpr) {
      this.width = bounds.width
      this.height = bounds.height
      this.dpr = dpr
      this.dirty = true
    }
    if (this.dirty && !this.rebuild(bounds)) return
    this.material.uniforms.tScene!.value = sceneTexture
    this.material.uniforms.uExposure!.value = renderer.toneMappingExposure
    this.material.uniforms.uSize!.value.set(this.width, this.height)
    const clear = renderer.autoClear
    renderer.autoClear = false
    try {
      renderer.render(this.scene, this.camera)
    } finally {
      renderer.autoClear = clear
    }
    this.host.dataset.uiMask = 'gpu'
    document.documentElement.dataset.uiMask = 'gpu'
  }

  invalidate() {
    this.dirty = true
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    this.observer.disconnect()
    this.dialogObserver.disconnect()
    this.texture.dispose()
    this.geometry.dispose()
    this.material.dispose()
    if (this.host) delete this.host.dataset.uiMask
    delete document.documentElement.dataset.uiMask
  }
}

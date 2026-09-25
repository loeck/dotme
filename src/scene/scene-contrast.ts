import {
  Discard,
  Fn,
  float,
  max,
  min,
  renderOutput,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CanvasTexture,
  DataTexture,
  RGBAFormat,
  LinearFilter,
  NoToneMapping,
  LinearSRGBColorSpace,
  SRGBColorSpace,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector2,
} from 'three/webgpu'
import type { Texture, WebGPURenderer } from 'three/webgpu'

/** Rasterize DOM glyph coverage only when layout changes; shade it on the GPU every frame. */
export class SceneContrast {
  private readonly canvas = document.createElement('canvas')
  private texture = new CanvasTexture(this.canvas)
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly fallback = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat)
  private readonly backdrop = texture(this.fallback)
  private readonly mask = texture(this.texture)
  private readonly exposure = uniform(1)
  private readonly size = uniform(new Vector2(1, 1))
  private readonly material = new MeshBasicNodeMaterial({
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

  private readonly host: HTMLElement | null
  private readonly redraw: () => void
  constructor(host: HTMLElement | null, redraw: () => void) {
    this.host = host
    this.redraw = redraw
    this.canvas.width = this.canvas.height = 1
    this.canvas.getContext('2d')?.clearRect(0, 0, 1, 1)
    this.fallback.needsUpdate = true
    this.material.vertexNode = vec4(uv().mul(2).sub(1), 0, 1)
    this.material.fragmentNode = Fn(() => {
      const mask = this.mask.sample(uv()),
        expanded = mask.a
      Discard(expanded.lessThan(0.002))
      const alpha = mask.r.mul(mask.a).toVar(),
        inset = vec2(0.2).div(this.size)
      for (const direction of [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1)]) {
        const neighbor = this.mask.sample(uv().add(inset.mul(direction)))
        alpha.assign(min(alpha, neighbor.r.mul(neighbor.a)))
      }
      const luminance = float(0).toVar(),
        tap = vec2(1.5).div(this.size)
      for (let y = -1; y <= 1; y++)
        for (let x = -1; x <= 1; x++) {
          const scene = this.backdrop
            .sample(uv().flipY().add(vec2(x, y).mul(tap)))
            .rgb.mul(this.exposure)
          luminance.addAssign(
            scene
              .div(scene.add(1))
              .dot(vec3(0.2126, 0.7152, 0.0722))
              .mul((x === 0 ? 0.5 : 0.25) * (y === 0 ? 0.5 : 0.25)),
          )
        }
      const ink = smoothstep(0.154, 0.204, luminance).oneMinus(),
        support = smoothstep(0.08, 0.35, ink).mul(0.7)
      const coverage = alpha.add(max(0, expanded.sub(alpha)).mul(support))
      return renderOutput(
        vec4(vec3(ink.mul(alpha).div(max(coverage, 0.001))), coverage),
        NoToneMapping,
        SRGBColorSpace,
      )
    })()

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
      for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout', 'scene-icon-change'])
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
    const width = Math.max(1, Math.ceil(bounds.width * this.dpr))
    const height = Math.max(1, Math.ceil(bounds.height * this.dpr))
    const resized = this.canvas.width !== width || this.canvas.height !== height
    this.canvas.width = width
    this.canvas.height = height
    if (resized) {
      // GPU texture storage is immutable: a viewport resize needs a new
      // allocation, not a sub-image upload into the previous dimensions.
      this.texture.dispose()
      this.texture = new CanvasTexture(this.canvas)
      this.texture.minFilter = this.texture.magFilter = LinearFilter
      this.texture.generateMipmaps = false
      this.mask.value = this.texture
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
        const node = walker.currentNode
        if (!(node instanceof Text)) continue
        const parent = node.parentElement
        if (!parent) continue
        if (!node.textContent?.trim() || parent.closest('.sr-only, svg')) continue
        const style = getComputedStyle(parent)
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        for (let i = 0; i < node.length; i++) {
          const char = node.data.charAt(i)
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
    for (const icon of this.host.querySelectorAll<SVGSVGElement>(
      '.scene-info-trigger svg, .scene-sound-trigger svg',
    ))
      this.drawSvg(ctx, icon, bounds)
    const sound = this.host.querySelector<HTMLElement>(".scene-sound-trigger[data-loading='true']")
    if (sound) {
      const rect = sound.getBoundingClientRect()
      ctx.beginPath()
      ctx.arc(rect.left - bounds.left + 22, rect.bottom - bounds.top - 6, 1.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fill()
    }
    this.texture.needsUpdate = true
    this.dirty = false
    return true
  }

  render(renderer: WebGPURenderer, sceneTexture: Texture, canvasBounds: DOMRect | null) {
    if (!this.host || this.disposed) return
    const bounds = canvasBounds ?? renderer.domElement.getBoundingClientRect()
    const dpr = renderer.getPixelRatio()
    if (this.width !== bounds.width || this.height !== bounds.height || this.dpr !== dpr) {
      this.width = bounds.width
      this.height = bounds.height
      this.dpr = dpr
      this.dirty = true
    }
    if (this.dirty && !this.rebuild(bounds)) return
    this.backdrop.value = sceneTexture
    this.exposure.value = renderer.toneMappingExposure
    this.size.value.set(this.width, this.height)
    const clear = renderer.autoClear,
      toneMapping = renderer.toneMapping,
      outputColorSpace = renderer.outputColorSpace
    renderer.toneMapping = NoToneMapping
    renderer.outputColorSpace = LinearSRGBColorSpace
    renderer.autoClear = false
    try {
      renderer.render(this.scene, this.camera)
    } finally {
      renderer.autoClear = clear
      renderer.toneMapping = toneMapping
      renderer.outputColorSpace = outputColorSpace
    }
    if (this.host.dataset.uiMask !== 'gpu') this.host.dataset.uiMask = 'gpu'
    if (document.documentElement.dataset.uiMask !== 'gpu')
      document.documentElement.dataset.uiMask = 'gpu'
  }

  invalidate() {
    this.dirty = true
  }

  async compileAsync(renderer: WebGPURenderer) {
    const toneMapping = renderer.toneMapping,
      outputColorSpace = renderer.outputColorSpace
    let compiled: Promise<void>
    try {
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = LinearSRGBColorSpace
      compiled = renderer.compileAsync(this.scene, this.camera)
    } finally {
      renderer.toneMapping = toneMapping
      renderer.outputColorSpace = outputColorSpace
    }
    await compiled
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    this.observer.disconnect()
    this.dialogObserver.disconnect()
    this.texture.dispose()
    this.fallback.dispose()
    this.geometry.dispose()
    this.material.dispose()
    if (this.host) delete this.host.dataset.uiMask
    delete document.documentElement.dataset.uiMask
  }
}

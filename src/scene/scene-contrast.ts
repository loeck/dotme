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
  Vector4,
} from 'three/webgpu'
import type { Texture, WebGPURenderer } from 'three/webgpu'

import type { SceneGrade } from './scene-grade'

/** Everything the mask draws: the profile and the two scene controls. */
const MASKED = '.profile-panel, .scene-info-trigger, .scene-sound-trigger'
/** CSS pixels around the masked elements, for strokes, underlines and the loading dot. */
const MARGIN = 8
/** Highest pixel ratio the glyph mask is drawn at. */
const MASK_MAX_PIXEL_RATIO = 2
/** How often the masked elements' geometry is compared, in ms. */
const GEOMETRY_POLL = 250

/**
 * Rasterize DOM glyph coverage only when layout changes; shade it on the GPU every frame. The
 * mask and its quad cover only the masked elements' bounding box, not the whole viewport.
 */
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
  /** Mask size in CSS pixels. */
  private readonly size = uniform(new Vector2(1, 1))
  /** Viewport size in CSS pixels. */
  private readonly viewport = uniform(new Vector2(1, 1))
  /** Masked box on the canvas: left, top, width, height, in top-down UV. */
  private readonly box = uniform(new Vector4(0, 0, 1, 1))
  /** The masked box in CSS pixels relative to the canvas, as last rasterized. */
  private readonly region = { left: 0, top: 0, width: 0, height: 0 }
  private checkedAt = -Infinity
  /**
   * The profile panel's current opacity: it fades in with the scene (index.html), and the ink
   * must fade with it rather than appear at full strength. Read every frame while it is below 1,
   * then only with the geometry poll.
   */
  private readonly fade = uniform(1)
  private fadeCheckedAt = -Infinity
  private fading = true
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
  /** `grade` lets the ink follow the graded image rather than raw scene radiance. */
  constructor(host: HTMLElement | null, redraw: () => void, grade?: SceneGrade) {
    this.host = host
    this.redraw = redraw
    this.canvas.width = this.canvas.height = 1
    this.canvas.getContext('2d')?.clearRect(0, 0, 1, 1)
    this.fallback.needsUpdate = true
    // uv() runs bottom-up over the box; `screen` is the matching top-down canvas UV.
    const screen = vec2(
      this.box.x.add(uv().x.mul(this.box.z)),
      this.box.y.add(uv().y.oneMinus().mul(this.box.w)),
    )
    this.material.vertexNode = vec4(screen.x.mul(2).sub(1), screen.y.mul(-2).add(1), 0, 1)
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
      // Four diagonal taps cover the 3×3 tent the ink used to average, graded once each.
      const luminance = float(0).toVar(),
        tap = vec2(0.75).div(this.viewport),
        edge = grade ? grade.frameEdge(screen) : float(1)
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        const radiance = this.backdrop.sample(screen.add(vec2(x, y).mul(tap))).rgb
        const scene = (grade ? grade.colour(radiance).mul(edge) : radiance).mul(this.exposure)
        luminance.addAssign(
          scene
            .div(scene.add(1))
            .dot(vec3(0.2126, 0.7152, 0.0722))
            .mul(0.25),
        )
      }
      // Switch decisively between light and dark ink over midtone clouds.
      const ink = smoothstep(0.17, 0.185, luminance).oneMinus(),
        support = smoothstep(0.08, 0.35, ink).mul(0.7)
      const coverage = alpha.add(max(0, expanded.sub(alpha)).mul(support))
      return renderOutput(
        vec4(vec3(ink.mul(alpha).div(max(coverage, 0.001))), coverage.mul(this.fade)),
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
      for (const element of host.querySelectorAll(MASKED)) this.observer.observe(element)
      // Only links change with hover (their underline); other hovers leave the glyphs alone.
      const hoverLink = (event: Event) => {
        if (event.target instanceof Element && event.target.closest('.profile-panel a'))
          invalidate()
      }
      for (const event of ['pointerover', 'pointerout'])
        host.addEventListener(event, hoverLink, { signal })
      for (const event of ['focusin', 'focusout', 'scene-icon-change'])
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

  /** Bounding box of the masked elements plus a margin, clipped to the canvas, in CSS pixels. */
  private measure(bounds: DOMRect) {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity
    for (const element of this.host?.querySelectorAll(MASKED) ?? []) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) continue
      left = Math.min(left, rect.left)
      top = Math.min(top, rect.top)
      right = Math.max(right, rect.right)
      bottom = Math.max(bottom, rect.bottom)
    }
    left = Math.max(0, Math.floor(left - bounds.left - MARGIN))
    top = Math.max(0, Math.floor(top - bounds.top - MARGIN))
    right = Math.min(bounds.width, Math.ceil(right - bounds.left + MARGIN))
    bottom = Math.min(bounds.height, Math.ceil(bottom - bounds.top + MARGIN))
    return right > left && bottom > top
      ? { left, top, width: right - left, height: bottom - top }
      : { left: 0, top: 0, width: 0, height: 0 }
  }

  private moved(bounds: DOMRect) {
    const next = this.measure(bounds),
      region = this.region
    return (
      next.left !== region.left ||
      next.top !== region.top ||
      next.width !== region.width ||
      next.height !== region.height
    )
  }

  private rebuild(canvasBounds: DOMRect) {
    if (!this.host) return false
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return false
    Object.assign(this.region, this.measure(canvasBounds))
    const region = this.region
    // Glyph positions are measured in client pixels from the box's corner.
    const bounds = new DOMRect(
      canvasBounds.left + region.left,
      canvasBounds.top + region.top,
      region.width,
      region.height,
    )
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
        const metrics = ctx.measureText('M')
        const ascent = metrics.fontBoundingBoxAscent ?? Number.parseFloat(style.fontSize) * 0.8
        const descent = metrics.fontBoundingBoxDescent ?? Number.parseFloat(style.fontSize) * 0.2
        for (let i = 0; i < node.length; i++) {
          const char = node.data.charAt(i)
          if (!char.trim()) continue
          range.setStart(node, i)
          range.setEnd(node, i + 1)
          const rect = range.getBoundingClientRect()
          const x = rect.left - bounds.left
          const y = rect.top - bounds.top + (rect.height - ascent - descent) / 2 + ascent
          ctx.strokeText(char, x, y)
          ctx.fillText(char, x, y)
        }
      }
      for (const link of profile.querySelectorAll('a:hover, a:focus-visible')) {
        const rect = link.getBoundingClientRect()
        ctx.fillRect(rect.left - bounds.left, rect.bottom - bounds.top - 2, rect.width, 1)
      }
    }
    for (const icon of this.host.querySelectorAll<SVGSVGElement>(
      '.profile-panel svg, .scene-info-trigger svg, .scene-sound-trigger svg',
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
    // The glyph mask follows the display, not the render scale: a pixel budget or a dynamic
    // resolution drop below 1 must not blur the outlines it samples.
    const dpr = Math.max(
      renderer.getPixelRatio(),
      Math.min(MASK_MAX_PIXEL_RATIO, window.devicePixelRatio > 0 ? window.devicePixelRatio : 1),
    )
    if (this.width !== bounds.width || this.height !== bounds.height || this.dpr !== dpr) {
      this.width = bounds.width
      this.height = bounds.height
      this.dpr = dpr
      this.dirty = true
    }
    // Resize observers miss moves (a sibling's layout shift); compare the box now and then.
    const now = performance.now()
    if (!this.dirty && now - this.checkedAt >= GEOMETRY_POLL) {
      this.checkedAt = now
      if (this.moved(bounds)) this.dirty = true
    }
    if (this.dirty && !this.rebuild(bounds)) return
    if (this.fading || now - this.fadeCheckedAt >= GEOMETRY_POLL) this.updateFade(now)
    const region = this.region
    if (!region.width || !region.height) return
    this.backdrop.value = sceneTexture
    this.exposure.value = renderer.toneMappingExposure
    this.size.value.set(region.width, region.height)
    this.viewport.value.set(this.width, this.height)
    this.box.value.set(
      region.left / this.width,
      region.top / this.height,
      region.width / this.width,
      region.height / this.height,
    )
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

  private updateFade(now: number) {
    this.fadeCheckedAt = now
    const panel = this.host?.querySelector('.profile-panel')
    const opacity = panel ? Number.parseFloat(getComputedStyle(panel).opacity) : 1
    this.fade.value = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1
    this.fading = this.fade.value < 1
    // Keep the frames coming while the panel fades, even when nothing else asks for one.
    if (this.fading) this.redraw()
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

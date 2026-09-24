import { positionLocal, renderOutput, vec4 } from 'three/tsl'
import {
  BufferGeometry,
  Float32BufferAttribute,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  NodeMaterial,
  OrthographicCamera,
  Scene,
} from 'three/webgpu'
import type { Node, RenderTarget, WebGPURenderer } from 'three/webgpu'

export type FullscreenRenderer = Pick<
  WebGPURenderer,
  | 'toneMapping'
  | 'outputColorSpace'
  | 'getRenderTarget'
  | 'getActiveCubeFace'
  | 'getActiveMipmapLevel'
  | 'setRenderTarget'
  | 'compileAsync'
  | 'render'
> & { readonly xr: { enabled: boolean } }

/** An explicit fullscreen pass whose exact material can be prepared asynchronously. */
export class FullscreenPass {
  private readonly geometry = new BufferGeometry()
  private readonly material = new NodeMaterial()
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly renderer: FullscreenRenderer
  private readonly output: Node<'vec4'>
  private readonly transformOutput: boolean
  private toneMapping
  private outputColorSpace

  constructor(renderer: FullscreenRenderer, output: Node<'vec4'>, transformOutput = false) {
    this.renderer = renderer
    this.material.depthTest = false
    this.material.depthWrite = false
    this.material.toneMapped = false
    this.material.fog = false
    this.output = output
    this.transformOutput = transformOutput
    this.toneMapping = renderer.toneMapping
    this.outputColorSpace = renderer.outputColorSpace
    // One triangle, with canonical top-left texture coordinates on both backends.
    this.geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
    )
    this.geometry.setAttribute('uv', new Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2))
    this.material.vertexNode = vec4(positionLocal, 1)
    this.updateOutput()
    const mesh = new Mesh(this.geometry, this.material)
    mesh.frustumCulled = false
    this.scene.add(mesh)
  }

  private updateOutput() {
    this.material.fragmentNode = this.transformOutput
      ? renderOutput(this.output, this.toneMapping, this.outputColorSpace)
      : this.output
    this.material.needsUpdate = true
  }

  private withLinearOutput<T>(action: () => T): T {
    const renderer = this.renderer
    const toneMapping = renderer.toneMapping,
      outputColorSpace = renderer.outputColorSpace,
      xr = renderer.xr.enabled
    if (this.toneMapping !== toneMapping || this.outputColorSpace !== outputColorSpace) {
      this.toneMapping = toneMapping
      this.outputColorSpace = outputColorSpace
      if (this.transformOutput) this.updateOutput()
    }
    renderer.toneMapping = NoToneMapping
    renderer.outputColorSpace = LinearSRGBColorSpace
    renderer.xr.enabled = false
    try {
      return action()
    } finally {
      renderer.toneMapping = toneMapping
      renderer.outputColorSpace = outputColorSpace
      renderer.xr.enabled = xr
    }
  }

  compileAsync(target: RenderTarget | null): Promise<void> {
    const renderer = this.renderer
    const previous = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel()
    try {
      renderer.setRenderTarget(target)
      return this.withLinearOutput(() => renderer.compileAsync(this.scene, this.camera))
    } finally {
      // The loader uses the same renderer while shader compilation yields.
      renderer.setRenderTarget(previous, face, mip)
    }
  }

  render() {
    this.withLinearOutput(() => this.renderer.render(this.scene, this.camera))
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

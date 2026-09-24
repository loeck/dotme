import { Fn, varying, vec3 } from 'three/tsl'
import type { Node, NodeBuilder, Renderer } from 'three/webgpu'

export const rendersWithWebGL = (renderer: Pick<Renderer, 'backend'>) =>
  'isWebGLBackend' in renderer.backend
const webgpu = (builder: NodeBuilder) => !rendersWithWebGL(builder.renderer)

/** Maps a sampled depth-buffer value to the clip-space Z its projection expects. */
export const clipDepth = Fn(([depth]: [Node<'float'>], builder: NodeBuilder) =>
  webgpu(builder) ? depth : depth.mul(2).sub(1),
)

/** Maps a clip-space Z to the value a fragment writes to the depth buffer. */
export const fragmentDepth = Fn(([z]: [Node<'float'>], builder: NodeBuilder) =>
  webgpu(builder) ? z : z.mul(0.5).add(0.5),
)

/**
 * A varying interpolated linearly in screen space. GLSL ES 3.00 has no
 * `noperspective`, so WebGL interpolates value·w and w and divides them.
 */
export const screenLinearVarying = (value: Node<'vec2'>, clipW: Node<'float'>, name: string) =>
  Fn((builder: NodeBuilder) => {
    if (webgpu(builder)) return varying(value, name).setInterpolation('linear')
    const weighted = varying(vec3(value.mul(clipW), clipW), name)
    return weighted.xy.div(weighted.z)
  })()

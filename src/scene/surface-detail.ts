import { normalView, normalWorldGeometry, positionView, positionWorld, texture } from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { SurfaceScan } from './terrain-textures'

/** Three world projections keep cliff faces and rounded rocks from stretching a top-down map. */
export function triplanarScan(scan: SurfaceScan, scale: number) {
  const p = positionWorld.mul(scale)
  const axes = normalWorldGeometry.abs().pow(4)
  const weights = axes.div(axes.x.add(axes.y).add(axes.z).max(0.0001))
  const sample = (map: SurfaceScan['color']) => {
    const node = texture(map)
    return node
      .sample(p.yz)
      .mul(weights.x)
      .add(node.sample(p.xz).mul(weights.y))
      .add(node.sample(p.xy).mul(weights.z))
  }
  return { color: sample(scan.color).rgb, surface: sample(scan.surface).rg }
}

/** Differentiate world-space relief after projection so mesh triangles never print through. */
export function surfaceGradientNormal(
  height: Node<'float'>,
  strength: Node<'float'>,
  base: Node<'vec3'> = normalView,
) {
  const dpdx = positionView.dFdx()
  const dpdy = positionView.dFdy()
  const r1 = dpdy.cross(base)
  const r2 = base.cross(dpdx)
  const det = dpdx.dot(r1)
  const gradient = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)))
  return det.abs().max(0.00000001).mul(base).sub(gradient.mul(strength)).normalize()
}

import type { LightingModelDirectInput } from 'three/src/nodes/core/LightingModel.js'
import {
  dFdx,
  dFdy,
  diffuseColor,
  float,
  max,
  min,
  mix,
  nodeObject,
  normalView,
  normalize,
  positionViewDirection,
  vec3,
} from 'three/tsl'
import { ConvertNode, LightingModel, Node } from 'three/webgpu'
import type { NodeBuilder } from 'three/webgpu'

export const WATER_IOR = 1.333

const vector = (node: Node) => nodeObject(new ConvertNode<'vec3'>(node, 'vec3'))

/** Preserve the original water BRDF, with live Three lights and their shadow nodes. */
export class WaterLightingModel extends LightingModel {
  foamNode: Node<'float'> = float(0)
  roughnessNode: Node<'float'> = float(0.035)
  worldNormalNode: Node<'vec3'> = vec3(0, 1, 0)

  override direct({ lightDirection, lightColor, reflectedLight }: LightingModelDirectInput) {
    const normal = normalView,
      view = positionViewDirection,
      direction = vector(lightDirection),
      radiance = vector(lightColor)
    const nl = max(normal.dot(direction), 0)
    const nv = max(normal.dot(view), 0.001)
    const halfway = normalize(direction.add(view))
    const nh = max(normal.dot(halfway), 0)
    const vh = max(view.dot(halfway), 0)
    const dx = dFdx(this.worldNormalNode),
      dy = dFdy(this.worldNormalNode)
    const filtered = this.roughnessNode
      .pow(2)
      .add(min(0.025, dx.dot(dx).add(dy.dot(dy)).mul(0.25)))
      .sqrt()
    // The original roughness is GGX alpha, not perceptual roughness squared.
    const alpha = mix(filtered, 0.4, this.foamNode)
    const a2 = alpha.pow(2)
    const denominator = nh.pow(2).mul(a2.sub(1)).add(1)
    const distribution = a2.div(max(denominator.pow(2).mul(Math.PI), 0.000001))
    const visibility = float(0.5).div(
      max(
        nl
          .mul(nv.pow(2).mul(float(1).sub(a2)).add(a2).sqrt())
          .add(nv.mul(nl.pow(2).mul(float(1).sub(a2)).add(a2).sqrt())),
        0.0001,
      ),
    )
    const fresnel = float(1).sub(vh).pow(5).mul(0.9796).add(0.0204)
    vector(reflectedLight.directSpecular).addAssign(
      radiance
        .mul(nl)
        .mul(distribution)
        .mul(visibility)
        .mul(fresnel)
        .mul(float(1).sub(this.foamNode)),
    )
    vector(reflectedLight.directDiffuse).addAssign(
      diffuseColor.rgb.mul(radiance).mul(nl).div(Math.PI),
    )
  }

  override indirect(builder: NodeBuilder) {
    const context = builder.context
    if (
      !context ||
      typeof context !== 'object' ||
      !('irradiance' in context) ||
      !(context.irradiance instanceof Node) ||
      !('reflectedLight' in context)
    )
      throw new Error('Missing water lighting context')
    const reflected = context.reflectedLight
    if (
      !reflected ||
      typeof reflected !== 'object' ||
      !('indirectDiffuse' in reflected) ||
      !(reflected.indirectDiffuse instanceof Node)
    )
      throw new Error('Missing water diffuse lighting')
    // Ambient foam in the original shader is not attenuated by an extra 1/pi.
    vector(reflected.indirectDiffuse).addAssign(vector(context.irradiance).mul(diffuseColor.rgb))
  }
}

import {
  attribute,
  float,
  fract,
  mix,
  modelViewMatrix,
  normalize,
  positionGeometry,
  positionViewDirection,
  sin,
  smoothstep,
  transformDirection,
  transpose,
  varying,
  vec3,
} from 'three/tsl'
import {
  Box3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { Node } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import type { VoxelWaterfall } from './voxel-world'

const GRAVITY = 9.81
const IMPACT_OFFSET = 0.8
const SOURCE_DEPTH = 0.2
const MAX_STRETCH = 2.4
const MAX_RADIUS = 0.06 * 1.12

/** A volume of overlapping parcels in the waterfall group's local coordinates. */
export function createWaterfallParticles(
  fall: VoxelWaterfall,
  mobile: boolean,
  time: Node<'float'>,
) {
  const count = mobile ? 900 : 2200
  const height = Math.max(SOURCE_DEPTH, fall.top - WATER_LEVEL)
  const origins = new Float32Array(count * 4)
  const dynamics = new Float32Array(count * 4)
  let state = (fall.seed ^ 0x573ca2e9) >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  for (let i = 0; i < count; i++) {
    const radius = 0.035 + random() * 0.025
    // The entire new parcel lies under the basin surface, within its water depth.
    const depth = radius + random() * (SOURCE_DEPTH - radius * 2)
    const startHeight = height - depth
    const impactTime = Math.sqrt((2 * startHeight) / GRAVITY)
    origins.set(
      [
        (random() - 0.5) * Math.max(0, fall.width - radius * 2),
        startHeight,
        (random() - 0.5) * 0.05,
        radius,
      ],
      i * 4,
    )
    dynamics.set([random(), (random() - 0.5) * 0.22, (random() - 0.5) * 0.32, impactTime], i * 4)
  }

  const sphere = new SphereGeometry(1, mobile ? 6 : 8, mobile ? 4 : 6)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(sphere.getIndex())
  for (const [name, buffer] of Object.entries(sphere.attributes))
    geometry.setAttribute(name, buffer)
  geometry.setAttribute('aWaterfallOrigin', new InstancedBufferAttribute(origins, 4))
  geometry.setAttribute('aWaterfallDynamics', new InstancedBufferAttribute(dynamics, 4))
  geometry.instanceCount = count
  sphere.dispose()

  const origin = attribute('aWaterfallOrigin', 'vec4')
  const dynamicsNode = attribute('aWaterfallDynamics', 'vec4')
  // Recycle only after the ellipsoid is fully submerged; each parcel has its own
  // random phase and lifetime, so no horizontal emission rows appear.
  const lifetime = origin.y
    .add(origin.w.mul(1.12 * MAX_STRETCH))
    .mul(2 / GRAVITY)
    .sqrt()
  const age = fract(time.div(lifetime).add(dynamicsNode.x)).mul(lifetime)
  const emission = time.sub(age)
  const descent = age.div(dynamicsNode.w).clamp(0, 1)
  const release = smoothstep(0.08, 0.85, descent)
  // Nearby parcels share a slowly changing discharge pattern. The pattern is
  // attached to emission time, and consequently accelerates with the water.
  const packet = sin(emission.mul(13).add(origin.x.mul(7.3)))
    .mul(0.5)
    .add(0.5)
  const radiusNode = origin.w.mul(mix(1, mix(0.9, 1.12, packet), release))
  const stretch = mix(1, MAX_STRETCH, release)
  const forwardSpeed = float(IMPACT_OFFSET).div(dynamicsNode.w).add(dynamicsNode.z)
  const tangent = normalize(vec3(0, age.mul(-GRAVITY), forwardSpeed))
  // This basis has positive determinant, preserving front-face winding.
  const normal = vec3(0, tangent.z.negate(), tangent.y)
  const widthPulse = sin(emission.mul(3.1)).mul(0.025).add(0.975)
  const centre = vec3(
    origin.x.mul(widthPulse).add(dynamicsNode.y.mul(age)),
    origin.y.sub(age.mul(age).mul(GRAVITY / 2)),
    origin.z.add(age.mul(forwardSpeed)),
  )
  const section = vec3(positionGeometry.x, 0, 0)
    .add(tangent.mul(positionGeometry.y.mul(stretch)))
    .add(normal.mul(positionGeometry.z))
  const positionNode = centre.add(section.mul(radiusNode))
  // Undo the rigid model/view transform, then the ellipsoid's local stretch.
  // A line through a unit-sphere surface point has chord -2(p·d)/(d·d).
  const unitSurface = normalize(varying(positionGeometry))
  const localRay = transformDirection(positionViewDirection, transpose(modelViewMatrix))
  const scaledRay = vec3(localRay.x, localRay.dot(tangent).div(stretch), localRay.dot(normal)).div(
    radiusNode,
  )
  const chordNode = unitSurface.dot(scaledRay).abs().mul(2).div(scaledRay.dot(scaledRay))
  const aerationNode = smoothstep(0.12, 1, descent)
    .mul(mix(0.45, 1, packet))
    .clamp(0, 1)

  const longRadius = MAX_RADIUS * MAX_STRETCH
  const durationBound = Math.sqrt((2 * (height + longRadius)) / GRAVITY)
  const minimumImpactTime = Math.sqrt((2 * (height - SOURCE_DEPTH + 0.035)) / GRAVITY)
  const bounds = new Box3(
    new Vector3(
      -fall.width / 2 - durationBound * 0.11 - MAX_RADIUS,
      -longRadius * 2,
      -longRadius - 0.025,
    ),
    new Vector3(
      fall.width / 2 + durationBound * 0.11 + MAX_RADIUS,
      height + longRadius,
      0.025 + durationBound * (IMPACT_OFFSET / minimumImpactTime + 0.16) + longRadius,
    ),
  )
  geometry.boundingBox = bounds.clone()
  geometry.boundingSphere = bounds.getBoundingSphere(new Sphere())
  return { geometry, positionNode, aerationNode, chordNode, bounds }
}

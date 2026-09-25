import {
  attribute,
  cross,
  float,
  modelViewMatrix,
  normalize,
  positionGeometry,
  positionViewDirection,
  smoothstep,
  transformDirection,
  transpose,
  varying,
  vec3,
} from 'three/tsl'
import {
  Box3,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import type { VoxelWaterfall } from './voxel-world'

const GRAVITY = 9.81
const IMPACT_OFFSET = 0.8
const SOURCE_DEPTH = 0.2
const MAX_STRETCH = 2.4
const MAX_RADIUS = 0.06 * 1.12

/** Parcel slots; Rapier owns their motion, slots keep their size across recycles. */
export function curtainParcelCount(mobile: boolean) {
  return mobile ? 900 : 2200
}

/**
 * A volume of overlapping parcels in the waterfall group's local coordinates,
 * driven by Rapier bodies. Positions, velocities and blocker foam stream in
 * every frame; the cursor hole is a real absence of bodies.
 */
export function createWaterfallParticles(fall: VoxelWaterfall, mobile: boolean) {
  const count = curtainParcelCount(mobile)
  const height = Math.max(SOURCE_DEPTH, fall.top - WATER_LEVEL)
  const sizes = new Float32Array(count)
  let state = (fall.seed ^ 0x573ca2e9) >>> 0
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    sizes[i] = 0.035 + (state / 0x1_0000_0000) * 0.025
  }

  const sphere = new SphereGeometry(1, mobile ? 6 : 8, mobile ? 4 : 6)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(sphere.getIndex())
  for (const [name, buffer] of Object.entries(sphere.attributes))
    geometry.setAttribute(name, buffer)
  geometry.setAttribute('aBodySize', new InstancedBufferAttribute(sizes, 1))
  const positions = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
  positions.setUsage(DynamicDrawUsage)
  geometry.setAttribute('aBodyPosition', positions)
  const velocities = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
  velocities.setUsage(DynamicDrawUsage)
  geometry.setAttribute('aBodyVelocity', velocities)
  const foam = new InstancedBufferAttribute(new Float32Array(count), 1)
  foam.setUsage(DynamicDrawUsage)
  geometry.setAttribute('aBodyFoam', foam)
  geometry.instanceCount = count
  sphere.dispose()

  const radiusNode = attribute('aBodySize', 'float')
  const centre = attribute('aBodyPosition', 'vec3')
  const velocity = attribute('aBodyVelocity', 'vec3')
  const speed = velocity.length()
  const tangent = normalize(velocity.add(vec3(0, -0.0001, 0)))
  // Gram-Schmidt against the across axis; matches the old YZ basis when the
  // lateral drift is zero, with a positive determinant either way.
  const side = normalize(vec3(1, 0, 0).sub(tangent.mul(tangent.x)))
  const up = cross(side, tangent)
  const stretch = float(1).add(speed.mul(0.28).clamp(0, MAX_STRETCH - 1))
  const section = side
    .mul(positionGeometry.x)
    .add(tangent.mul(positionGeometry.y.mul(stretch)))
    .add(up.mul(positionGeometry.z))
  const positionNode = centre.add(section.mul(radiusNode))
  // Undo the rigid model/view transform, then the ellipsoid's local stretch.
  // A line through a unit-sphere surface point has chord -2(p·d)/(d·d).
  const unitSurface = normalize(varying(positionGeometry))
  const localRay = transformDirection(positionViewDirection, transpose(modelViewMatrix))
  const scaledRay = vec3(
    localRay.dot(side),
    localRay.dot(tangent).div(stretch),
    localRay.dot(up),
  ).div(radiusNode)
  const chordNode = unitSurface.dot(scaledRay).abs().mul(2).div(scaledRay.dot(scaledRay))
  const aerationNode = smoothstep(0.5, 5, speed)
    .add(attribute('aBodyFoam', 'float').mul(0.85))
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
  return { geometry, positionNode, aerationNode, chordNode, bounds, count, sizes }
}

import type { Collider, RigidBody, Vector } from '@dimforge/rapier3d-compat'
import {
  attribute,
  cross,
  dFdx,
  dFdy,
  float,
  fract,
  Fn,
  mix,
  normalize,
  positionLocal,
  positionView,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  SphereGeometry,
} from 'three/webgpu'
import type { Camera, Node, NodeBuilder, Scene, WebGPURenderer } from 'three/webgpu'

import { required } from '../invariant'
import { WATER_LEVEL } from './lake-bed'
import type { SplashJet, WaterfallImpact } from './lake-splashes'
import type { LakeWaterMaterial } from './lake-water'
import type { PhysicsWorld } from './physics-world'
import { ResourceScope } from './resource-scope'
import type { VoxelWaterfall } from './voxel-world'
import { contactNoise } from './water-noise'
import { fieldUvNode, sampleWindField, windFieldNode } from './water-surface'
import { waterfallDrift } from './waterfall-flow'
import { WaterfallFluid } from './waterfall-fluid'
import type { WindState } from './wind'

const GRAVITY = 9.81
const IMPACT_OFFSET = 0.8
/** Curtain bodies strike the cursor blocker only; terrain and droplets ignore them. */
const CURTAIN_GROUPS = (0x0008 << 16) | 0x0010
const BLOCKER_GROUPS = (0x0010 << 16) | 0x0008
/** Vertical capsule: a velocity-stretched hole, not a round dent. */
const BLOCKER_HALF_HEIGHT = 0.16
const KILL_DEPTH = 0.05
const EXIT_LIFT = 0.1

function smoothstepCpu(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Deform before Three applies instancing and computes world/view positions. */
class FallingWaterMaterial extends MeshStandardNodeMaterial {
  flowPosition: Node<'vec3'> | null = null
  override setupPosition(builder: NodeBuilder) {
    if (this.flowPosition) positionLocal.assign(this.flowPosition)
    return super.setupPosition(builder)
  }
}

const createMaterial = () =>
  new FallingWaterMaterial({
    color: 0xb0c5c5,
    roughness: 0.13,
    metalness: 0,
    envMapIntensity: 0.8,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    forceSinglePass: true,
  })

/** Particle-based falling water, a churning foot and bounded spray and mist. */
export class LakeWaterfall {
  readonly group = new Group()
  readonly materials: readonly MeshStandardNodeMaterial[]
  /** Body-driven parcels; positions stream in after every world step. */
  get curtain() {
    return this.fluid.particles
  }
  private readonly resources = new ResourceScope()
  private readonly time = uniform(0)
  private readonly opacity = uniform(0)
  private readonly fall: VoxelWaterfall
  private readonly emitJet: (jet: SplashJet) => void
  private readonly emitImpact: (impact: WaterfallImpact, wind: WindState) => void
  private readonly physics: PhysicsWorld
  private readonly impactMaterials: readonly FallingWaterMaterial[]
  private readonly fluid: WaterfallFluid
  private readonly reducedMotion: boolean
  private curtainState: number
  private lastTime: number | undefined
  private currentWind: WindState | undefined
  private readonly impactPulse = uniform(0)
  private readonly previousHeights: Float32Array
  private readonly impactBins = Array.from({ length: 3 }, () => ({
    count: 0,
    x: 0,
    z: 0,
    speed: 0,
    lastTime: -1,
  }))
  private lastFragmentTime = -1
  private readonly bodies: RigidBody[] = []
  private readonly blockerBody: RigidBody
  private readonly blockerCollider: Collider
  private readonly born: Float64Array
  private readonly phases: Float32Array
  private readonly sizes: Float32Array
  private readonly positions: Float32Array
  private readonly velocities: Float32Array
  private readonly foams: Float32Array
  private readonly positionsAttribute: InstancedBufferAttribute
  private readonly velocitiesAttribute: InstancedBufferAttribute
  private readonly foamsAttribute: InstancedBufferAttribute
  private readonly directionX: number
  private readonly directionZ: number
  private readonly sheetHeight: number
  private readonly maxAge: number
  private blockAcross = 0
  private blockHeight = 0
  private blockRadius = 0.45
  private blockStrength = 0
  private blockerActive = false
  private blockerRadius = 0
  private blockerPlaneZ = 0
  private readonly translationTarget: Vector = { x: 0, y: 0, z: 0 }
  private readonly velocityTarget: Vector = { x: 0, y: 0, z: 0 }
  private readonly forceTarget: Vector = { x: 0, y: 0, z: 0 }
  private disposed = false

  constructor(
    scene: Scene,
    fall: VoxelWaterfall,
    mobile: boolean,
    reducedMotion: boolean,
    emitJet: (jet: SplashJet) => void,
    physics: PhysicsWorld,
    emitImpact: (impact: WaterfallImpact, wind: WindState) => void,
  ) {
    this.fall = fall
    this.reducedMotion = reducedMotion
    this.emitJet = emitJet
    this.emitImpact = emitImpact
    this.physics = physics
    this.curtainState = (fall.seed ^ 0x51ab3c7d) >>> 0
    const length = Math.hypot(fall.direction[0], fall.direction[1]) || 1
    this.directionX = fall.direction[0] / length
    this.directionZ = fall.direction[1] / length
    this.sheetHeight = Math.max(0.2, fall.top - WATER_LEVEL)
    this.maxAge = this.flightTime(this.sheetHeight) * 1.5 + 0.5
    try {
      this.group.name = 'lake-waterfall'
      this.group.position.set(fall.x, WATER_LEVEL, fall.z)
      this.group.rotation.y = Math.atan2(fall.direction[0], fall.direction[1])
      let state = (fall.seed ^ 0x6e624eb7) >>> 0
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 0x1_0000_0000
      }
      const foam = this.resources.own(createMaterial()),
        spray = this.resources.own(createMaterial()),
        basin = this.resources.own(createMaterial()),
        mist = this.resources.own(createMaterial())
      this.fluid = this.resources.own(new WaterfallFluid(fall, mobile, this.opacity))
      this.materials = [this.fluid.material, foam, spray, basin, mist]
      const parcels = this.fluid.particles
      this.sizes = parcels.sizes
      const slots = parcels.count
      this.previousHeights = new Float32Array(slots)
      this.born = new Float64Array(slots)
      this.phases = new Float32Array(slots)
      const streamedPositions = parcels.geometry.getAttribute('aBodyPosition')
      const streamedVelocities = parcels.geometry.getAttribute('aBodyVelocity')
      const streamedFoams = parcels.geometry.getAttribute('aBodyFoam')
      if (
        !(streamedPositions instanceof InstancedBufferAttribute) ||
        !(streamedVelocities instanceof InstancedBufferAttribute) ||
        !(streamedFoams instanceof InstancedBufferAttribute) ||
        !(streamedPositions.array instanceof Float32Array) ||
        !(streamedVelocities.array instanceof Float32Array) ||
        !(streamedFoams.array instanceof Float32Array)
      )
        throw new Error('Missing curtain body attributes')
      this.positions = streamedPositions.array
      this.velocities = streamedVelocities.array
      this.foams = streamedFoams.array
      this.positionsAttribute = streamedPositions
      this.velocitiesAttribute = streamedVelocities
      this.foamsAttribute = streamedFoams
      const { ColliderDesc, RigidBodyDesc } = this.physics.rapier
      for (let i = 0; i < slots; i++) {
        const seed = this.lipSeed(i)
        const age = seed.age * this.flightTime(seed.y)
        const body = this.physics.world.createRigidBody(
          RigidBodyDesc.dynamic()
            .setTranslation(
              ...this.worldPoint(
                seed.x + seed.vx * age,
                seed.y + EXIT_LIFT * age - (GRAVITY / 2) * age * age,
                seed.z + seed.vz * age,
              ),
            )
            .setLinvel(...this.worldDirection(seed.vx, EXIT_LIFT - GRAVITY * age, seed.vz))
            .setLinearDamping(1)
            .setCanSleep(false),
        )
        this.physics.world.createCollider(
          ColliderDesc.ball(required(this.sizes[i]))
            .setDensity(1000)
            .setRestitution(0.05)
            .setFriction(0.05)
            .setCollisionGroups(CURTAIN_GROUPS),
          body,
        )
        this.bodies.push(body)
        this.born[i] = -age
        this.phases[i] = seed.phase
      }
      this.blockerBody = this.physics.world.createRigidBody(
        RigidBodyDesc.kinematicPositionBased()
          .setTranslation(fall.x, WATER_LEVEL - 50, fall.z)
          .setEnabled(false),
      )
      this.blockerCollider = this.physics.world.createCollider(
        ColliderDesc.capsule(BLOCKER_HALF_HEIGHT, 0.05).setCollisionGroups(BLOCKER_GROUPS),
        this.blockerBody,
      )
      this.syncCurtain()
      this.group.add(this.fluid.mesh)
      this.impactMaterials = [foam, spray, mist]
      const height = Math.max(0.1, fall.top - WATER_LEVEL)
      // Basin cells share world edges; transform them into the waterfall's local frame.
      const [forwardX, forwardZ] = fall.direction
      const positions: number[] = [],
        normals: number[] = [],
        coordinates: number[] = [],
        indices: number[] = []
      const quad = (x0: number, z0: number, x1: number, z1: number, y0 = height, y1 = height) => {
        const start = positions.length / 3
        for (const [x, y, z] of [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y1, z1],
          [x0, y1, z1],
        ] as const) {
          positions.push(x, y, z)
          normals.push(0, 1, 0)
          coordinates.push(x, z)
        }
        indices.push(start, start + 2, start + 1, start, start + 3, start + 2)
      }
      for (const cell of fall.basin) {
        const x = (cell.x - fall.x) * forwardZ - (cell.z - fall.z) * forwardX
        const z = (cell.x - fall.x) * forwardX + (cell.z - fall.z) * forwardZ
        const half = cell.size / 2
        for (let row = 0; row < 2; row++) {
          for (let column = 0; column < 2; column++) {
            const x0 = x - half + column * half
            const z0 = z - half + row * half
            quad(x0, z0, x0 + half, z0 + half)
          }
        }
      }
      // The terrain face ends three centimetres behind the free-falling water.
      quad(-fall.width / 2, -0.04, fall.width / 2, 0)
      // A shallow curved lip overlaps the first parcel centres and hides the seam.
      for (let column = 0; column < 12; column++) {
        const x0 = (column / 12 - 0.5) * fall.width
        const x1 = ((column + 1) / 12 - 0.5) * fall.width
        quad(x0, 0, x1, 0.07, height, height - 0.035)
        quad(x0, 0.07, x1, 0.15, height - 0.035, height - 0.095)
      }
      const basinGeometry = this.resources.own(new BufferGeometry())
      basinGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
      basinGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
      basinGeometry.setAttribute('uv', new BufferAttribute(new Float32Array(coordinates), 2))
      basinGeometry.setIndex(indices)
      const basinPoint = uv()
      const approach = float(1).sub(smoothstep(0.1, 1.4, basinPoint.y.abs()))
      const flowWidth = basinPoint.y.abs().mul(0.35).add(1)
      const basinNoise = contactNoise(
        vec2(basinPoint.x.div(flowWidth).mul(6), basinPoint.y.mul(2).sub(this.time.mul(0.7))),
      )
      const filament = smoothstep(0.55, 0.82, basinNoise).mul(approach)
      const ripple = sin(
        positionLocal.x.mul(4.7).add(positionLocal.z.mul(3.1)).sub(this.time.mul(1.3)),
      )
        .add(
          sin(positionLocal.x.mul(-2.8).add(positionLocal.z.mul(5.3)).sub(this.time.mul(1.7))).mul(
            0.5,
          ),
        )
        .mul(0.004)
        .mul(smoothstep(0, 0.3, positionLocal.z.abs()))
      const lipMotion = smoothstep(0, 0.12, positionLocal.z)
        .mul(sin(positionLocal.x.mul(9).sub(this.time.mul(3.1))))
        .mul(0.006)
      basin.flowPosition = positionLocal.add(vec3(0, ripple.add(lipMotion), 0))
      basin.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)))
      basin.colorNode = mix(vec3(0.3, 0.43, 0.44), vec3(0.55, 0.66, 0.67), filament.mul(0.4))
      basin.roughnessNode = mix(0.08, 0.2, filament)
      basin.opacityNode = mix(0.76, 0.9, filament).mul(this.opacity)
      this.add(basinGeometry, basin, 'waterfall-basin')
      const exitSpeed = 0.35
      const duration =
        (Math.sqrt(exitSpeed * exitSpeed + 2 * GRAVITY * height) - exitSpeed) / GRAVITY
      const p = uv()

      const foamPoint = p.sub(vec2(0.5, 0.38)).mul(vec2(2, 2.2))
      const foamRadius = foamPoint.length()
      const foamNoise = contactNoise(
        p.mul(vec2(fall.width * 10, 12)).add(vec2(this.time.mul(0.32), this.time.mul(-1.4))),
      )
      const churn = float(1).sub(smoothstep(0.1, 0.85, foamRadius))
      foam.flowPosition = vec3(
        p.x.sub(0.5).mul(fall.width * 1.9),
        churn.mul(mix(0.04, 0.14, foamNoise)).add(0.018),
        p.y.sub(0.38).mul(1.9).add(IMPACT_OFFSET),
      )
      foam.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)))
      foam.colorNode = mix(vec3(0.68, 0.8, 0.8), vec3(0.94, 0.98, 0.97), foamNoise)
      foam.roughness = 0.6
      foam.opacityNode = churn
        .mul(mix(0.55, 1, smoothstep(0.2, 0.7, foamNoise)))
        .mul(mix(0.28, 1, this.impactPulse))
        .mul(float(1).sub(smoothstep(0.85, 1.05, foamRadius)))
        .mul(this.opacity)
      const foamGeometry = this.resources.own(
        new PlaneGeometry(1, 1, mobile ? 12 : 20, mobile ? 10 : 16),
      )
      this.add(foamGeometry, foam, 'waterfall-foot')

      // Foot jets are Rapier bodies now; only the detached side streams stay analytic.
      const count = mobile ? 12 : 20
      const edgeDrops = new Float32Array(count)
      const sources = new Float32Array(count * 4),
        motions = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        edgeDrops[i] = i % 2 === 0 ? 1 : -1
        sources.set(
          [(random() - 0.5) * fall.width, random(), 0.012 + random() * 0.02, random() * 0.18],
          i * 4,
        )
        motions.set(
          [
            (random() - 0.5) * 1.8,
            1.4 + random() * 1.65,
            0.25 + random() * 0.95,
            0.65 + random() * 0.35,
          ],
          i * 4,
        )
      }
      const sprayGeometry = this.instanced(new PlaneGeometry(1, 1))
      sprayGeometry.setAttribute('aSource', new InstancedBufferAttribute(sources, 4))
      sprayGeometry.setAttribute('aMotion', new InstancedBufferAttribute(motions, 4))
      sprayGeometry.setAttribute('aEdge', new InstancedBufferAttribute(edgeDrops, 1))
      sprayGeometry.instanceCount = count
      const source = attribute('aSource', 'vec4'),
        motion = attribute('aMotion', 'vec4'),
        edge = attribute('aEdge', 'float')
      const life = motion.y.mul(2 / GRAVITY)
      const dropAge = fract(this.time.div(life).add(source.y)).mul(life)
      const dropCenter = vec3(
        source.x.add(motion.x.mul(dropAge)),
        motion.y
          .mul(dropAge)
          .sub(dropAge.mul(dropAge).mul(GRAVITY / 2))
          .add(0.03),
        float(IMPACT_OFFSET).add(source.w).add(motion.z.mul(dropAge)),
      )
      const edgeAge = fract(this.time.div(duration).add(source.y)).mul(duration)
      const edgeDown = edgeAge
        .mul(exitSpeed)
        .add(edgeAge.mul(edgeAge).mul(GRAVITY / 2))
        .div(height)
      const detachedCenter = vec3(
        edge.mul(edgeDown.mul(0.06).add(0.47)).mul(fall.width).add(motion.x.mul(edgeAge).mul(0.05)),
        float(1).sub(edgeDown).mul(height),
        edgeAge.div(duration).mul(IMPACT_OFFSET).add(source.w.mul(edgeDown)),
      )
      const center = edge.abs().greaterThan(0).select(detachedCenter, dropCenter)
      spray.flowPosition = center.add(
        positionLocal.mul(vec3(source.z, source.z.mul(1.8), source.z)),
      )
      spray.colorNode = vec3(0.9, 0.96, 0.96)
      const footFade = smoothstep(0, 0.025, dropAge).mul(
        float(1).sub(smoothstep(life.mul(0.75), life, dropAge)),
      )
      const edgeFade = smoothstep(0.12, 0.25, edgeDown).mul(
        float(1).sub(smoothstep(0.86, 1, edgeDown)),
      )
      spray.opacityNode = mix(footFade, edgeFade, edge.abs())
        .mul(motion.w)
        .mul(float(1).sub(smoothstep(0.3, 1, p.sub(0.5).mul(2).length())))
        .mul(this.opacity)
      this.add(sprayGeometry, spray, 'waterfall-droplets')

      // Soft, spatial puffs surround the lower flow and impact. Spherical geometry
      // and a view-dependent chord fade give depth without a fullscreen fog pass.
      const mistCount = mobile ? 12 : 22
      const mistSeeds = new Float32Array(mistCount * 4)
      for (let i = 0; i < mistCount; i++)
        mistSeeds.set([(random() - 0.5) * fall.width * 1.25, random(), random(), random()], i * 4)
      const mistGeometry = this.instanced(new SphereGeometry(1, mobile ? 8 : 12, mobile ? 6 : 8))
      mistGeometry.setAttribute('aMist', new InstancedBufferAttribute(mistSeeds, 4))
      mistGeometry.instanceCount = mistCount
      const puff = attribute('aMist', 'vec4')
      const puffAge = fract(this.time.mul(0.42).add(puff.y))
      const atFoot = puff.z.lessThan(0.65)
      const puffY = atFoot.select(
        puffAge.mul(0.45).add(0.06),
        puff.z
          .mul(height * 0.65)
          .add(0.1)
          .sub(puffAge.mul(0.22)),
      )
      const puffZ = atFoot.select(
        puff.w
          .mul(0.5)
          .add(IMPACT_OFFSET - 0.05)
          .add(puffAge.mul(0.15)),
        float(1)
          .sub(puffY.div(height))
          .max(0)
          .sqrt()
          .mul(IMPACT_OFFSET)
          .add(puff.w.sub(0.5).mul(0.3)),
      )
      const puffSize = atFoot.select(puffAge.mul(0.22).add(0.16), puffAge.mul(0.08).add(0.12))
      mist.flowPosition = positionLocal
        .mul(puffSize)
        .add(vec3(puff.x.add(sin(this.time.mul(0.7).add(puff.w.mul(8))).mul(0.05)), puffY, puffZ))
      const mistNormal = normalize(cross(dFdx(positionView), dFdy(positionView)))
      const chord = mistNormal.dot(normalize(positionView.negate())).abs()
      const mistDensity = contactNoise(positionLocal.xz.mul(12).add(positionLocal.y.mul(7)))
      mist.normalNode = mistNormal
      mist.side = FrontSide
      mist.colorNode = vec3(0.88, 0.94, 0.94)
      mist.roughness = 0.85
      mist.opacityNode = chord
        .mul(chord)
        .mul(sin(puffAge.mul(Math.PI)))
        .mul(mix(0.45, 1, mistDensity))
        .mul(atFoot.select(this.impactPulse.mul(0.18).add(0.08), 0.11))
        .mul(this.opacity)
      this.add(mistGeometry, mist, 'waterfall-mist')
      scene.add(this.group)
    } catch (error) {
      this.resources.dispose()
      this.group.removeFromParent()
      this.group.clear()
      throw error
    }
  }

  /** Cursor blocker in the waterfall group's local frame; strength 0 releases it. */
  setBlock(across: number, height: number, radius: number, strength: number) {
    this.blockAcross = across
    this.blockHeight = Math.max(0.1, Math.min(this.sheetHeight - 0.1, height))
    this.blockRadius = Math.min(radius, this.fall.width * 0.28)
    this.blockStrength = strength
  }

  /** Fall time from lip height to below the surface, with exit lift. */
  private flightTime(y0: number) {
    return (
      (EXIT_LIFT + Math.sqrt(EXIT_LIFT * EXIT_LIFT + 2 * GRAVITY * (y0 + KILL_DEPTH))) / GRAVITY
    )
  }

  /** Deterministic per-slot emission seed; runtime respawns add fresh jitter. */
  private lipSeed(index: number, fresh = false) {
    let state = (this.fall.seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0
    const seeded = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
    const random = fresh ? () => this.curtainRandom() : seeded
    const size = required(this.sizes[index])
    return {
      x: (random() - 0.5) * Math.max(0.05, this.fall.width - size * 2),
      y: this.sheetHeight - 0.025 - random() * 0.11,
      z: 0.045 + random() * 0.065,
      vx: (random() - 0.5) * 0.32,
      vz: 0.95 + random() * 0.4,
      phase: random() * Math.PI * 2,
      age: random(),
    }
  }

  private curtainRandom() {
    this.curtainState = (Math.imul(this.curtainState, 1664525) + 1013904223) >>> 0
    return this.curtainState / 0x1_0000_0000
  }

  private worldPoint(x: number, y: number, z: number): [number, number, number] {
    return [
      this.fall.x + this.directionZ * x + this.directionX * z,
      WATER_LEVEL + y,
      this.fall.z - this.directionX * x + this.directionZ * z,
    ]
  }

  private worldDirection(x: number, y: number, z: number): [number, number, number] {
    return [
      this.directionZ * x + this.directionX * z,
      y,
      -this.directionX * x + this.directionZ * z,
    ]
  }

  /** Recycles landed bodies and steers the blocker; runs before the world step. */
  private manageCurtain(time: number) {
    if (this.blockStrength > 0.01) {
      const radius = 0.04 + (this.blockRadius - 0.04) * 0.65 * this.blockStrength
      this.blockerRadius = radius
      this.blockerPlaneZ = waterfallDrift(this.sheetHeight, this.blockHeight)
      const [x, y, z] = this.worldPoint(this.blockAcross, this.blockHeight, this.blockerPlaneZ)
      if (!this.blockerActive) {
        this.blockerActive = true
        this.blockerBody.setEnabled(true)
      }
      this.blockerCollider.setRadius(radius)
      this.blockerBody.setNextKinematicTranslation({ x, y, z })
    } else if (this.blockerActive) {
      this.blockerActive = false
      this.blockerBody.setEnabled(false)
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const body = required(this.bodies[i])
      let position = body.translation(this.translationTarget)
      if (position.y < WATER_LEVEL - KILL_DEPTH || time - required(this.born[i]) > this.maxAge) {
        const seed = this.lipSeed(i, true)
        const [wx, wy, wz] = this.worldPoint(seed.x, seed.y, seed.z)
        const [vx, vy, vz] = this.worldDirection(seed.vx, EXIT_LIFT, seed.vz)
        body.setTranslation({ x: wx, y: wy, z: wz }, true)
        body.setLinvel({ x: vx, y: vy, z: vz }, true)
        this.born[i] = time
        this.phases[i] = seed.phase
        position = body.translation(this.translationTarget)
      }
      const wobble = Math.sin(position.y * 2.5 + time * 3 + required(this.phases[i])) * 0.2
      body.resetForces(false)
      this.forceTarget.x = this.directionZ * wobble
      this.forceTarget.y = 0
      this.forceTarget.z = -this.directionX * wobble
      body.addForce(this.forceTarget, false)
    }
  }

  /** Uploads stepped body state to the render attributes; runs after the world step. */
  syncCurtain() {
    if (this.disposed) return
    const dxn = this.directionX,
      dzn = this.directionZ
    const time = this.lastTime
    const wind = this.currentWind
    const active =
      time !== undefined && wind !== undefined && !this.reducedMotion && this.opacity.value > 0.8
    if (!active) this.clearPendingImpacts()
    let fragment: SplashJet | undefined
    for (let i = 0; i < this.bodies.length; i++) {
      const body = required(this.bodies[i])
      const t = body.translation(this.translationTarget)
      const v = body.linvel(this.velocityTarget)
      const ox = t.x - this.fall.x,
        oz = t.z - this.fall.z
      const base = i * 3
      const lx = dzn * ox - dxn * oz
      const ly = t.y - WATER_LEVEL
      const lz = dxn * ox + dzn * oz
      this.positions[base] = lx
      this.positions[base + 1] = ly
      this.positions[base + 2] = lz
      this.velocities[base] = dzn * v.x - dxn * v.z
      this.velocities[base + 1] = v.y
      this.velocities[base + 2] = dxn * v.x + dzn * v.z
      this.foams[i] = this.blockerFoam(lx, ly, lz)
      const previous = required(this.previousHeights[i])
      this.previousHeights[i] = ly
      // Wind waves stay within this narrow band; avoid sampling their full
      // spectrum for parcels that are still high above the lake.
      if (active && ly < 0.2 && previous > -0.2 && v.y < 0) {
        const surface = sampleWindField(t.x, t.z, time, wind, 0.08)[0]
        if (previous > surface && ly <= surface) {
          const bin = Math.max(0, Math.min(2, Math.floor((lx / this.fall.width + 0.5) * 3)))
          const impact = required(this.impactBins[bin])
          impact.count++
          impact.x += t.x
          impact.z += t.z
          impact.speed -= v.y
        }
      }
      if (
        !fragment &&
        this.blockerActive &&
        active &&
        time - this.lastFragmentTime > 0.045 &&
        required(this.foams[i]) > 0.72 &&
        Math.abs(ly - this.blockHeight) < 0.15 &&
        this.curtainRandom() < 0.035
      ) {
        const lateral = Math.sign(lx - this.blockAcross) || (this.curtainRandom() < 0.5 ? -1 : 1)
        const [sideX, , sideZ] = this.worldDirection(
          lateral * (0.5 + this.curtainRandom()),
          0,
          0.15,
        )
        fragment = {
          x: t.x,
          y: t.y,
          z: t.z,
          vx: sideX,
          vy: 0.4 + this.curtainRandom() * 0.7,
          vz: sideZ,
          size: 0.012 + this.curtainRandom() * 0.015,
          drag: 0.6,
          windX: wind.direction[0] * wind.speed * 0.1,
          windZ: wind.direction[1] * wind.speed * 0.1,
          release: time,
        }
      }
    }
    if (fragment && active) {
      this.lastFragmentTime = time
      this.emitJet(fragment)
    }
    if (active) {
      for (const impact of this.impactBins) {
        if (impact.count === 0 || time - impact.lastTime < 0.075) continue
        const x = impact.x / impact.count
        const z = impact.z / impact.count
        const energy = Math.min(1, impact.speed / 25)
        impact.lastTime = time
        this.impactPulse.value = Math.max(this.impactPulse.value, energy)
        this.emitImpact({ x, z, time, energy }, wind)
        impact.count = 0
        impact.x = 0
        impact.z = 0
        impact.speed = 0
      }
    }
    this.positionsAttribute.needsUpdate = true
    this.velocitiesAttribute.needsUpdate = true
    this.foamsAttribute.needsUpdate = true
  }

  private clearPendingImpacts() {
    for (const impact of this.impactBins) {
      impact.count = 0
      impact.x = 0
      impact.z = 0
      impact.speed = 0
    }
  }

  private blockerFoam(x: number, y: number, z: number) {
    if (!this.blockerActive) return 0
    const dy = y - this.blockHeight
    const clamped = Math.max(-BLOCKER_HALF_HEIGHT, Math.min(BLOCKER_HALF_HEIGHT, dy))
    const dx = x - this.blockAcross,
      dz = z - this.blockerPlaneZ
    const gap = dy - clamped
    const dist = Math.sqrt(dx * dx + gap * gap + dz * dz)
    return 1 - smoothstepCpu(this.blockerRadius, this.blockerRadius + 0.45, dist)
  }

  /** The fluid, foam and droplets meet the same moving surface as the lake. */
  setWaterSurface(uniforms: LakeWaterMaterial['uniforms']) {
    const [dx, dz] = this.fall.direction
    this.fluid.setWaterSurface(uniforms)
    for (const material of this.impactMaterials) {
      material.positionNode = Fn(() => {
        const world = vec2(
          positionLocal.x.mul(dz).add(positionLocal.z.mul(dx)).add(this.fall.x),
          positionLocal.z.mul(dz).sub(positionLocal.x.mul(dx)).add(this.fall.z),
        )
        const height = windFieldNode(world, float(0), uniforms).x.add(
          uniforms.uState.sample(fieldUvNode(world)).r,
        )
        return positionLocal.add(vec3(0, height, 0))
      })()
      material.needsUpdate = true
    }
  }

  prepareFluid(renderer: WebGPURenderer, camera: Camera) {
    return this.fluid.prepare(renderer, camera)
  }

  compile<T>(compile: () => Promise<T>) {
    return this.fluid.compile(compile)
  }

  private instanced(source: BufferGeometry) {
    try {
      const geometry = this.resources.own(new InstancedBufferGeometry())
      geometry.setIndex(source.getIndex())
      for (const [name, buffer] of Object.entries(source.attributes))
        geometry.setAttribute(name, buffer)
      return geometry
    } finally {
      source.dispose()
    }
  }

  private add(geometry: BufferGeometry, material: MeshStandardNodeMaterial, name: string) {
    const mesh = new Mesh(geometry, material)
    mesh.name = name
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    mesh.renderOrder = 2
    this.group.add(mesh)
    return mesh
  }

  update(time: number, _daylight: number, intro: number, wind: WindState) {
    if (this.disposed) return
    this.time.value = this.reducedMotion ? 0 : time
    this.opacity.value = Math.max(0, Math.min(1, intro))
    const elapsed = this.lastTime === undefined ? 0 : time - this.lastTime
    const dt = Math.min(0.1, Math.max(0, elapsed))
    if (elapsed < 0 || elapsed > 0.1) {
      this.clearPendingImpacts()
      this.impactPulse.value = 0
      if (elapsed < 0) {
        for (const impact of this.impactBins) impact.lastTime = -1
        this.lastFragmentTime = -1
      }
    }
    this.lastTime = time
    this.currentWind = wind
    this.impactPulse.value = Math.max(0, this.impactPulse.value - dt * 4)
    if (!this.reducedMotion) this.manageCurtain(time)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const body of this.bodies) this.physics.world.removeRigidBody(body)
    this.bodies.length = 0
    this.physics.world.removeRigidBody(this.blockerBody)
    this.group.removeFromParent()
    this.resources.dispose()
    this.group.clear()
  }
}

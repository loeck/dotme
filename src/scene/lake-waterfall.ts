import {
  attribute,
  cameraViewMatrix,
  cross,
  dFdx,
  dFdy,
  float,
  fract,
  Fn,
  fwidth,
  mix,
  normalize,
  normalView,
  positionLocal,
  positionView,
  positionViewDirection,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { Camera, Node, NodeBuilder, Scene, WebGPURenderer } from 'three/webgpu'

import { required } from '../invariant'
import { WATER_LEVEL } from './lake-bed'
import type { SplashJet, WaterfallImpact } from './lake-splashes'
import type { LakeWaterMaterial } from './lake-water'
import type { WaterfallSite } from './lake-world'
import { ResourceScope } from './resource-scope'
import type { WaterContact } from './water-contact'
import {
  contactNoise,
  loopCells,
  loopNoise,
  OPEN_AXIS,
  PATTERN_PERIOD,
  tiledNoise,
} from './water-noise'
import { fieldUvNode, sampleWaterContact, windFieldNode } from './water-surface'
import { waterfallDrift } from './waterfall-flow'
import {
  fallCore,
  fallStreaks,
  scatterPhase,
  WATERFALL_FLUID_LAYER,
  WATERFALL_REFLECTION_LAYER,
  WaterfallFluid,
} from './waterfall-fluid'
import type { WindState } from './wind'

const GRAVITY = 9.81
const IMPACT_OFFSET = 0.8
/** Vertical capsule: a velocity-stretched hole, not a round dent. */
const BLOCKER_HALF_HEIGHT = 0.1
const KILL_DEPTH = 0.05
const EXIT_LIFT = 0.1
/** Curtain motion integrates at the physics rate so it stays frame-rate independent. */
const CURTAIN_STEP = 1 / 60
const MAX_CURTAIN_STEPS = 4
/** Band for the horizontal wobble, as an acceleration: the previous force per ball mass. */
const WOBBLE_FORCE = 0.2
const PARCEL_DENSITY = 1000
const PARCEL_VOLUME = (4 / 3) * Math.PI
/** Foam drift downstream, in metres per second: a third, so every octave loops in a period. */
const FOAM_DRIFT = 1 / 3
/** Bubble lattice repeat: divides each bubble octave's drift over one pattern period. */
const BUBBLE_TILE = 160
/** Mist sway: a whole number of cycles per pattern period. */
const MIST_SWAY = (2 * Math.PI * 57) / PATTERN_PERIOD

const scratchTarget = new Vector3()

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
  private readonly patternTime = uniform(0)
  /** World direction towards the scene's key light and its colour times intensity. */
  private readonly lightDirection = uniform(new Vector3(0, 1, 0))
  private readonly lightRadiance = uniform(new Color(0, 0, 0))
  private readonly scene: Scene
  private keyLight: DirectionalLight | undefined
  private readonly opacity = uniform(0)
  private readonly fall: WaterfallSite
  private readonly emitJet: (jet: SplashJet) => void
  private readonly emitImpact: (impact: WaterfallImpact, wind: WindState) => void
  private contact?: WaterContact
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
  private readonly born: Float64Array
  private readonly phases: Float32Array
  private readonly sizes: Float32Array
  /** Horizontal wobble acceleration per parcel, folded from the old force per ball mass. */
  private readonly wobbleAccel: Float32Array
  /** Parcel motion is analytic: the curtain only ever collided with the cursor blocker. */
  private readonly worldPositions: Float32Array
  private readonly worldVelocities: Float32Array
  private readonly struck: Uint8Array
  private curtainAccumulator = 0
  private curtainClock = 0
  private readonly positions: Float32Array
  private readonly velocities: Float32Array
  private readonly foams: Float32Array
  private readonly parcelExtent: number
  private readonly nominalBounds: Box3
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
  private disposed = false

  constructor(
    scene: Scene,
    fall: WaterfallSite,
    mobile: boolean,
    reducedMotion: boolean,
    emitJet: (jet: SplashJet) => void,
    emitImpact: (impact: WaterfallImpact, wind: WindState) => void,
  ) {
    this.fall = fall
    this.scene = scene
    this.reducedMotion = reducedMotion
    this.emitJet = emitJet
    this.emitImpact = emitImpact
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
        mist = this.resources.own(createMaterial()),
        sheet = this.resources.own(createMaterial())
      this.fluid = this.resources.own(
        new WaterfallFluid(fall, mobile, this.opacity, this.patternTime),
      )
      this.materials = [this.fluid.material, foam, spray, basin, mist, sheet]
      const parcels = this.fluid.particles
      this.parcelExtent = parcels.extent
      this.nominalBounds = parcels.bounds.clone()
      this.sizes = parcels.sizes
      const slots = parcels.count
      this.previousHeights = new Float32Array(slots)
      this.born = new Float64Array(slots)
      this.phases = new Float32Array(slots)
      this.wobbleAccel = new Float32Array(slots)
      this.worldPositions = new Float32Array(slots * 3)
      this.worldVelocities = new Float32Array(slots * 3)
      this.struck = new Uint8Array(slots)
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
      for (let i = 0; i < slots; i++) {
        const seed = this.lipSeed(i)
        const age = seed.age * this.flightTime(seed.y)
        const [x, y, z] = this.worldPoint(
          seed.x + seed.vx * age,
          seed.y + EXIT_LIFT * age - (GRAVITY / 2) * age * age,
          seed.z + seed.vz * age,
        )
        const [vx, vy, vz] = this.worldDirection(seed.vx, EXIT_LIFT - GRAVITY * age, seed.vz)
        const base = i * 3
        const radius = required(this.sizes[i])
        this.worldPositions[base] = x
        this.worldPositions[base + 1] = y
        this.worldPositions[base + 2] = z
        this.worldVelocities[base] = vx
        this.worldVelocities[base + 1] = vy
        this.worldVelocities[base + 2] = vz
        this.wobbleAccel[i] =
          WOBBLE_FORCE / Math.max(1e-5, PARCEL_DENSITY * PARCEL_VOLUME * radius * radius * radius)
        this.born[i] = -age
        this.phases[i] = seed.phase
      }
      this.syncCurtain()
      this.group.add(this.fluid.mesh)
      this.impactMaterials = [foam, spray, mist]
      const height = Math.max(0.1, fall.top - WATER_LEVEL)
      // Basin cells share world edges; transform them into the waterfall's local frame.
      const [forwardX, forwardZ] = fall.direction
      const positions: number[] = [],
        normals: number[] = [],
        coordinates: number[] = [],
        streams: number[] = [],
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
          streams.push(0)
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
      basinGeometry.setAttribute('aStream', new BufferAttribute(new Float32Array(streams), 1))
      basinGeometry.setAttribute(
        'aShown',
        new BufferAttribute(new Float32Array(streams.length).fill(1), 1),
      )
      basinGeometry.setIndex(indices)
      // The feeding stream: one ribbon down its channel into the pool, drawn with the pool's
      // material. Its coordinates run along the course, so the filaments flow towards the
      // pool; steeper reaches break into whiter water.
      const course = fall.stream.points
      const ribbon: number[] = [],
        ribbonNormals: number[] = [],
        ribbonCoordinates: number[] = [],
        ribbonSlopes: number[] = [],
        ribbonShown: number[] = [],
        ribbonIndices: number[] = []
      let travelled = 0
      course.forEach((point, i) => {
        const before = course[Math.max(0, i - 1)] ?? point,
          after = course[Math.min(course.length - 1, i + 1)] ?? point
        const dx = after.x - before.x,
          dz = after.z - before.z
        const span = Math.hypot(dx, dz) || 1
        const half = fall.stream.width / 2
        const slope = (before.y - after.y) / span
        if (i > 0) {
          const previous = course[i - 1] ?? point
          travelled += Math.hypot(point.x - previous.x, point.z - previous.z)
        }
        const start = ribbon.length / 3
        for (const side of [-1, 1]) {
          const wx = point.x - fall.x + (dz / span) * half * side,
            wz = point.z - fall.z - (dx / span) * half * side
          ribbon.push(
            wx * forwardZ - wz * forwardX,
            point.y - WATER_LEVEL + 0.01,
            wx * forwardX + wz * forwardZ,
          )
          ribbonNormals.push(0, 1, 0)
          ribbonCoordinates.push(side * half, travelled)
          ribbonSlopes.push(Math.min(1, 0.5 + slope * 2))
          ribbonShown.push(point.shown)
        }
        if (i > 0) ribbonIndices.push(start - 2, start - 1, start + 1, start - 2, start + 1, start)
      })
      const streamGeometry = this.resources.own(new BufferGeometry())
      streamGeometry.setAttribute('position', new BufferAttribute(new Float32Array(ribbon), 3))
      streamGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(ribbonNormals), 3))
      streamGeometry.setAttribute('uv', new BufferAttribute(new Float32Array(ribbonCoordinates), 2))
      streamGeometry.setAttribute('aStream', new BufferAttribute(new Float32Array(ribbonSlopes), 1))
      streamGeometry.setAttribute('aShown', new BufferAttribute(new Float32Array(ribbonShown), 1))
      streamGeometry.setIndex(ribbonIndices)
      const basinPoint = uv()
      const stream = attribute('aStream', 'float')
      const approach = float(1).sub(smoothstep(0.1, 1.4, basinPoint.y.abs()))
      const flowWidth = basinPoint.y.abs().mul(0.35).add(1)
      const basinNoise = contactNoise(
        vec2(basinPoint.x.div(flowWidth).mul(6), basinPoint.y.mul(2).sub(this.time.mul(0.7))),
      )
      // The stream breaks into soft, round foam drifting down its course rather than streaks
      // along it, which a channel seen end-on would turn into vertical stripes. Seen from afar
      // (a few pixels per metre) the foam resolves to its mean instead of aliasing.
      const streamNoise = contactNoise(
        vec2(basinPoint.x.mul(2.4), basinPoint.y.sub(this.time.mul(1.4)).mul(2.4)),
      )
      const streamDetail = float(1).sub(
        smoothstep(0.15, 0.45, fwidth(basinPoint).length().mul(2.4)),
      )
      const streamFoam = mix(float(0.6), smoothstep(0.2, 0.75, streamNoise), streamDetail).mul(
        stream,
      )
      const flowing = stream.ceil()
      const filament = mix(smoothstep(0.55, 0.82, basinNoise).mul(approach), streamFoam, flowing)
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
      // Broken, tumbling water faces every way: lean the stream's normal towards the viewer,
      // so its foam is lit rather than mirroring the trees and sky at a grazing angle.
      basin.normalNode = normalize(
        mix(
          normalize(cross(dFdx(positionView), dFdy(positionView))),
          normalize(positionView.negate()),
          flowing.mul(0.6),
        ),
      )
      // Dark, turbid pool water that mirrors the sky, with pale filaments drawn
      // towards the lip.
      basin.colorNode = mix(
        mix(vec3(0.05, 0.065, 0.058), vec3(0.16, 0.19, 0.17), flowing),
        mix(vec3(0.42, 0.46, 0.44), vec3(0.62, 0.66, 0.64), flowing),
        filament.mul(mix(0.45, 1, flowing)),
      )
      basin.roughnessNode = mix(mix(0.04, 0.6, flowing), mix(0.3, 0.85, flowing), filament)
      basin.opacityNode = mix(0.86, 0.94, filament)
        .mul(this.opacity)
        .mul(attribute('aShown', 'float'))
      this.add(basinGeometry, basin, 'waterfall-basin')
      if (course.length > 1) this.add(streamGeometry, basin, 'waterfall-stream')
      const exitSpeed = 0.35
      const duration =
        (Math.sqrt(exitSpeed * exitSpeed + 2 * GRAVITY * height) - exitSpeed) / GRAVITY
      const p = uv()

      const t = this.patternTime
      // The plunge pool: a boil of aerated water the width of the fall, then foam
      // lines fanning out downstream that tear into lace and decay as they drift,
      // after Last Signal's foam (clump and grain breakup, a half-life per metre).
      const halfWidth = fall.width / 2
      const spanX = fall.width + 2.4
      const spanZ = 3.6
      const footX = p.x.sub(0.5).mul(spanX)
      const footZ = p.y.mul(spanZ).add(IMPACT_OFFSET - 0.6)
      const downstream = footZ.sub(IMPACT_OFFSET)
      const travel = downstream.max(0)
      const boilRadius = vec2(
        footX
          .abs()
          .sub(halfWidth * 0.8)
          .max(0),
        downstream.mul(downstream.lessThan(0).select(1.6, 1.1)),
      ).length()
      const boil = float(1).sub(smoothstep(0.06, 0.6, boilRadius))
      // Every scrolled lattice repeats after the distance it travels in one pattern
      // period, so the wrapped clock never makes the foam jump.
      const churn = loopNoise(
        vec2(footX.mul(11), footZ.mul(11)).add(vec2(t.mul(0.9), t.mul(-1.9))),
        [loopCells(0.9), loopCells(1.9)],
      )
      const drift = footZ.sub(t.mul(FOAM_DRIFT))
      const fan = footX.div(travel.mul(0.55).add(halfWidth + 0.25))
      const scrolled = (scale: number): [null, number] => [OPEN_AXIS, loopCells(FOAM_DRIFT * scale)]
      const lines = loopNoise(vec2(fan.mul(5.5), drift.mul(1.1)), scrolled(1.1))
      const clump = loopNoise(vec2(footX.mul(2.4), drift.mul(2.4)).add(7.1), scrolled(2.4))
      const lace = loopNoise(vec2(footX.mul(9), drift.mul(9)).add(3.3), scrolled(9))
      // Close up, bubbles and torn fingers a few centimetres across break the
      // lace edges and pit the boil. Each octave fades out as its cells shrink
      // below a few pixels, so distant foam keeps the smooth look and cannot
      // shimmer; the zero-mean detail leaves the faded foam unchanged.
      const footprint = fwidth(vec2(footX, footZ)).length()
      const octave = (frequency: number) =>
        float(1).sub(smoothstep(0.2, 0.4, footprint.mul(frequency)))
      const bubbleSpace = vec2(footX, drift).add(
        vec2(churn.sub(0.5), churn.sub(0.5).negate()).mul(boil.mul(0.12)),
      )
      const coarseFade = octave(28)
      const fineFade = octave(64)
      const fine = tiledNoise(bubbleSpace.mul(28).add(vec2(13.7, 4.1)), BUBBLE_TILE)
        .sub(0.5)
        .mul(coarseFade.mul(0.62))
        .add(
          tiledNoise(
            vec2(
              bubbleSpace.x.mul(0.8).sub(bubbleSpace.y.mul(0.6)),
              bubbleSpace.x.mul(0.6).add(bubbleSpace.y.mul(0.8)),
            ).mul(64),
            BUBBLE_TILE,
          )
            .sub(0.5)
            .mul(fineFade.mul(0.38)),
        )
      const fanMask = float(1).sub(smoothstep(0.55, 1, fan.abs()))
      const streak = (detail: Node<'float'>) =>
        smoothstep(0.36, 0.64, lines.add(detail.mul(0.22)))
          .mul(smoothstep(0.3, 0.55, mix(clump, lace, 0.6).add(detail.mul(0.42))))
          .mul(travel.div(-2.4).exp())
          .mul(smoothstep(-0.1, 0.3, downstream))
          .mul(fanMask)
      const streakFoam = streak(fine)
      // Entrained bubbles lighten the pool under the foam as they rise and drift.
      const plume = travel
        .div(-1.3)
        .exp()
        .mul(fanMask)
        .mul(smoothstep(-0.3, 0.1, downstream))
        .mul(mix(0.6, 1, clump))
      const boilFoam = boil
        .mul(mix(0.5, 1, smoothstep(0.25, 0.7, churn.add(fine.mul(0.5)))))
        .mul(mix(0.45, 1, this.impactPulse))
      const footFoam = boilFoam.max(streakFoam.mul(0.92))
      const border = float(1)
        .sub(smoothstep(0.4, 0.5, p.x.sub(0.5).abs()))
        .mul(smoothstep(0, 0.1, p.y))
        .mul(float(1).sub(smoothstep(0.8, 1, p.y)))
      foam.flowPosition = vec3(
        footX,
        boil
          .mul(mix(0.04, 0.16, churn))
          // Derivatives exist only in fragments: the height uses the smooth lace.
          .add(streak(float(0)).mul(0.008))
          .add(0.016),
        footZ,
      )
      foam.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)))
      // Bubble crests catch more light than the pits between them.
      foam.colorNode = mix(vec3(0.34, 0.39, 0.38), vec3(0.8, 0.82, 0.8), footFoam).mul(
        fine.mul(0.3).add(1),
      )
      foam.roughness = 0.82
      foam.opacityNode = footFoam
        .mul(fine.mul(0.35).add(1))
        .clamp(0, 1)
        .max(plume.mul(0.3))
        .mul(border)
        .mul(this.opacity)
      foam.emissiveNode = this.forwardGlow(0.5, vec3(0.16, 0.165, 0.16)).mul(boilFoam)
      const foamGeometry = this.resources.own(
        new PlaneGeometry(1, 1, mobile ? 12 : 20, mobile ? 12 : 18),
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
      spray.colorNode = vec3(0.62, 0.7, 0.75)
      spray.roughness = 0.08
      // Drops are tiny lenses: shade them half towards the eye, half towards the sky.
      spray.normalNode = normalize(
        positionViewDirection.add(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz),
      )
      spray.emissiveNode = this.forwardGlow(0.6, vec3(0.45, 0.47, 0.48))
      const footFade = smoothstep(0, 0.025, dropAge).mul(
        float(1).sub(smoothstep(life.mul(0.75), life, dropAge)),
      )
      const edgeFade = smoothstep(0.12, 0.25, edgeDown).mul(
        float(1).sub(smoothstep(0.86, 1, edgeDown)),
      )
      spray.opacityNode = mix(footFade, edgeFade, edge.abs())
        .mul(motion.w.mul(0.75))
        .mul(float(1).sub(smoothstep(0.3, 1, p.sub(0.5).mul(2).length())))
        .mul(this.opacity)
      const sprayMesh = this.add(sprayGeometry, spray, 'waterfall-droplets')

      // Spray mist: puffs born in the plunge roll outward and up, growing and
      // thinning, while a thinner veil hangs on the lower fall. Smooth sphere
      // normals and a chord fade keep them soft without a fullscreen fog pass.
      const mistCount = mobile ? 14 : 24
      const mistSeeds = new Float32Array(mistCount * 4)
      for (let i = 0; i < mistCount; i++)
        mistSeeds.set([(random() - 0.5) * fall.width * 1.1, random(), random(), random()], i * 4)
      const mistGeometry = this.instanced(new SphereGeometry(1, mobile ? 8 : 12, mobile ? 6 : 8))
      mistGeometry.setAttribute('aMist', new InstancedBufferAttribute(mistSeeds, 4))
      mistGeometry.instanceCount = mistCount
      const puff = attribute('aMist', 'vec4')
      const atFoot = puff.z.lessThan(0.75)
      const puffAge = fract(this.patternTime.mul(atFoot.select(0.19, 0.4)).add(puff.y))
      const puffY = atFoot.select(
        puffAge.mul(0.7).add(puff.w.mul(0.15)).add(0.08),
        puff.z
          .mul(height * 0.6)
          .add(0.12)
          .sub(puffAge.mul(0.25)),
      )
      const puffZ = atFoot.select(
        puffAge.mul(puff.w.mul(0.6).add(0.8)).add(IMPACT_OFFSET - 0.3),
        float(1)
          .sub(puffY.div(height))
          .max(0)
          .sqrt()
          .mul(IMPACT_OFFSET)
          .add(puff.w.sub(0.5).mul(0.3)),
      )
      const puffX = puff.x
        .mul(atFoot.select(puffAge.mul(0.6).add(1), 1))
        .add(sin(this.patternTime.mul(MIST_SWAY).add(puff.w.mul(8))).mul(0.06))
      const puffSize = atFoot.select(puffAge.mul(0.5).add(0.24), puffAge.mul(0.1).add(0.14))
      mist.flowPosition = positionLocal.mul(puffSize).add(vec3(puffX, puffY, puffZ))
      const chord = normalView.dot(positionViewDirection).abs()
      const mistDensity = contactNoise(positionLocal.xz.mul(5).add(positionLocal.y.mul(3)))
      mist.side = FrontSide
      mist.colorNode = vec3(0.74, 0.78, 0.8)
      mist.roughness = 1
      mist.emissiveNode = this.forwardGlow(0.62, vec3(0.5, 0.52, 0.53))
      const puffLife = atFoot.select(
        smoothstep(0, 0.14, puffAge).mul(float(1).sub(smoothstep(0.45, 1, puffAge))),
        sin(puffAge.mul(Math.PI)),
      )
      mist.opacityNode = chord
        .mul(chord)
        .mul(puffLife)
        .mul(mix(0.5, 1, mistDensity))
        .mul(atFoot.select(this.impactPulse.mul(0.08).add(0.15), 0.12))
        .mul(this.opacity)
      // Mist and spray stay out of the mirror: there they would only haze the
      // reflected fall and cost blended fragments in another pass.
      this.add(mistGeometry, mist, 'waterfall-mist').layers.set(WATERFALL_FLUID_LAYER)
      sprayMesh.layers.set(WATERFALL_FLUID_LAYER)
      this.addReflectionSheet(sheet)
      scene.add(this.group)
    } catch (error) {
      this.resources.dispose()
      this.group.removeFromParent()
      this.group.clear()
      throw error
    }
  }

  /**
   * Render the live curtain as low-poly parcels in the mirror. They share the
   * fluid capture's position, velocity and foam streams, including deflections
   * and gaps under the cursor, without a second depth/thickness/filter pass.
   */
  private addReflectionSheet(material: FallingWaterMaterial) {
    const parcels = this.fluid.particles
    const geometry = this.instanced(new SphereGeometry(1, 4, 3))
    for (const name of ['aBodySize', 'aBodyPosition', 'aBodyVelocity', 'aBodyFoam'])
      geometry.setAttribute(name, parcels.geometry.getAttribute(name))
    geometry.instanceCount = parcels.count
    geometry.boundingBox = parcels.bounds.clone()
    geometry.boundingSphere = parcels.geometry.boundingSphere?.clone() ?? null
    material.flowPosition = parcels.positionNode
    const height = this.sheetHeight
    const drop = float(height).sub(positionLocal.y).max(0)
    const across = positionLocal.x
    const { breakup, aerated } = fallStreaks(across, drop, this.patternTime, height, false)
    const whitewater = aerated
      .mul(0.86)
      .add(attribute('aBodyFoam', 'float').mul(breakup).mul(0.65))
      .clamp(0, 1)
    material.colorNode = mix(fallCore(drop), vec3(0.68, 0.71, 0.7), whitewater)
    material.roughnessNode = mix(0.05, 0.38, whitewater)
    material.envMapIntensity = 1.6
    material.opacityNode = mix(0.7, 0.98, whitewater).mul(this.opacity)
    material.side = FrontSide
    material.depthWrite = true
    material.emissiveNode = this.forwardGlow(
      0.55,
      mix(vec3(0.03, 0.04, 0.03), vec3(0.32, 0.33, 0.32), whitewater),
    )
    const mesh = this.add(geometry, material, 'waterfall-reflection')
    mesh.renderOrder = 1
    mesh.layers.set(WATERFALL_REFLECTION_LAYER)
  }

  /** Key light scattered forward through aerated water and spray, in view space. */
  private forwardGlow(g: number, albedo: Node<'vec3'>) {
    const towardsLight = normalize(cameraViewMatrix.mul(vec4(this.lightDirection, 0)).xyz)
    return this.lightRadiance
      .mul(scatterPhase(positionViewDirection.dot(towardsLight).negate(), g))
      .mul(albedo)
  }

  /** Follows the scene's directional light: the sun by day, the moon at night. */
  private updateLight() {
    this.keyLight ??= this.scene.children.find((child) => child instanceof DirectionalLight)
    const light = this.keyLight
    if (!light) return
    const direction = this.lightDirection.value
      .copy(light.position)
      .sub(light.target.getWorldPosition(scratchTarget))
    if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0)
    direction.normalize()
    this.lightRadiance.value.copy(light.color).multiplyScalar(light.intensity)
    this.fluid.setLight(direction, this.lightRadiance.value)
  }

  /** Cursor blocker in the waterfall group's local frame; strength 0 releases it. */
  setBlock(across: number, height: number, radius: number, strength: number) {
    this.blockAcross = across
    this.blockHeight = Math.max(0.1, Math.min(this.sheetHeight - 0.1, height))
    this.blockRadius = Math.min(radius, this.fall.width * 0.18, 0.25)
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

  setWaterContact(contact: WaterContact) {
    this.contact = contact
  }

  private worldDirection(x: number, y: number, z: number): [number, number, number] {
    return [
      this.directionZ * x + this.directionX * z,
      y,
      -this.directionX * x + this.directionZ * z,
    ]
  }

  /** Places the cursor blocker and recycles landed parcels before integration. */
  private manageCurtain(time: number) {
    if (this.blockStrength > 0.01) {
      this.blockerRadius = 0.04 + (this.blockRadius - 0.04) * 0.72 * this.blockStrength
      this.blockerPlaneZ = waterfallDrift(this.sheetHeight, this.blockHeight)
      this.blockerActive = true
    } else {
      this.blockerActive = false
    }
    for (let i = 0; i < this.born.length; i++) {
      const base = i * 3
      const y = required(this.worldPositions[base + 1])
      if (y < WATER_LEVEL - KILL_DEPTH || time - required(this.born[i]) > this.maxAge) {
        const seed = this.lipSeed(i, true)
        const [x, wy, z] = this.worldPoint(seed.x, seed.y, seed.z)
        const [vx, vy, vz] = this.worldDirection(seed.vx, EXIT_LIFT, seed.vz)
        this.worldPositions[base] = x
        this.worldPositions[base + 1] = wy
        this.worldPositions[base + 2] = z
        this.worldVelocities[base] = vx
        this.worldVelocities[base + 1] = vy
        this.worldVelocities[base + 2] = vz
        this.born[i] = time
        this.phases[i] = seed.phase
      }
    }
  }

  /** Advances the analytic curtain by a fixed step, matching the previous rigid-body rate. */
  private stepCurtain(dt: number) {
    const dxn = this.directionX,
      dzn = this.directionZ
    const time = this.curtainClock
    const blocked = this.blockerActive
    const blockerX = this.fall.x + dzn * this.blockAcross + dxn * this.blockerPlaneZ
    const blockerZ = this.fall.z - dxn * this.blockAcross + dzn * this.blockerPlaneZ
    const blockerY = WATER_LEVEL + this.blockHeight
    const bottom = blockerY - BLOCKER_HALF_HEIGHT
    const top = blockerY + BLOCKER_HALF_HEIGHT
    const damping = 1 / (1 + dt)
    for (let i = 0; i < this.born.length; i++) {
      const base = i * 3
      const px = required(this.worldPositions[base]),
        py = required(this.worldPositions[base + 1]),
        pz = required(this.worldPositions[base + 2])
      let vx = required(this.worldVelocities[base]),
        vy = required(this.worldVelocities[base + 1]),
        vz = required(this.worldVelocities[base + 2])
      // A small horizontal wobble acceleration, then damping, as the solver did.
      const wobble =
        Math.sin(py * 2.5 + time * 3 + required(this.phases[i])) * required(this.wobbleAccel[i])
      vx = (vx + dzn * wobble * dt) * damping
      vy = (vy - GRAVITY * dt) * damping
      vz = (vz - dxn * wobble * dt) * damping
      let x = px + vx * dt
      const y = py + vy * dt
      let z = pz + vz * dt
      if (blocked) {
        // Sphere against the vertical blocker capsule, resolved along the surface.
        const closest = y < bottom ? bottom : y > top ? top : y
        const dx = x - blockerX,
          dy = y - closest,
          dz = z - blockerZ
        const limit = this.blockerRadius + required(this.sizes[i])
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (distance < limit) {
          const inverse = distance > 1e-6 ? 1 / distance : 0
          const nx = dx * inverse,
            ny = dy * inverse,
            nz = dz * inverse
          x = blockerX + nx * limit
          z = blockerZ + nz * limit
          // Restitution 0.05 with friction: keep the tangential motion, stop ingress.
          const inward = vx * nx + vy * ny + vz * nz
          if (inward < 0) {
            vx -= inward * 1.05 * nx
            vy -= inward * 1.05 * ny
            vz -= inward * 1.05 * nz
          }
          this.struck[i] = 1
        }
      }
      this.worldPositions[base] = x
      this.worldPositions[base + 1] = y
      this.worldPositions[base + 2] = z
      this.worldVelocities[base] = vx
      this.worldVelocities[base + 1] = vy
      this.worldVelocities[base + 2] = vz
    }
    this.curtainClock += dt
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
    const bounds = this.fluid.particles.bounds
    bounds.copy(this.nominalBounds)
    const extent = this.parcelExtent
    if (!active) this.clearPendingImpacts()
    let fragment: SplashJet | undefined
    let foamChanged = false
    const count = this.born.length
    for (let i = 0; i < count; i++) {
      const base = i * 3
      const x = required(this.worldPositions[base]),
        y = required(this.worldPositions[base + 1]),
        z = required(this.worldPositions[base + 2])
      const vx = required(this.worldVelocities[base]),
        vy = required(this.worldVelocities[base + 1]),
        vz = required(this.worldVelocities[base + 2])
      const ox = x - this.fall.x,
        oz = z - this.fall.z
      const lx = dzn * ox - dxn * oz
      const ly = y - WATER_LEVEL
      const lz = dxn * ox + dzn * oz
      this.positions[base] = lx
      this.positions[base + 1] = ly
      this.positions[base + 2] = lz
      bounds.min.x = Math.min(bounds.min.x, lx - extent)
      bounds.min.y = Math.min(bounds.min.y, ly - extent)
      bounds.min.z = Math.min(bounds.min.z, lz - extent)
      bounds.max.x = Math.max(bounds.max.x, lx + extent)
      bounds.max.y = Math.max(bounds.max.y, ly + extent)
      bounds.max.z = Math.max(bounds.max.z, lz + extent)
      this.velocities[base] = dzn * vx - dxn * vz
      this.velocities[base + 1] = vy
      this.velocities[base + 2] = dxn * vx + dzn * vz
      const proximity = this.blockerFoam(lx, ly, lz)
      const struckBlocker = active && proximity > 0.55 && this.blockerActive && this.struck[i] !== 0
      const foam = Math.min(
        1,
        proximity + (struckBlocker ? Math.min(0.35, Math.hypot(vx, vy, vz) * 0.04) : 0),
      )
      // Foam is zero away from the cursor's blocker: upload it only when some value changed.
      if (this.foams[i] !== foam) {
        this.foams[i] = foam
        foamChanged = true
      }
      const previous = required(this.previousHeights[i])
      this.previousHeights[i] = ly
      // Wind waves stay within this narrow band; avoid sampling their full
      // spectrum for parcels that are still high above the lake.
      if (active && ly < 0.2 && previous > -0.2 && vy < 0) {
        const surface = this.contact
          ? this.contact.sample(x, z, time, wind)[0] - WATER_LEVEL
          : sampleWaterContact(x, z, time, wind, 0.08)[0]
        if (previous > surface && ly <= surface) {
          const bin = Math.max(0, Math.min(2, Math.floor((lx / this.fall.width + 0.5) * 3)))
          const impact = required(this.impactBins[bin])
          impact.count++
          impact.x += x
          impact.z += z
          impact.speed -= vy
        }
      }
      if (
        !fragment &&
        this.blockerActive &&
        active &&
        time - this.lastFragmentTime > 0.045 &&
        struckBlocker &&
        Math.abs(ly - this.blockHeight) < 0.15 &&
        this.curtainRandom() < 0.08
      ) {
        const lateral = Math.sign(lx - this.blockAcross) || (this.curtainRandom() < 0.5 ? -1 : 1)
        const [sideX, , sideZ] = this.worldDirection(
          lateral * (0.5 + this.curtainRandom()),
          0,
          0.15,
        )
        fragment = {
          x,
          y,
          z,
          vx: sideX,
          vy: 0.4 + this.curtainRandom() * 0.7 + Math.min(0.7, Math.hypot(vx, vy, vz) * 0.08),
          vz: sideZ,
          size: 0.012 + this.curtainRandom() * 0.015,
          drag: 0.6,
          windX: wind.direction[0] * wind.speed * 0.1,
          windZ: wind.direction[1] * wind.speed * 0.1,
          release: time,
        }
      }
    }
    this.struck.fill(0)
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
    // Every parcel moves each step, so positions and velocities upload whole.
    this.positionsAttribute.needsUpdate = true
    this.velocitiesAttribute.needsUpdate = true
    if (foamChanged) this.foamsAttribute.needsUpdate = true
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
    this.patternTime.value = this.reducedMotion ? 0 : time % PATTERN_PERIOD
    this.updateLight()
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
    if (this.reducedMotion) return
    this.manageCurtain(time)
    // Fixed steps keep the fall identical to the previous rigid-body rate.
    this.curtainAccumulator = Math.min(
      this.curtainAccumulator + dt,
      CURTAIN_STEP * MAX_CURTAIN_STEPS,
    )
    while (this.curtainAccumulator >= CURTAIN_STEP) {
      this.stepCurtain(CURTAIN_STEP)
      this.curtainAccumulator -= CURTAIN_STEP
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.group.removeFromParent()
    this.resources.dispose()
    this.group.clear()
  }
}

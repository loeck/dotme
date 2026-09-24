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

import { WATER_LEVEL } from './lake-bed'
import type { LakeWaterMaterial } from './lake-water'
import { ResourceScope } from './resource-scope'
import type { VoxelWaterfall } from './voxel-world'
import { contactNoise } from './water-noise'
import { fieldUvNode, windFieldNode } from './water-surface'
import { WaterfallFluid } from './waterfall-fluid'

const GRAVITY = 9.81
const IMPACT_OFFSET = 0.8

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
  onImpact?: (x: number, z: number, radius: number, velocity: number, energy: number) => void
  private readonly resources = new ResourceScope()
  private readonly time = uniform(0)
  private readonly opacity = uniform(0)
  private readonly fall: VoxelWaterfall
  private readonly impactMaterials: readonly FallingWaterMaterial[]
  private readonly fluid: WaterfallFluid
  private readonly reducedMotion: boolean
  private lastImpact: number | undefined
  private impactIndex = 0
  private disposed = false

  constructor(scene: Scene, fall: VoxelWaterfall, mobile: boolean, reducedMotion: boolean) {
    this.fall = fall
    this.reducedMotion = reducedMotion
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
      this.fluid = this.resources.own(new WaterfallFluid(fall, mobile, this.time, this.opacity))
      this.materials = [this.fluid.material, foam, spray, basin, mist]
      this.group.add(this.fluid.mesh)
      this.impactMaterials = [foam, spray, mist]
      const height = Math.max(0.1, fall.top - WATER_LEVEL)
      // Basin cells share world edges; transform them into the waterfall's local frame.
      const [forwardX, forwardZ] = fall.direction
      const positions: number[] = [],
        normals: number[] = [],
        coordinates: number[] = [],
        indices: number[] = []
      const quad = (x0: number, z0: number, x1: number, z1: number) => {
        const start = positions.length / 3
        for (const [x, z] of [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ] as const) {
          positions.push(x, height, z)
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
      basin.flowPosition = positionLocal.add(vec3(0, ripple, 0))
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
      const ringAge = fract(this.time.mul(0.65))
      const ring = float(1)
        .sub(smoothstep(0.025, 0.11, foamRadius.sub(ringAge.mul(1.2)).abs()))
        .mul(float(1).sub(ringAge))
        .mul(0.35)
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
        .add(ring.mul(smoothstep(0.25, 0.65, foamNoise)))
        .mul(float(1).sub(smoothstep(0.85, 1.05, foamRadius)))
        .mul(this.opacity)
      const foamGeometry = this.resources.own(
        new PlaneGeometry(1, 1, mobile ? 12 : 20, mobile ? 10 : 16),
      )
      this.add(foamGeometry, foam, 'waterfall-foot')

      const footDrops = mobile ? 40 : 72
      const count = footDrops + (mobile ? 12 : 20)
      const edgeDrops = new Float32Array(count)
      const sources = new Float32Array(count * 4),
        motions = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        const detached = i >= footDrops
        edgeDrops[i] = detached ? (i % 2 === 0 ? 1 : -1) : 0
        sources.set(
          [
            (random() - 0.5) * fall.width,
            random(),
            detached ? 0.012 + random() * 0.02 : 0.025 + random() * 0.04,
            random() * 0.18,
          ],
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
        .mul(atFoot.select(0.23, 0.11))
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

  update(time: number, _daylight: number, intro: number) {
    if (this.disposed) return
    this.time.value = this.reducedMotion ? 0 : time
    this.opacity.value = Math.max(0, Math.min(1, intro))
    if (this.reducedMotion || intro < 0.8) return
    if (this.lastImpact === undefined || time < this.lastImpact) this.lastImpact = time
    if (time - this.lastImpact < 0.25) return
    this.lastImpact = time
    const phase = this.impactIndex++ * 2.399963229728653 + this.fall.seed
    const across = Math.sin(phase) * this.fall.width * 0.35
    const forward = IMPACT_OFFSET + Math.cos(phase * 1.37) * 0.06
    const [dx, dz] = this.fall.direction
    this.onImpact?.(
      this.fall.x + dz * across + dx * forward,
      this.fall.z - dx * across + dz * forward,
      Math.min(0.36, this.fall.width * 0.2),
      -0.022,
      0.3,
    )
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    delete this.onImpact
    this.group.removeFromParent()
    this.resources.dispose()
    this.group.clear()
  }
}

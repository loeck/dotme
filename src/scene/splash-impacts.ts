import {
  Fn,
  attribute,
  uv,
  positionLocal,
  positionView,
  normalize,
  cross,
  dFdx,
  dFdy,
  faceDirection,
  float,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  clamp,
  mix,
  fract,
  floor,
  smoothstep,
  exp,
  max,
} from 'three/tsl'
import {
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardNodeMaterial,
  Object3D,
  OneFactor,
  PlaneGeometry,
  MeshBasicNodeMaterial,
} from 'three/webgpu'
import type { Scene, Node, NodeBuilder } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import type { LakeWaterMaterial } from './lake-water'
import { fieldUvNode, windFieldNode } from './water-surface'

class CrownMaterial extends MeshStandardNodeMaterial {
  localPosition: Node<'vec3'> | null = null
  override setupPosition(builder: NodeBuilder) {
    if (this.localPosition) positionLocal.assign(this.localPosition)
    return super.setupPosition(builder)
  }
}

export const SPLASH_IMPACT_LAYER = 4
const LIFETIME = 1.35

type Impact = { x: number; z: number; born: number; energy: number; seed: number }

/** Landing waves are accumulated into the existing water-normal buffer. */
export class SplashImpacts {
  readonly mesh: InstancedMesh<PlaneGeometry, CrownMaterial>
  readonly slopes: InstancedMesh<PlaneGeometry, MeshBasicNodeMaterial>
  private readonly pool: Array<Impact | null>
  private readonly transform = new Object3D()
  private cursor = 0
  landed = 0
  active = 0

  constructor(scene: Scene, mobile: boolean) {
    this.pool = Array.from({ length: mobile ? 64 : 128 }, () => null)
    const makeData = () =>
      new InstancedBufferAttribute(new Float32Array(this.pool.length * 3), 3).setUsage(
        DynamicDrawUsage,
      )
    const geometry = new PlaneGeometry(1, 1, 64, 7)
    geometry.setAttribute('aLanding', makeData())
    const material = new CrownMaterial({
      color: 0x91b9bd,
      roughness: 0.1,
      envMapIntensity: 1.2,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    const landing = attribute('aLanding', 'vec3'),
      p = uv(),
      angle = p.x.mul(Math.PI * 2),
      age = landing.x,
      energy = landing.y
    const duration = mix(0.22, 0.34, landing.z)
    const lift = sin(clamp(age.div(duration), 0, 1).mul(Math.PI))
    const radius = age
      .mul(0.32)
      .add(p.y.mul(0.045))
      .add(0.055)
      .mul(mix(0.85, 1.18, fract(landing.z.mul(17.3))))
      .mul(
        sin(angle.mul(3).add(landing.z.mul(13)))
          .mul(0.12)
          .add(1),
      )
    const lobes = floor(fract(landing.z.mul(7.13)).mul(5)).add(5)
    const teeth = sin(angle.mul(lobes).add(landing.z.mul(47)))
      .mul(0.12)
      .add(sin(angle.mul(lobes.add(4)).add(landing.z.mul(29))).mul(0.06))
      .add(0.82)
    material.localPosition = vec3(
      cos(angle).mul(radius),
      sin(p.y.mul(Math.PI)).mul(lift).mul(energy.mul(0.075).add(0.025)).mul(teeth).add(0.004),
      sin(angle).mul(radius),
    )
    const fade = smoothstep(0, 0.025, age).mul(
      float(1).sub(smoothstep(duration.mul(0.43), duration, age)),
    )
    material.opacityNode = fade.mul(sin(p.y.mul(Math.PI))).mul(energy.mul(0.28).add(0.18))
    material.alphaTest = 0.004
    material.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView))).mul(
      faceDirection,
    )
    this.mesh = new InstancedMesh(geometry, material, this.pool.length)
    this.mesh.name = 'splash-water-crowns'
    this.mesh.layers.set(SPLASH_IMPACT_LAYER)
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = 3
    scene.add(this.mesh)

    const slopeGeometry = new PlaneGeometry(1.8, 1.8, 8, 8).rotateX(-Math.PI / 2)
    slopeGeometry.setAttribute('aLanding', makeData())
    const slopeMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      toneMapped: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    slopeMaterial.fragmentNode = Fn(() => {
      const offset = uv().sub(0.5).mul(1.8)
      const r = offset.length(),
        radial = offset.div(max(r, 0.0001))
      const pixel = vec2(radial.dot(dFdx(offset)), radial.dot(dFdy(offset)))
      const variancePixel = pixel.dot(pixel).div(12)
      const life = smoothstep(0, 0.015, age).mul(float(1).sub(smoothstep(0.65, 1.35, age)))
      const slope = float(0).toVar(),
        variance = float(0).toVar()
      for (let i = 0; i < 3; i++) {
        const k = mix(0.9, 1.12, landing.z).mul(17 + i * 23)
        const omega = k.mul(9.81).add(k.pow(3).mul(0.000074)).sqrt()
        const speed = k.pow2().mul(0.000222).add(9.81).div(omega.mul(2))
        const width = age.mul(0.055).add(0.045),
          packet = r.sub(0.035).sub(speed.mul(age))
        const w2 = width.pow2(),
          filtered = w2.add(variancePixel),
          frequency = w2.div(filtered)
        const envelope = width
          .div(filtered.sqrt())
          .mul(exp(packet.pow2().negate().div(filtered.mul(2))))
        const filter = exp(k.pow2().mul(-0.5).mul(variancePixel).mul(frequency))
        const phase = k.mul(r.sub(packet.mul(variancePixel).div(filtered))).sub(omega.mul(age))
        const amplitude = energy
          .mul(0.4)
          .add(0.09)
          .mul(life)
          .mul(exp(age.mul(-(1.8 + i * 0.45))))
        slope.addAssign(
          amplitude
            .mul(envelope)
            .mul(filter)
            .mul(frequency.mul(cos(phase)).sub(sin(phase).mul(packet).div(k.mul(filtered)))),
        )
        variance.addAssign(
          amplitude.pow2().mul(envelope.pow2()).mul(float(1).sub(filter.pow2())).mul(0.5),
        )
      }
      const cavityWidth = energy.mul(0.035).add(age.mul(0.07)).add(0.055),
        cavityW2 = cavityWidth.pow2().add(variancePixel)
      const cavity = energy
        .mul(0.04)
        .add(0.012)
        .mul(exp(age.mul(-12)))
        .mul(cos(age.mul(16)))
      slope.addAssign(
        cavity
          .mul(r)
          .div(cavityW2)
          .mul(exp(r.pow2().negate().div(cavityW2.mul(2)))),
      )
      slope.mulAssign(smoothstep(0, 0.008, r))
      const bubbleP = offset.mul(42).add(vec2(landing.z.mul(17), age.mul(0.6)))
      const cell = floor(bubbleP),
        f = fract(bubbleP).sub(0.5)
      const hash = (q: typeof cell) => fract(sin(q.dot(vec2(127.1, 311.7))).mul(43758.5453))
      const bubbles = float(1).sub(
        smoothstep(
          0.12,
          0.4,
          f
            .add(vec2(hash(cell), hash(cell.add(13))).mul(0.26))
            .sub(0.13)
            .length(),
        ),
      )
      const foam = bubbles
        .mul(exp(r.pow2().negate().div(energy.mul(0.028).add(0.007))))
        .mul(exp(age.mul(-6)))
        .mul(smoothstep(0.02, 0.06, age))
        .mul(energy.mul(0.65).add(0.15))
      return vec4(radial.mul(slope), variance, foam)
    })()
    this.slopes = new InstancedMesh(slopeGeometry, slopeMaterial, this.pool.length)
    this.slopes.name = 'splash-water-normal-packets'
    for (const mesh of [this.mesh, this.slopes]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.visible = false
      mesh.count = 0
    }
  }

  setWaterSurface(uniforms: LakeWaterMaterial['uniforms']) {
    for (const mesh of [this.mesh, this.slopes]) {
      // positionNode runs after instance placement; sample the shared surface
      // in those world coordinates while retaining the shaped local geometry.
      mesh.material.positionNode = Fn(() => {
        const world = positionLocal.xz
        const height = windFieldNode(world, float(0), uniforms).x.add(
          uniforms.uState.sample(fieldUvNode(world)).r,
        )
        return positionLocal.add(vec3(0, height, 0))
      })()
      mesh.material.needsUpdate = true
    }
  }

  add(x: number, z: number, time: number, energy: number) {
    this.landed++
    // A spray cluster collapses into one stronger disturbance instead of a
    // stack of identical circles. Individual simulation impulses still land.
    for (const impact of this.pool) {
      if (
        impact &&
        time >= impact.born &&
        time - impact.born < 0.1 &&
        Math.hypot(x - impact.x, z - impact.z) < 0.22
      ) {
        impact.energy = Math.min(1.5, Math.hypot(impact.energy, energy))
        return
      }
    }
    const seed = Math.sin(x * 12.9898 + z * 78.233 + time * 3.1) * 43758.5453
    this.pool[this.cursor] = { x, z, born: time, energy, seed: seed - Math.floor(seed) }
    this.cursor = (this.cursor + 1) % this.pool.length
  }

  update(time: number, reducedMotion = false) {
    const crownData = this.mesh.geometry.getAttribute('aLanding')
    const slopeData = this.slopes.geometry.getAttribute('aLanding')
    this.active = 0
    let crowns = 0
    for (let i = 0; i < this.pool.length; i++) {
      const impact = this.pool[i]
      const age = impact ? time - impact.born : LIFETIME
      if (!impact || age < 0 || age >= LIFETIME || reducedMotion) {
        this.pool[i] = null
        continue
      }
      this.transform.position.set(impact.x, WATER_LEVEL, impact.z)
      this.transform.updateMatrix()
      slopeData.setXYZ(this.active, age, impact.energy, impact.seed)
      this.slopes.setMatrixAt(this.active++, this.transform.matrix)
      if (age < 0.22 + impact.seed * 0.12 && impact.energy > 0.2) {
        crownData.setXYZ(crowns, age, impact.energy, impact.seed)
        this.mesh.setMatrixAt(crowns++, this.transform.matrix)
      }
    }
    crownData.needsUpdate = slopeData.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = this.slopes.instanceMatrix.needsUpdate = true
    this.mesh.count = crowns
    this.slopes.count = this.active
    this.mesh.visible = crowns > 0
    this.slopes.visible = this.active > 0
  }

  dispose() {
    for (const mesh of [this.mesh, this.slopes]) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      mesh.material.dispose()
      mesh.dispose()
    }
  }
}

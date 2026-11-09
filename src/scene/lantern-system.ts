import { exp, uniform, uv, vec4 } from 'three/tsl'
import {
  BoxGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { Camera, Scene } from 'three/webgpu'

import { GLOW_BLENDING } from './glow-blending'
import type { LakeLamp } from './lake-world'
import type { LandscapeState } from './landscape-state'
import { smoothstep } from './math'
import type { ResourceScope } from './resource-scope'

type Lamp = {
  source: LakeLamp
  light: PointLight
  bulb: Mesh<SphereGeometry, MeshBasicNodeMaterial>
  glow: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  color: Color
  glowStrength: { value: number }
  /** Light position the current cube map was rendered from. */
  shadowPosition: Vector3
}

type SceneHost = Readonly<{
  scene: Scene
  resources: ResourceScope
  /** Objects the engine removes from the scene on dispose. */
  objects: Object3D[]
  lowPower: boolean
}>

/**
 * The floating lanterns on the bank: a bulb, a camera-facing glow and a point light each. They
 * rise from the ground at nightfall, breathe and sway; only the brightest cast cube shadows.
 */
export class LanternSystem {
  readonly lamps: Lamp[] = []
  private readonly lowPower: boolean
  private shadowCursor = 0

  constructor(lamps: readonly LakeLamp[], host: SceneHost) {
    const { scene, resources, objects } = host
    this.lowPower = host.lowPower
    const bulbGeometry = new SphereGeometry(0.11, 6, 5)
    const glowGeometry = new PlaneGeometry(2.0, 2.0)
    resources.own(bulbGeometry)
    resources.own(glowGeometry)
    // Every cube shadow costs six caster renders plus a cube sample per lit pixel,
    // so only the brightest lanterns cast; the rest still light the bank.
    const shadowLamps = new Set(
      lamps
        .map((lamp, index) => ({ index, intensity: lamp.intensity }))
        .toSorted((a, b) => b.intensity - a.intensity)
        .slice(0, this.lowPower ? 1 : 2)
        .map((entry) => entry.index),
    )
    // One glow material serves every lantern: its strength is a per-object
    // uniform, so the node graph and pipeline are built once, not per lamp.
    const glowStrengths = new WeakMap<Object3D, { value: number }>()
    const glowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      ...GLOW_BLENDING,
      depthWrite: false,
      side: DoubleSide,
      // Fog would mix the opaque additive quad toward the fog colour and light up its square.
      fog: false,
    })
    const glowStrength = uniform(0).onObjectUpdate(({ object }) =>
      object ? (glowStrengths.get(object)?.value ?? 0) : 0,
    )
    const p = uv().sub(0.5).mul(2)
    const r = p.dot(p)
    glowMaterial.fragmentNode = vec4(
      uniform(new Color(0xffb46b))
        .mul(
          exp(r.mul(-39))
            .mul(0.76)
            .add(exp(r.mul(-5.5)).mul(0.095)),
        )
        .mul(glowStrength),
      1,
    )
    resources.own(glowMaterial)
    lamps.forEach((lamp, index) => {
      const bulb = new Mesh(
        bulbGeometry,
        new MeshBasicNodeMaterial({
          color: 0xffc37a,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      )
      // Waterfall and splashes draw at renderOrder 2; lamps must blend after them.
      bulb.renderOrder = 3
      bulb.position.set(lamp.x, lamp.y, lamp.z)
      scene.add(bulb)
      objects.push(bulb)
      resources.own(bulb.material)
      const light = new PointLight(0xffab5e, 22 * lamp.intensity, 8, 2)
      light.position.copy(bulb.position)
      if (shadowLamps.has(index)) this.castShadow(light, resources)
      scene.add(light)
      objects.push(light)
      const strength = { value: 0 }
      const glow = new Mesh(glowGeometry, glowMaterial)
      glowStrengths.set(glow, strength)
      glow.renderOrder = 3
      glow.position.copy(bulb.position)
      glow.frustumCulled = false
      scene.add(glow)
      objects.push(glow)
      this.lamps.push({
        source: lamp,
        light,
        bulb,
        glow,
        color: bulb.material.color.clone(),
        glowStrength: strength,
        shadowPosition: light.position.clone(),
      })
    })
  }

  get lights() {
    return this.lamps.map(({ light }) => light)
  }

  /** Bulbs and glows, for the benchmark's elimination groups. */
  get debugObjects() {
    return this.lamps.flatMap(({ bulb, glow }) => [bulb, glow])
  }

  /** A lantern only needs a cube map when it is one of the shadow casters. */
  private castShadow(light: PointLight, resources: ResourceScope) {
    light.castShadow = true
    light.shadow.autoUpdate = false
    resources.own(light.shadow)
    light.shadow.camera.layers.set(5)
    light.shadow.mapSize.setScalar(this.lowPower ? 256 : 512)
    light.shadow.camera.near = 0.08
    light.shadow.camera.far = light.distance || 30
    light.shadow.bias = -0.001
    light.shadow.normalBias = 0.035
  }

  /** Every cube map renders again on the next frame. */
  invalidateShadows() {
    for (const lamp of this.lamps) lamp.light.shadow.needsUpdate = true
  }

  /**
   * Lanterns sway slowly: refresh a cube map only once its lamp has drifted far enough to
   * reshape shadows, at most one lamp per frame in round-robin order.
   */
  updateShadows() {
    const threshold = this.lowPower ? 0.12 : 0.08
    const limit = threshold * threshold
    for (let i = 0; i < this.lamps.length; i++) {
      this.shadowCursor = (this.shadowCursor + 1) % this.lamps.length
      const lamp = this.lamps[this.shadowCursor]
      if (!lamp?.light.castShadow) continue
      if (lamp.shadowPosition.distanceToSquared(lamp.light.position) < limit) continue
      lamp.shadowPosition.copy(lamp.light.position)
      lamp.light.shadow.needsUpdate = true
      break
    }
  }

  /** `nightFade` 0–1 brings the lamps up at dusk; fog widens their halos. */
  update(state: Readonly<LandscapeState>, nightFade: number, fog: number, camera: Camera) {
    const { elapsed, reducedMotion, intro } = state
    for (const [index, lamp] of this.lamps.entries()) {
      lamp.bulb.visible = lamp.glow.visible = nightFade > 0
      const source = lamp.source
      const motion = Math.sin(elapsed * source.speed + source.phase)
      // Long, independent quiet intervals separate soft changes tied to the bobbing.
      // A subset stays steady, so the bank never pulses as one synchronized light.
      const active =
        reducedMotion || source.phase < Math.PI * 0.45
          ? 0
          : smoothstep(0.15, 0.7, Math.sin(elapsed * source.speed * 0.29 + source.phase * 1.7))
      const breathing = 1 + motion * (0.1 + source.amplitude * 0.6) * active
      const delay = (0.5 + 0.5 * Math.sin(source.phase)) * 0.16
      const emergence = reducedMotion ? nightFade : smoothstep(delay, 0.84 + delay, nightFade)
      const presence = smoothstep(0.12 + index * 0.045, 0.55 + index * 0.045, intro) * emergence
      const energy = presence * breathing
      const drift = reducedMotion ? 0 : motion * source.amplitude * emergence
      const sway = reducedMotion ? 0 : source.driftRadius * emergence
      const descent = reducedMotion ? 0 : (source.y - source.groundY + 0.25) * (1 - emergence)
      lamp.bulb.position.set(
        source.x + Math.sin(elapsed * source.speed * 0.73 + source.phase) * sway,
        source.y + drift - descent,
        source.z + Math.cos(elapsed * source.speed * 0.61 + source.phase * 1.3) * sway * 0.7,
      )
      lamp.light.position.copy(lamp.bulb.position)
      lamp.glow.position.copy(lamp.bulb.position)
      lamp.glow.quaternion.copy(camera.quaternion)
      lamp.light.intensity = 22 * source.intensity * energy
      // Fog round a lamp glows: a wider, brighter halo (the bloom softens it further).
      lamp.glow.scale.setScalar(1 + fog * 1.6)
      lamp.glowStrength.value = 1.15 * energy * (1 + fog * 0.9)
      lamp.bulb.material.opacity = presence
      lamp.bulb.material.color.copy(lamp.color).multiplyScalar(breathing * 1.6)
    }
  }
}

type Mote = Readonly<{
  x: number
  y: number
  z: number
  size: number
  phase: number
  speed: number
}>

/**
 * A few dim, square flecks drift in depth at night. They provide a living scale cue without
 * turning the open sky into a particle field.
 */
export class NightMotes {
  readonly mesh: InstancedMesh<BoxGeometry, MeshBasicNodeMaterial>
  private readonly motes: Mote[] = []
  private readonly transform = new Object3D()

  constructor(seed: number, mobile: boolean, host: SceneHost) {
    let randomState = (seed ^ 0x6a09e667) >>> 0
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return randomState / 0x1_0000_0000
    }
    const moteCount = mobile ? 6 : 16
    const moteGeometry = new BoxGeometry(1, 1, 1)
    const moteMaterial = new MeshBasicNodeMaterial({
      color: 0x5b7080,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const moteMesh = new InstancedMesh(moteGeometry, moteMaterial, moteCount)
    for (let index = 0; index < moteCount; index += 1) {
      const z = -11 - random() * 65
      const x = (random() - 0.5) * (mobile ? 23 : 110)
      const size = 0.03 + random() * 0.045
      const mote = {
        x,
        y: 1.5 + random() * 12,
        z,
        size,
        phase: random() * Math.PI * 2,
        speed: 0.11 + random() * 0.13,
      }
      this.motes.push(mote)
      this.transform.position.set(mote.x, mote.y, mote.z)
      this.transform.scale.setScalar(mote.size)
      this.transform.updateMatrix()
      moteMesh.setMatrixAt(index, this.transform.matrix)
    }
    moteMesh.instanceMatrix.needsUpdate = true
    moteMesh.computeBoundingSphere()
    this.mesh = moteMesh
    host.scene.add(moteMesh)
    host.objects.push(moteMesh)
    host.resources.own(moteGeometry)
    host.resources.own(moteMaterial)
  }

  update(state: Readonly<LandscapeState>, nightFade: number) {
    const { elapsed, intro, reducedMotion } = state
    const mesh = this.mesh
    mesh.visible = nightFade > 0
    mesh.material.opacity = smoothstep(0.25, 0.9, intro) * 0.2 * nightFade
    if (!mesh.visible || reducedMotion) return
    for (const [index, mote] of this.motes.entries()) {
      this.transform.position.set(
        mote.x + Math.sin(elapsed * mote.speed * 0.71 + mote.phase) * 0.11,
        mote.y + Math.sin(elapsed * mote.speed + mote.phase) * 0.22,
        mote.z,
      )
      this.transform.scale.setScalar(mote.size)
      this.transform.updateMatrix()
      mesh.setMatrixAt(index, this.transform.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }
}

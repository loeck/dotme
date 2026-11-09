import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  exp,
  float,
  max,
  positionLocal,
  pow,
  saturate,
  smoothstep,
  sin,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu'

import { required } from '../invariant'
import { flockRandom } from './bird-flock'
import { GLOW_BLENDING } from './glow-blending'
import { lakeIndex, sampleShore, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { smoothstep as smooth } from './math'

export const INSECTS = {
  /** Midge swarms over the shallows, and midges in each. */
  swarms: 4,
  lowPowerSwarms: 2,
  midges: 26,
  lowPowerMidges: 16,
  /** Dragonflies patrolling the near shore. */
  dragonflies: 2,
  lowPowerDragonflies: 1,
  /** Seconds a dragonfly hovers before it darts, and how long a dart takes. */
  hover: [0.7, 2.6] as const,
  dart: [0.22, 0.42] as const,
  /** Metres a dart covers. */
  reach: [1.2, 3.6] as const,
} as const

/** Where in front of the resting camera (at z = 16) a kind of insect keeps: x half-width, z range. */
type InsectArea = Readonly<{ halfWidth: number; near: number; far: number }>
/** Dragonflies patrol the water just off the viewer's own bank, midges dance a little further. */
const DRAGONFLY_AREA: InsectArea = { halfWidth: 6, near: 8, far: -3 }
const MIDGE_AREA: InsectArea = { halfWidth: 13, near: 8, far: -10 }

/**
 * Open water off the banks, where midges dance and dragonflies hunt: inside `area`, at least
 * 0.4 m from a bank and preferably within 1.9 m of one (the shore field saturates at 2 m),
 * `spacing` metres apart. Seeded, so a world always has the same patches.
 */
function shallowSpots(bed: LakeBed, seed: number, count: number, area: InsectArea, spacing = 4) {
  const random = flockRandom((seed ^ 0x1d6e5) >>> 0)
  const spots: Vector3[] = []
  for (const reach of [1.9, Infinity])
    for (let attempt = 0; attempt < 300 && spots.length < count; attempt++) {
      const x = (random() - 0.5) * 2 * area.halfWidth
      const z = area.far + random() * (area.near - area.far)
      const index = lakeIndex(bed, x, z)
      if (index < 0 || !bed.water[index]) continue
      const shore = sampleShore(bed, x, z)
      if (shore < 0.4 || shore > reach) continue
      if (spots.some((spot) => Math.hypot(spot.x - x, spot.z - z) < spacing)) continue
      spots.push(new Vector3(x, WATER_LEVEL, z))
    }
  return spots
}

export type Dragonfly = {
  home: Vector3
  position: Vector3
  from: Vector3
  to: Vector3
  /** Seconds left in the current hover or dart. */
  left: number
  /** Length of the current dart, seconds; 0 while hovering. */
  dart: number
  phase: number
  heading: number
}

/**
 * A dragonfly's hover-and-dart: it holds a point, trembling a centimetre or two, then shoots a
 * metre or three to the next over its patch of shallows, easing in and out, and hovers again.
 * Pure apart from `random`.
 */
export function stepDragonfly(fly: Dragonfly, time: number, dt: number, random: () => number) {
  fly.left -= dt
  if (fly.left <= 0) {
    if (fly.dart > 0) {
      fly.dart = 0
      fly.left = INSECTS.hover[0] + random() * (INSECTS.hover[1] - INSECTS.hover[0])
      fly.from.copy(fly.to)
    } else {
      const angle = random() * Math.PI * 2
      const reach = INSECTS.reach[0] + random() * (INSECTS.reach[1] - INSECTS.reach[0])
      fly.from.copy(fly.position)
      fly.to.set(
        fly.from.x + Math.cos(angle) * reach,
        fly.home.y + 0.35 + random() * 0.9,
        fly.from.z + Math.sin(angle) * reach,
      )
      // Pull back toward its patch so it never wanders off the shallows.
      const away = Math.hypot(fly.to.x - fly.home.x, fly.to.z - fly.home.z)
      if (away > 3.5) {
        const back = 3.5 / away
        fly.to.x = fly.home.x + (fly.to.x - fly.home.x) * back
        fly.to.z = fly.home.z + (fly.to.z - fly.home.z) * back
      }
      fly.heading = Math.atan2(fly.to.x - fly.from.x, fly.to.z - fly.from.z)
      fly.dart = INSECTS.dart[0] + random() * (INSECTS.dart[1] - INSECTS.dart[0])
      fly.left = fly.dart
    }
  }
  if (fly.dart > 0) {
    const t = smooth(0, 1, 1 - fly.left / fly.dart)
    fly.position.lerpVectors(fly.from, fly.to, t)
  } else {
    const p = fly.phase
    fly.position.set(
      fly.from.x + Math.sin(time * 7.1 + p) * 0.015,
      fly.from.y + Math.sin(time * 5.3 + p * 2) * 0.02,
      fly.from.z + Math.cos(time * 6.2 + p) * 0.015,
    )
  }
}

/**
 * Daytime insects over the shallows: a couple of dragonflies darting along the near bank, and
 * a few midge swarms that are invisible until the sun stands low behind them, when each midge
 * catches the light as a faint fleck. Two small draws; midges move entirely in the shader.
 */
export class LakeInsects {
  readonly midges: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>
  readonly dragonflies: InstancedMesh<BufferGeometry, MeshBasicNodeMaterial>
  private readonly flies: Dragonfly[] = []
  private readonly random: () => number
  private readonly dummy = new Object3D()
  private readonly basis = { x: new Vector3(), y: new Vector3(), z: new Vector3() }
  private readonly frame = new Matrix4()
  private readonly uniforms = {
    time: uniform(0),
    intensity: uniform(0),
    sun: uniform(new Vector3(0, 1, 0)),
    sunColour: uniform(new Color(1, 0.85, 0.6)),
  }
  private presence = 0
  /** Midge swarms placed over the shallows. */
  readonly swarms: number

  constructor(bed: LakeBed, seed: number, lowPower: boolean) {
    this.random = flockRandom((seed ^ 0xd7a90) >>> 0)
    const swarms = shallowSpots(
      bed,
      seed,
      lowPower ? INSECTS.lowPowerSwarms : INSECTS.swarms,
      MIDGE_AREA,
    )
    const perSwarm = lowPower ? INSECTS.lowPowerMidges : INSECTS.midges
    const centres: number[] = [],
      motions: number[] = []
    for (const swarm of swarms) {
      const height = 1.4 + this.random() * 1.2
      for (let i = 0; i < perSwarm; i++) {
        centres.push(swarm.x, swarm.y + height, swarm.z)
        // Phase, rate and radius of each midge's own small loop in the column.
        motions.push(this.random() * 6.283, 0.8 + this.random() * 1.6, 0.12 + this.random() * 0.3)
      }
    }
    this.midges = this.midgeMesh(centres, motions)
    this.swarms = swarms.length
    const homes = shallowSpots(
      bed,
      seed ^ 0x77,
      lowPower ? INSECTS.lowPowerDragonflies : INSECTS.dragonflies,
      DRAGONFLY_AREA,
      3,
    )
    for (const home of homes) {
      const start = home.clone().setY(home.y + 0.6)
      this.flies.push({
        home,
        position: start.clone(),
        from: start.clone(),
        to: start.clone(),
        left: this.random() * 2,
        dart: 0,
        phase: this.random() * 6.283,
        heading: this.random() * 6.283,
      })
    }
    this.dragonflies = this.dragonflyMesh(Math.max(1, homes.length))
    this.dragonflies.count = homes.length
  }

  private midgeMesh(centres: number[], motions: number[]) {
    const plane = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.index = plane.index
    geometry.setAttribute('position', required(plane.attributes.position))
    geometry.setAttribute('uv', required(plane.attributes.uv))
    geometry.setAttribute('aCentre', new InstancedBufferAttribute(new Float32Array(centres), 3))
    geometry.setAttribute('aMotion', new InstancedBufferAttribute(new Float32Array(motions), 3))
    geometry.instanceCount = centres.length / 3
    plane.dispose()
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      ...GLOW_BLENDING,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    const { time, intensity, sun, sunColour } = this.uniforms
    const motion = attribute<'vec3'>('aMotion')
    const t = time.mul(motion.y).add(motion.x)
    // A midge loops and bobs in its column; the swarm sways as one.
    const offset = vec3(
      sin(t.mul(1.7))
        .mul(motion.z)
        .add(sin(time.mul(0.4).add(motion.x.mul(0.1))).mul(0.15)),
      sin(t.mul(2.3)).mul(motion.z.mul(1.6)),
      cos(t.mul(1.3)).mul(motion.z),
    )
    const world = attribute<'vec3'>('aCentre').add(offset)
    const view = cameraViewMatrix.mul(vec4(world, 1))
    // Never under about a pixel and a half: a real midge is a fraction of one across the lake.
    const size = max(0.012, view.z.negate().mul(0.0034))
    material.vertexNode = cameraProjectionMatrix.mul(
      vec4(view.xy.add(positionLocal.xy.mul(size)), view.z, view.w),
    )
    // Wings flash forward-scattered sunlight only when the sun stands low behind the swarm.
    const toward = varying(world.sub(cameraPosition).normalize())
    const forward = pow(saturate(toward.dot(sun)), 4)
    const low = float(1).sub(smoothstep(0.25, 0.6, sun.y))
    const twinkle = sin(time.mul(23).add(motion.x.mul(7)))
      .mul(0.35)
      .add(0.65)
    const p = uv().sub(0.5).mul(2)
    const dot = exp(p.dot(p).mul(-6))
    // Bright enough to sparkle against the sun's own haze, as a glint does.
    material.colorNode = sunColour.mul(2.5)
    material.opacityNode = dot.mul(forward.mul(low).mul(0.9).add(0.03)).mul(twinkle).mul(intensity)
    const mesh = new Mesh(geometry, material)
    mesh.name = 'Midges'
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    mesh.visible = false
    return mesh
  }

  private dragonflyMesh(count: number) {
    // Seen from a few metres, a dark body with two pairs of glassy wings: a cross.
    const positions = [
      // Body, a thin dark wedge 7 cm long.
      0, 0, 0.035, 0.004, 0, -0.035, -0.004, 0, -0.035,
      // Fore- and hindwings, 9 cm across, as two thin quads.
      -0.045, 0, 0.012, 0.045, 0, 0.012, 0.045, 0, 0.002, -0.045, 0, 0.012, 0.045, 0, 0.002, -0.045,
      0, 0.002, -0.042, 0, -0.002, 0.042, 0, -0.002, 0.042, 0, -0.012, -0.042, 0, -0.002, 0.042, 0,
      -0.012, -0.042, 0, -0.012,
    ]
    const colours: number[] = []
    for (let i = 0; i < positions.length / 3; i++)
      colours.push(...(i < 3 ? [0.02, 0.04, 0.045] : [0.3, 0.33, 0.35]))
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new Float32BufferAttribute(colours, 3))
    const material = new MeshBasicNodeMaterial({ side: DoubleSide, vertexColors: true })
    const mesh = new InstancedMesh(geometry, material, count)
    mesh.name = 'Dragonflies'
    mesh.frustumCulled = false
    mesh.visible = false
    return mesh
  }

  /**
   * `intensity` 0–1 from warmth, season, light and weather; `sun` points to the sun and
   * `sunColour` is its light, for the midges' glints; `viewer` is the camera's position.
   */
  update(
    time: number,
    dt: number,
    intensity: number,
    sun: Readonly<Vector3>,
    sunColour: Readonly<Color>,
    viewer: Readonly<Vector3>,
  ) {
    const { uniforms } = this
    uniforms.time.value = time
    uniforms.sun.value.copy(sun)
    uniforms.sunColour.value.copy(sunColour)
    this.presence += (intensity - this.presence) * (1 - Math.exp(-dt / 1.5))
    if (Math.abs(this.presence - intensity) < 0.002) this.presence = intensity
    uniforms.intensity.value = this.presence
    this.midges.visible = this.presence > 0.005
    // Dragonflies come out one at a time as it warms, rather than fading as ghosts.
    let shown = 0
    for (const [index, fly] of this.flies.entries()) {
      const out = this.presence > ((index + 0.5) / this.flies.length) * 0.7
      if (!out) {
        this.dragonflies.setMatrixAt(index, this.dummy.matrix.makeScale(0, 0, 0))
        continue
      }
      shown++
      stepDragonfly(fly, time, dt, this.random)
      this.dummy.position.copy(fly.position)
      // From the bank a level dragonfly is seen almost edge-on, a line under a pixel tall; it
      // is drawn tipped halfway toward the viewer so its wings read as a small cross.
      const { x, y, z } = this.basis
      y.set(viewer.x - fly.position.x, 0, viewer.z - fly.position.z).normalize()
      y.y = 1
      y.normalize()
      z.set(Math.sin(fly.heading), 0, Math.cos(fly.heading))
      x.crossVectors(y, z).normalize()
      z.crossVectors(x, y)
      this.dummy.quaternion.setFromRotationMatrix(this.frame.makeBasis(x, y, z))
      // A 7 cm insect, a little enlarged so a few metres off it still reads as wings and body.
      this.dummy.scale.setScalar(1.25)
      this.dummy.updateMatrix()
      this.dragonflies.setMatrixAt(index, this.dummy.matrix)
    }
    this.dragonflies.visible = shown > 0
    if (shown > 0 || this.dragonflies.visible) this.dragonflies.instanceMatrix.needsUpdate = true
  }

  get flyCount() {
    return this.flies.length
  }

  clear() {
    this.presence = 0
    this.uniforms.intensity.value = 0
    this.midges.visible = false
    this.dragonflies.visible = false
  }

  dispose() {
    for (const mesh of [this.midges, this.dragonflies]) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    this.dragonflies.dispose()
  }
}

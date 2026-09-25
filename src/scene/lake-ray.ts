import { float, max, mix, positionLocal, sin, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl'
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Euler,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu'
import type { Node, Scene } from 'three/webgpu'

import { required } from '../invariant'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { FISH_LAYER, bedDepth } from './lake-fish'
import { seabedHash } from './lake-seabed'
import { contactNoise } from './water-noise'

export type RayCircuit = Readonly<{
  cx: number
  cz: number
  rx: number
  rz: number
  phase: number
  depth: number
}>

const RAY_FOOTPRINT_OFFSETS = [
  [0, 0],
  [1.55, 0],
  [-1.55, 0],
  [0, 1.55],
  [0, -1.55],
  [1.1, 1.1],
  [1.1, -1.1],
  [-1.1, 1.1],
  [-1.1, -1.1],
] as const

/** Clearance for the whole disc, including the swept-back wingtips. */
function rayFootprintDepth(bed: LakeBed, x: number, z: number) {
  let depth = Infinity
  for (const [dx, dz] of RAY_FOOTPRINT_OFFSETS) {
    const at = lakeIndex(bed, x + dx, z + dz)
    if (at < 0 || !bed.water[at] || required(bed.obstacle[at]) > WATER_LEVEL - 0.5) return 0
    depth = Math.min(depth, bedDepth(bed, x + dx, z + dz))
  }
  return depth
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

export function selectRayCircuit(bed: LakeBed, seed: number): RayCircuit {
  let best: RayCircuit = { cx: 0, cz: -18, rx: 5, rz: 4, phase: 0, depth: 1.1 }
  let bestClearance = -1
  let bestCoverage = -1
  const n = bed.resolution
  const cell = LAKE_BOUNDS.size / n
  const deepCells: { order: number; x: number; z: number }[] = []
  for (let gz = 0; gz < n; gz += 6) {
    for (let gx = 0; gx < n; gx += 6) {
      const x = LAKE_BOUNDS.minX + (gx + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (gz + 0.5) * cell
      if (Math.abs(x) > 14 || z < -32 || z > -4) continue
      const at = lakeIndex(bed, x, z)
      if (at < 0 || !required(bed.water[at]) || required(bed.depth[at]) < 2.4) continue
      deepCells.push({ order: seabedHash(Math.imul(gz * n + gx + 1, 0x51ed) ^ seed), x, z })
    }
  }
  deepCells.sort((a, b) => a.order - b.order)
  const candidates: { cx: number; cz: number; rx: number; rz: number; phase: number }[] = []
  for (const [i, deepCell] of deepCells.slice(0, 16).entries()) {
    const key = (seed ^ Math.imul(i + 101, 0x9e3779b9)) | 0
    candidates.push({
      cx: deepCell.x,
      cz: deepCell.z,
      rx: 3 + seabedHash(key ^ 0x22) * 2.5,
      rz: 2.5 + seabedHash(key ^ 0x33) * 2,
      phase: seabedHash(key ^ 0x44) * Math.PI * 2,
    })
  }
  for (let c = 0; c < 24; c++) {
    const key = (seed ^ Math.imul(c + 1, 0x9e3779b9)) | 0
    candidates.push({
      cx: (seabedHash(key) - 0.5) * 20,
      cz: -18 + (seabedHash(key ^ 0x11) - 0.5) * 22,
      rx: 4 + seabedHash(key ^ 0x22) * 3,
      rz: 3 + seabedHash(key ^ 0x33) * 3,
      phase: seabedHash(key ^ 0x44) * Math.PI * 2,
    })
  }
  for (const { cx, cz, rx, rz, phase } of candidates) {
    const circuit = { cx, cz, rx, rz, phase, depth: 1.1 }
    let clearance = Infinity
    let wet = 0
    let samples = 0
    for (let t = 0; t < 210; t += 0.5) {
      const { x, z } = rayXZ(circuit, t)
      const at = lakeIndex(bed, x, z)
      samples++
      if (at < 0 || !required(bed.water[at])) {
        clearance = -1
        continue
      }
      const depth = rayFootprintDepth(bed, x, z)
      clearance = Math.min(clearance, depth)
      if (depth >= 0.7) wet++
    }
    const coverage = wet / samples
    if (clearance >= 1.8 && clearance > bestClearance) {
      best = { ...circuit, depth: Math.max(1.2, Math.min(2.2, clearance - 1)) }
      bestClearance = clearance
    } else if (bestClearance < 1.8 && coverage > bestCoverage) {
      best = circuit
      bestCoverage = coverage
    }
  }
  return best
}

function rayXZ(circuit: RayCircuit, time: number) {
  const breathe = 1 + 0.15 * Math.sin(time * 0.031 + circuit.phase)
  const a = time * 0.12 + circuit.phase
  return {
    x: circuit.cx + Math.cos(a) * circuit.rx * breathe,
    z: circuit.cz + Math.sin(a) * circuit.rz * breathe,
  }
}

export function rayPose(circuit: RayCircuit, time: number) {
  const { x, z } = rayXZ(circuit, time)
  return { x, y: WATER_LEVEL - circuit.depth + 0.055 * Math.sin(time * 0.35 + circuit.phase), z }
}

const RAY_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.72],
  [Math.PI / 4, 1.05],
  [Math.PI / 2, 1.42],
  [(120 * Math.PI) / 180, 1.55],
  [(140 * Math.PI) / 180, 1.0],
  [(160 * Math.PI) / 180, 0.66],
  [Math.PI, 0.55],
]

export function rayOutlineRadius(theta: number): number {
  let a = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  if (a > Math.PI) a = Math.PI * 2 - a
  const stops = RAY_OUTLINE
  for (let i = 0; i < stops.length - 1; i++) {
    const [a0, r0] = required(stops[i])
    const [a1, r1] = required(stops[i + 1])
    if (a <= a1) {
      const s = (1 - Math.cos(((a - a0) / (a1 - a0)) * Math.PI)) / 2
      return r0 + (r1 - r0) * s
    }
  }
  return required(stops[stops.length - 1])[1]
}

function buildRayDisc() {
  const segments = 64
  const rings = 7
  const positions = [0, 0.09, 0]
  const uvs: number[] = []
  const pushUV = (x: number, z: number) => uvs.push((x + 1.4) / 2.8, (z + 0.6) / 1.4)
  pushUV(0, 0)
  for (let j = 1; j <= rings; j++) {
    const f = j / rings
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2
      const r = rayOutlineRadius(theta) * f
      const x = Math.sin(theta) * r
      const z = Math.cos(theta) * r
      positions.push(x, 0.02 + 0.07 * (1 - f * f), z)
      pushUV(x, z)
    }
  }
  const index: number[] = []
  for (let i = 0; i < segments; i++) {
    index.push(0, 1 + i, 1 + ((i + 1) % segments))
  }
  for (let j = 1; j < rings; j++) {
    const inner = 1 + (j - 1) * segments
    const outer = 1 + j * segments
    for (let i = 0; i < segments; i++) {
      const i0 = inner + i
      const i1 = inner + ((i + 1) % segments)
      const o0 = outer + i
      const o1 = outer + ((i + 1) % segments)
      index.push(i0, o1, i1, i0, o0, o1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

function wingFlapNode(flapTime: Node<'float'>, amplitude: Node<'float'>) {
  const span = positionLocal.x.abs().div(1.42).pow(1.55)
  const trailing = max(0, float(0.6).sub(positionLocal.z))
  const wave = flapTime.sub(trailing.mul(2.1)).sub(positionLocal.x.abs().mul(0.3))
  return positionLocal.add(
    vec3(
      0,
      sin(wave)
        .mul(span)
        .mul(float(0.72).add(trailing.mul(0.22)))
        .mul(amplitude),
      0,
    ),
  )
}

function tailSwayNode(flapTime: Node<'float'>) {
  return positionLocal.add(
    vec3(
      sin(flapTime.mul(2).add(positionLocal.z.mul(3)))
        .mul(max(0, positionLocal.z.negate().sub(0.5)))
        .mul(0.08),
      0,
      0,
    ),
  )
}

/** A spotted ray gliding between the surface and the sand. */
export class LakeRay {
  private readonly circuit: RayCircuit
  readonly group = new Group()
  readonly disc: Mesh
  readonly wake = { x: 0, z: -400, hx: 0, hz: 1, speed: 0 }
  private lastWake: { x: number; z: number; t: number } | null = null
  private readonly shadow: Mesh
  private readonly flapTime = uniform(0)
  private readonly flapAmplitude = uniform(0.28)
  private readonly shadowStrength = uniform(0.38)
  private readonly euler = new Euler(0, 0, 0, 'YXZ')
  private smoothY: number | null = null
  private heading = 0
  private speed = 0
  private bank = 0
  private alert = 0
  private readonly bed: LakeBed
  private readonly reducedMotion: boolean
  private readonly geometries: { dispose(): void }[] = []
  private readonly topMaterial = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.65,
    side: FrontSide,
    fog: false,
  })
  private readonly bellyMaterial = new MeshStandardNodeMaterial({
    color: 0xdfe4e2,
    roughness: 0.7,
    side: BackSide,
    fog: false,
  })
  private readonly tailMaterial = new MeshStandardNodeMaterial({
    color: 0x232b2e,
    roughness: 0.7,
    fog: false,
  })
  private readonly shadowMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
  })

  constructor(scene: Scene, bed: LakeBed, seed: number, reducedMotion = false) {
    this.bed = bed
    this.reducedMotion = reducedMotion
    this.circuit = selectRayCircuit(bed, seed)
    const disc = buildRayDisc()
    this.geometries.push(disc)
    const spots = smoothstep(
      0.8,
      0.86,
      contactNoise(
        uv()
          .mul(13)
          .add(vec2(seabedHash(seed) * 8, seabedHash(seed ^ 1) * 8)),
      ),
    )
    const rim = smoothstep(0.32, 0.48, uv().sub(0.5).length())
    this.topMaterial.colorNode = mix(vec3(0.05, 0.07, 0.08), vec3(0.62, 0.65, 0.6), spots).mul(
      float(1).sub(rim.mul(0.4)),
    )
    this.topMaterial.positionNode = wingFlapNode(this.flapTime, this.flapAmplitude)
    this.bellyMaterial.positionNode = wingFlapNode(this.flapTime, this.flapAmplitude)
    this.tailMaterial.positionNode = tailSwayNode(this.flapTime)
    const top = new Mesh(disc, this.topMaterial)
    this.disc = top
    const belly = new Mesh(disc, this.bellyMaterial)
    const tail = new CylinderGeometry(0.02, 0.005, 1.8, 5)
    this.geometries.push(tail)
    tail.rotateX(Math.PI / 2)
    tail.translate(0, 0, -1.5)
    const tailMesh = new Mesh(tail, this.tailMaterial)
    this.group.add(top, belly, tailMesh)
    this.group.traverse((object) => {
      object.layers.set(FISH_LAYER)
    })
    this.group.frustumCulled = false
    scene.add(this.group)
    const shadowGeometry = new CircleGeometry(1, 20)
    this.geometries.push(shadowGeometry)
    shadowGeometry.rotateX(-Math.PI / 2)
    this.shadowMaterial.colorNode = vec3(0)
    this.shadowMaterial.opacityNode = float(1)
      .sub(smoothstep(0.18, 0.5, uv().sub(0.5).length()))
      .mul(this.shadowStrength)
    this.shadow = new Mesh(shadowGeometry, this.shadowMaterial)
    this.shadow.scale.set(1.3, 1, 1)
    this.shadow.layers.set(1)
    this.shadow.frustumCulled = false
    scene.add(this.shadow)
    this.update(0)
  }

  update(
    time: number,
    dt = 1 / 60,
    pointer: Readonly<{ x: number; z: number }> | null = null,
    pointerActivity = 1,
  ) {
    const t = this.reducedMotion ? 0 : time
    const step = this.reducedMotion ? 0 : Math.max(0, Math.min(2, dt))
    const guide = rayPose(this.circuit, t)
    const ahead = rayPose(this.circuit, t + 0.35)
    const behind = rayPose(this.circuit, t - 0.35)
    const tangentX = ahead.x - behind.x
    const tangentZ = ahead.z - behind.z
    const tangentLength = Math.max(0.001, Math.hypot(tangentX, tangentZ))
    if (this.smoothY === null) {
      this.group.position.set(guide.x, guide.y, guide.z)
      this.heading = Math.atan2(tangentX, tangentZ)
      this.speed = tangentLength / 0.7
    }
    const x = this.group.position.x
    const z = this.group.position.z
    const separation = pointer ? Math.hypot(x - pointer.x, z - pointer.z) : Infinity
    const proximity = Math.max(0, 1 - separation / 5.5)
    const alarm = pointerActivity * proximity * proximity
    this.alert += (alarm - this.alert) * (1 - Math.exp(-step * (alarm > this.alert ? 3 : 1.2)))

    const substeps = Math.max(1, Math.ceil(step / 0.1))
    const h = step / substeps
    let turnRate = 0
    for (let i = 0; i < substeps; i++) {
      const sampleTime = t - step + (i + 1) * h
      const waypoint = rayPose(this.circuit, sampleTime)
      const forward = rayPose(this.circuit, sampleTime + 0.35)
      const backward = rayPose(this.circuit, sampleTime - 0.35)
      const pathX = forward.x - backward.x
      const pathZ = forward.z - backward.z
      let vx = pathX / 0.7 + (waypoint.x - this.group.position.x) * 0.65
      let vz = pathZ / 0.7 + (waypoint.z - this.group.position.z) * 0.65
      if (pointer) {
        const dx = this.group.position.x - pointer.x
        const dz = this.group.position.z - pointer.z
        const distance = Math.hypot(dx, dz)
        if (distance > 0.01) {
          vx += (dx / distance) * this.alert * 1.25
          vz += (dz / distance) * this.alert * 1.25
        }
      }
      const desired = Math.atan2(vx, vz)
      const turn = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading))
      const amount = clamp(turn * (1 - Math.exp(-h * 2.4)), -h * 1.15, h * 1.15)
      this.heading += amount
      turnRate = h > 0 ? amount / h : 0
      const targetSpeed =
        Math.min(1.25, Math.hypot(vx, vz)) * (0.45 + 0.55 * Math.max(0, Math.cos(turn)))
      this.speed += clamp(targetSpeed - this.speed, -h * 0.75, h * 0.6)
      const nextX = this.group.position.x + Math.sin(this.heading) * this.speed * h
      const nextZ = this.group.position.z + Math.cos(this.heading) * this.speed * h
      if (rayFootprintDepth(this.bed, nextX, nextZ) >= 1.2)
        this.group.position.set(nextX, this.group.position.y, nextZ)
    }
    const depth = rayFootprintDepth(this.bed, this.group.position.x, this.group.position.z)
    this.group.visible = depth >= 1.2
    const margin = Math.min(0.72, depth * 0.5)
    const target = this.group.visible
      ? clamp(guide.y, WATER_LEVEL - depth + margin, WATER_LEVEL - margin)
      : guide.y
    const blend = this.smoothY === null ? 1 : 1 - Math.exp(-step * 3)
    const nextY = (this.smoothY ?? target) + (target - (this.smoothY ?? target)) * blend
    this.smoothY = this.group.visible
      ? clamp(nextY, WATER_LEVEL - depth + margin, WATER_LEVEL - margin)
      : nextY
    this.group.position.y = this.smoothY
    this.bank += (clamp(-turnRate * 0.12, -0.12, 0.12) - this.bank) * (1 - Math.exp(-step * 2.5))
    const climb = clamp(ahead.y - behind.y, -0.1, 0.1)
    this.group.quaternion.setFromEuler(this.euler.set(-climb * 0.35, this.heading, this.bank))
    this.flapTime.value += step * (3.1 + this.speed * 1.3 + this.alert * 1.3)
    const available = Math.min(
      WATER_LEVEL - this.group.position.y,
      this.group.position.y - (WATER_LEVEL - depth),
    )
    const amplitude = clamp(
      0.17 + this.speed * 0.07 + this.alert * 0.1,
      0.08,
      Math.min(0.35, (available - 0.28) / 1.2),
    )
    this.flapAmplitude.value += (amplitude - this.flapAmplitude.value) * (1 - Math.exp(-step * 3))
    this.flapAmplitude.value = Math.min(this.flapAmplitude.value, amplitude)

    const previous = this.lastWake
    this.lastWake = { x: this.group.position.x, z: this.group.position.z, t }
    const raw =
      previous && t > previous.t
        ? Math.hypot(this.group.position.x - previous.x, this.group.position.z - previous.z) /
          (t - previous.t)
        : 0
    const targetWake = this.group.visible ? Math.min(3, raw) : 0
    this.wake.speed += (targetWake - this.wake.speed) * (1 - Math.exp(-step * 3))
    this.wake.x = this.group.position.x
    this.wake.z = this.group.position.z
    this.wake.hx = Math.sin(this.heading)
    this.wake.hz = Math.cos(this.heading)
    this.shadow.visible = this.group.visible
    if (!this.group.visible) return
    const floor = WATER_LEVEL - bedDepth(this.bed, this.group.position.x, this.group.position.z)
    const height = Math.max(0, this.group.position.y - floor)
    const follow = 1 - Math.exp(-step * 2.5)
    if (!previous)
      this.shadow.position.set(this.group.position.x, floor + 0.05, this.group.position.z)
    this.shadow.position.x += (this.group.position.x - this.shadow.position.x) * follow
    this.shadow.position.z += (this.group.position.z - this.shadow.position.z) * follow
    this.shadow.position.y =
      WATER_LEVEL - bedDepth(this.bed, this.shadow.position.x, this.shadow.position.z) + 0.05
    const spread = 1 + height * 0.12
    this.shadow.scale.set(1.3 * spread, 1, spread)
    this.shadowStrength.value = 0.38 / (1 + height * 0.55)
  }

  dispose() {
    this.group.removeFromParent()
    this.shadow.removeFromParent()
    for (const geometry of this.geometries) geometry.dispose()
    this.topMaterial.dispose()
    this.bellyMaterial.dispose()
    this.tailMaterial.dispose()
    this.shadowMaterial.dispose()
  }
}

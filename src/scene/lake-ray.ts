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
      const depth = required(bed.depth[at])
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
  return { x, y: WATER_LEVEL - circuit.depth + 0.25 * Math.sin(time * 0.5 + circuit.phase), z }
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

function wingFlapNode(flapTime: Node<'float'>) {
  const burst = float(0.55).add(float(0.45).mul(sin(flapTime.mul(0.4))))
  return positionLocal.add(
    vec3(
      0,
      sin(flapTime.mul(1.6)).mul(positionLocal.x.abs().div(1.34).pow(1.5)).mul(0.42).mul(burst),
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
  private readonly euler = new Euler(0, 0, 0, 'YXZ')
  private smoothY: number | null = null
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
    this.topMaterial.positionNode = wingFlapNode(this.flapTime)
    this.bellyMaterial.positionNode = wingFlapNode(this.flapTime)
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
      .mul(0.38)
    this.shadow = new Mesh(shadowGeometry, this.shadowMaterial)
    this.shadow.scale.set(1.3, 1, 1)
    this.shadow.layers.set(1)
    this.shadow.frustumCulled = false
    scene.add(this.shadow)
    this.update(0)
  }

  update(time: number, dt = 1 / 60) {
    const t = this.reducedMotion ? 0 : time
    const now = rayPose(this.circuit, t)
    const ahead = rayPose(this.circuit, t + 0.5)
    const behind = rayPose(this.circuit, t - 0.5)
    const yaw = Math.atan2(ahead.x - behind.x, ahead.z - behind.z)
    const climb = Math.max(-0.4, Math.min(0.4, ahead.y - behind.y))
    const at = lakeIndex(this.bed, now.x, now.z)
    const wet = at >= 0 && required(this.bed.water[at]) !== 0
    const depth = wet ? bedDepth(this.bed, now.x, now.z) : 0
    this.group.visible = wet && required(this.bed.depth[at]) >= 0.8
    const target = this.group.visible
      ? Math.max(Math.min(now.y, WATER_LEVEL - 0.7), WATER_LEVEL - depth + 0.35)
      : now.y
    const blend = this.smoothY === null ? 1 : 1 - Math.exp(-Math.max(0, dt) * 4)
    const current = this.smoothY ?? target
    this.smoothY = current + (target - current) * blend
    this.group.position.set(now.x, this.smoothY, now.z)
    this.group.quaternion.setFromEuler(
      this.euler.set(-climb * 0.5 + 0.12 * Math.sin(t * 0.9), yaw, 0.12),
    )
    this.flapTime.value = t
    const previous = this.lastWake
    this.lastWake = { x: now.x, z: now.z, t }
    const raw =
      previous && t > previous.t
        ? Math.hypot(now.x - previous.x, now.z - previous.z) / (t - previous.t)
        : 0
    const targetSpeed = this.group.visible ? Math.min(3, raw) : 0
    this.wake.speed += (targetSpeed - this.wake.speed) * (1 - Math.exp(-Math.max(0, dt) * 3))
    this.wake.x = now.x
    this.wake.z = now.z
    this.wake.hx = Math.sin(yaw)
    this.wake.hz = Math.cos(yaw)
    this.shadow.visible = this.group.visible
    if (!this.group.visible) return
    this.shadow.position.set(now.x, WATER_LEVEL - depth + 0.05, now.z)
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

import {
  Fn,
  attribute,
  positionLocal,
  normalLocal,
  positionWorld,
  cameraPosition,
  cameraViewMatrix,
  cameraProjectionMatrix,
  max,
  float,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  InstancedBufferAttribute,
  DoubleSide,
  MeshStandardNodeMaterial,
  Object3D,
} from 'three/webgpu'
import type { Scene, NodeBuilder } from 'three/webgpu'

import { required } from '../invariant'
import { createFishGeometry, fishRigNode } from './fish-anatomy'
import type { FishSpecies } from './fish-anatomy'
import { sampleFishPointer } from './fish-pointer'
import type { FishPointerTarget } from './fish-pointer'
import { createFishSchools, sampleSchoolFish, schoolVisibility } from './fish-school'
import type { FishSchool } from './fish-school'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { FireflyPointer } from './lake-fireflies'

export type { FishSpecies } from './fish-anatomy'

export const FISH_LAYER = 3

type WaterPointer = Readonly<{ x: number; z: number; strength?: number }>
type FishHabitat = Readonly<{ x: number; z: number }>
type FishPose = { x: number; y: number; z: number; heading: number }
export type FishAppearance = Readonly<{
  species: FishSpecies
  scale: number
  rate: number
  phase: number
  tone: number
}>

const HABITAT_RADIUS = 0.85
const BODY_MARGIN = 0.8
const MIN_DEPTH = 1.65

/** Match the captured bed's cell-centered relief without snapping between cells. */
export function bedDepth(bed: LakeBed, x: number, z: number) {
  const n = bed.resolution
  const gridX = ((x - LAKE_BOUNDS.minX) * n) / LAKE_BOUNDS.size - 0.5
  const gridZ = ((z - LAKE_BOUNDS.minZ) * n) / LAKE_BOUNDS.size - 0.5
  const column = Math.max(0, Math.min(n - 2, Math.floor(gridX)))
  const row = Math.max(0, Math.min(n - 2, Math.floor(gridZ)))
  const u = Math.max(0, Math.min(1, gridX - column))
  const v = Math.max(0, Math.min(1, gridZ - row))
  const i = row * n + column
  const near = required(bed.depth[i]) * (1 - u) + required(bed.depth[i + 1]) * u
  const far = required(bed.depth[i + n]) * (1 - u) + required(bed.depth[i + n + 1]) * u
  return near * (1 - v) + far * v
}

function swimmingHeight(
  bed: LakeBed,
  x: number,
  z: number,
  time: number,
  phase: number,
  visibility: number,
) {
  let depth = Infinity
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      depth = Math.min(depth, bedDepth(bed, x + dx * BODY_MARGIN, z + dz * BODY_MARGIN))
  // Follow the highest relief under the entire silhouette, including turns.
  // Retain belly/fin clearance when a deeper shoal crosses sloping relief.
  const cruiseDepth = 1.37 + 0.3 * (0.5 + 0.5 * Math.sin(phase)) + (1 - visibility) * 0.55
  return WATER_LEVEL - Math.min(depth - 0.38, cruiseDepth) + Math.sin(time * 0.4 + phase) * 0.035
}

function randomGenerator(seed: number) {
  let state = (seed ^ 0x683ac71d) >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** Validate every covered cell, including the fish body and its escape distance. */
function safeHabitat(bed: LakeBed, x: number, z: number) {
  const radius = HABITAT_RADIUS + BODY_MARGIN
  const first = lakeIndex(bed, x - radius, z - radius)
  const last = lakeIndex(bed, x + radius, z + radius)
  if (first < 0 || last < 0) return false
  const n = bed.resolution
  for (let row = Math.floor(first / n); row <= Math.floor(last / n); row++) {
    for (let column = first % n; column <= last % n; column++) {
      const i = row * n + column
      if (
        !bed.water[i] ||
        required(bed.depth[i]) < MIN_DEPTH ||
        required(bed.obstacle[i]) >= WATER_LEVEL - 0.65
      )
        return false
    }
  }
  return true
}

/** Small protected swimming areas near visible shores, never on terrain cells. */
export function createFishHabitats(
  bed: LakeBed,
  seed: number,
  count: number,
  mobile = false,
): FishHabitat[] {
  const random = randomGenerator(seed)
  const habitats: FishHabitat[] = []
  const cell = LAKE_BOUNDS.size / bed.resolution
  const candidates: Array<FishHabitat & { score: number; foreground: boolean }> = []
  // A sampled seed should vary the shoals, not decide whether any are on screen.
  // Reserve each camera's central foreground for the opening shoal.
  for (let z = -34; z <= 5; z += cell * 2) {
    for (let x = -22; x <= 22; x += cell * 2) {
      const i = lakeIndex(bed, x, z)
      if (i < 0 || required(bed.depth[i]) < MIN_DEPTH) continue
      const centerX = LAKE_BOUNDS.minX + ((i % bed.resolution) + 0.5) * cell
      const centerZ = LAKE_BOUNDS.minZ + (Math.floor(i / bed.resolution) + 0.5) * cell
      const forward = 16 - centerZ
      const extent = Math.abs(centerX) + HABITAT_RADIUS + BODY_MARGIN
      // FOV 54°, 390/844 portrait and 16/9 desktop, with room for parallax.
      if (extent > forward * (mobile ? 0.21 : 0.7)) continue
      // Fish cruise near the surface even over a deep bed. Testing the bottom
      // depth here excluded the central lake and stranded shoals at the banks.
      if ((2.3 + 1.8 + 0.2) / forward > 0.33) continue
      if (!safeHabitat(bed, centerX, centerZ)) continue
      candidates.push({
        x: centerX,
        z: centerZ,
        foreground: centerZ > -8 && extent < forward * (mobile ? 0.21 : 0.55),
        score:
          Math.abs(required(bed.depth[i]) - 3.2) * 0.12 +
          Math.abs(centerZ - 2) * 0.12 +
          Math.abs(centerX) * 0.06 +
          random() * 0.12,
      })
    }
  }
  candidates.sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.score - b.score)
  for (const candidate of candidates) {
    if (habitats.length >= count) break
    if (habitats.some((area) => Math.hypot(area.x - candidate.x, area.z - candidate.z) < 3.6))
      continue
    habitats.push({ x: candidate.x, z: candidate.z })
  }
  return habitats
}

/** Deform anatomy before Three applies each instance's scale and heading. */
class FishMaterial extends MeshStandardNodeMaterial {
  override setupPosition(builder: NodeBuilder) {
    positionLocal.assign(fishRigNode(positionLocal))
    normalLocal.assign(fishRigNode(normalLocal, true))
    return super.setupPosition(builder)
  }
}

const SPECIES: readonly FishSpecies[] = ['carp', 'roach', 'perch']

/** Articulated shoals in three instanced anatomical variants. */
export class LakeFish {
  readonly habitats: readonly FishHabitat[]
  readonly count: number
  /** The other two batches are children, preserving the single visibility switch. */
  readonly mesh: InstancedMesh
  readonly meshes: readonly InstancedMesh[]
  readonly appearances: readonly FishAppearance[]
  private readonly geometries = SPECIES.map(createFishGeometry)
  private readonly material = new FishMaterial({
    color: 0xffffff,
    roughness: 0.58,
    metalness: 0,
    envMapIntensity: 0.85,
    vertexColors: true,
    side: DoubleSide,
    transparent: true,
    depthWrite: true,
    fog: false,
  })
  private readonly transform = new Object3D()
  private readonly poses: FishPose[] = []
  readonly schools: readonly FishSchool[]
  readonly schoolSizes: readonly number[]
  private readonly membership: readonly { school: number; member: number }[]
  private clock = 0
  private readonly swimming: Array<{
    heading: number
    phase: number
    speed: number
    turn: number
    initialized: boolean
    routeX: number
    routeZ: number
    alert: number
  }> = []
  private readonly pointerTarget: FishPointerTarget = { x: 0, z: 0, strength: 0 }

  private readonly bed: LakeBed
  private readonly mobile: boolean
  private readonly reducedMotion: boolean

  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean, reducedMotion = false) {
    this.bed = bed
    this.mobile = mobile
    this.reducedMotion = reducedMotion
    this.habitats = createFishHabitats(bed, seed, 16, mobile)
    this.schools = createFishSchools(bed, this.habitats, seed, mobile ? 3 : 4)
    const sizes = mobile ? [6, 4, 5] : [8, 5, 7, 6]
    this.schoolSizes = this.schools.map((_, i) =>
      required(sizes[(i + (seed >>> 0)) % sizes.length]),
    )
    this.membership = this.schoolSizes.flatMap((size, school) =>
      Array.from({ length: size }, (_, member) => ({ school, member })),
    )
    this.count = this.membership.length
    // Muted silver backs read as little moving silhouettes, not golden patches.
    const silver = new Color(0x526d76)
    for (const geometry of this.geometries) {
      const colors = geometry.getAttribute('color')
      const color = new Color()
      for (let i = 0; i < colors.count; i++) {
        color.fromBufferAttribute(colors, i).lerp(silver, 0.15)
        colors.setXYZ(i, color.r, color.g, color.b)
      }
    }
    const random = randomGenerator(seed ^ 0x82ae)
    this.appearances = Array.from({ length: this.count }, (_, i) => {
      const species = required(SPECIES[i % 3])
      const schoolScale = required([1, 0.82, 0.92, 1.04][required(this.membership[i]).school])
      const scale = (0.8 + random() * 0.3) * schoolScale
      const rate =
        (species === 'carp' ? 0.76 : species === 'roach' ? 1.12 : 0.92) * (0.92 + random() * 0.16)
      return { species, scale, rate, phase: random() * Math.PI * 2, tone: 0.93 + random() * 0.07 }
    })
    this.meshes = this.geometries.map((geometry, speciesIndex) => {
      const count = Math.floor((this.count + 2 - speciesIndex) / 3)
      const mesh = new InstancedMesh(geometry, this.material, count)
      mesh.name = `Submerged ${SPECIES[speciesIndex]}`
      mesh.layers.set(FISH_LAYER)
      mesh.renderOrder = 1
      mesh.receiveShadow = true
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      for (let instance = 0; instance < count; instance++) {
        const traits = required(this.appearances[instance * 3 + speciesIndex])
        mesh.setColorAt(instance, new Color().setScalar(traits.tone))
      }
      geometry.setAttribute(
        'aFishMotion',
        new InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage),
      )
      geometry.setAttribute(
        'aFishPhase',
        new InstancedBufferAttribute(new Float32Array(count), 1).setUsage(DynamicDrawUsage),
      )
      geometry.setAttribute(
        'aFishVisibility',
        new InstancedBufferAttribute(new Float32Array(count), 1).setUsage(DynamicDrawUsage),
      )
      return mesh
    })
    this.mesh = required(this.meshes[0])
    this.mesh.add(required(this.meshes[1]), required(this.meshes[2]))
    for (let i = 0; i < this.count; i++) this.poses.push({ x: 0, y: 0, z: 0, heading: 0 })
    this.swimming = this.appearances.map((traits) => ({
      heading: 0,
      phase: traits.phase,
      speed: 0.4,
      turn: 0,
      initialized: false,
      routeX: 0,
      routeZ: 0,
      alert: 0,
    }))
    this.attachMotionShader()
    this.update(0, 0)
    for (const mesh of this.meshes) {
      // A shoal travels well beyond its initial foreground footprint.
      mesh.frustumCulled = false
    }
    scene.add(this.mesh)
  }

  private attachMotionShader() {
    this.material.opacityNode = attribute('aFishVisibility', 'float')
    this.material.vertexNode = Fn(() => {
      const world = positionWorld
      const depth = max(0, float(WATER_LEVEL).sub(world.y))
      const towardCamera = cameraPosition.xz.sub(world.xz)
      const horizontal = max(0.001, towardCamera.length())
      const cameraHeight = max(0.001, cameraPosition.y.sub(WATER_LEVEL))
      const offset = float(0).toVar()
      for (let i = 0; i < 3; i++) {
        const distance = max(0, horizontal.sub(offset))
        const sine = distance.div(distance.pow(2).add(cameraHeight.pow(2)).sqrt()).div(1.333)
        offset.assign(depth.mul(sine).div(float(1).sub(sine.pow(2)).sqrt()))
      }
      const surface = vec3(world.xz.add(towardCamera.div(horizontal).mul(offset)), WATER_LEVEL).xzy
      const apparent = surface.add(
        surface.sub(cameraPosition).mul(depth.div(1.333).div(cameraHeight)),
      )
      return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(apparent, 1))
    })()
  }

  update(
    _time: number,
    dt: number,
    pointer: WaterPointer | null = null,
    scenePointer: FireflyPointer | null = null,
  ) {
    const step = this.reducedMotion || !Number.isFinite(dt) ? 0 : Math.max(0, Math.min(0.1, dt))
    this.clock += step
    const sampleTime = this.clock
    for (let i = 0; i < this.count; i++) {
      const membership = required(this.membership[i])
      const school = required(this.schools[membership.school])
      const pose = required(this.poses[i])
      const traits = required(this.appearances[i])
      const previousX = pose.x,
        previousZ = pose.z
      sampleSchoolFish(school, membership.member, sampleTime, pose)
      const swimming = required(this.swimming[i])
      const routeX = pose.x,
        routeZ = pose.z
      const routeVx =
        swimming.initialized && step > 0
          ? (routeX - swimming.routeX) / step
          : Math.sin(pose.heading) * 0.4
      const routeVz =
        swimming.initialized && step > 0
          ? (routeZ - swimming.routeZ) / step
          : Math.cos(pose.heading) * 0.4
      const threat = !this.reducedMotion
        ? scenePointer
          ? sampleFishPointer(
              { x: previousX, y: pose.y, z: previousZ },
              scenePointer,
              this.pointerTarget,
            )
          : pointer
        : null
      let awayX = 0,
        awayZ = 0,
        alarm = 0
      if (threat && swimming.initialized) {
        const dx = previousX - threat.x,
          dz = previousZ - threat.z
        const distance = Math.hypot(dx, dz)
        const proximity = Math.max(0, 1 - distance / 2)
        alarm = proximity * proximity * (threat.strength ?? 1)
        // A centered pointer still has an escape bearing, chosen per fish.
        const bearing =
          distance > 0.05
            ? Math.atan2(dx, dz)
            : swimming.heading + (Math.sin(traits.phase) >= 0 ? 0.9 : -0.9)
        awayX = Math.sin(bearing)
        awayZ = Math.cos(bearing)
      }
      swimming.alert +=
        (alarm - swimming.alert) * (1 - Math.exp(-step * (alarm > swimming.alert ? 5 : 1.2)))
      if (!swimming.initialized) {
        swimming.heading = pose.heading
        swimming.initialized = true
      } else if (step > 0) {
        // Steer actual forward velocity, not an offset added to the whole fish.
        // Route attraction reforms the shoal after the brief escape acceleration.
        const vx = routeVx + (routeX - previousX) * 2.2 + awayX * swimming.alert * 1.3
        const vz = routeVz + (routeZ - previousZ) * 2.2 + awayZ * swimming.alert * 1.3
        const desired = Math.atan2(vx, vz)
        const turn = Math.atan2(
          Math.sin(desired - swimming.heading),
          Math.cos(desired - swimming.heading),
        )
        const response = 1 - Math.exp(-step * (4 + swimming.alert * 2))
        const angularLimit = step * (2.5 + swimming.alert)
        swimming.heading += Math.max(-angularLimit, Math.min(angularLimit, turn * response))
        swimming.turn += (Math.max(-1, Math.min(1, turn * 2)) - swimming.turn) * response
        // Turn first; accelerating sideways would recreate the original sliding.
        const alignment = 0.25 + 0.75 * Math.max(0, Math.cos(turn))
        const speed = Math.min(1.8, Math.hypot(vx, vz)) * alignment
        swimming.speed += Math.max(-step * 1.8, Math.min(step * 1.4, speed - swimming.speed))
        const x = previousX + Math.sin(swimming.heading) * swimming.speed * step
        const z = previousZ + Math.cos(swimming.heading) * swimming.speed * step
        // Check the whole turning silhouette before accepting the forward step.
        let safe = true
        for (const dx of [-0.7, 0, 0.7])
          for (const dz of [-0.7, 0, 0.7]) {
            const cell = lakeIndex(this.bed, x + dx, z + dz)
            if (
              cell < 0 ||
              !this.bed.water[cell] ||
              required(this.bed.depth[cell]) < MIN_DEPTH ||
              required(this.bed.obstacle[cell]) >= WATER_LEVEL - 0.65
            )
              safe = false
          }
        pose.x = safe ? x : previousX
        pose.z = safe ? z : previousZ
      } else {
        pose.x = previousX
        pose.z = previousZ
      }
      swimming.routeX = routeX
      swimming.routeZ = routeZ
      const visibility = this.reducedMotion
        ? Number(membership.school === 0)
        : schoolVisibility(school, sampleTime)
      pose.y = swimmingHeight(this.bed, pose.x, pose.z, sampleTime, traits.phase, visibility)
      const propulsion = 0.75 + 0.25 * Math.sin(sampleTime * 1.1 + traits.phase)
      const effort = Math.min(1.25, 0.8 + swimming.speed * 0.35 + swimming.alert * 0.3) * propulsion
      swimming.phase +=
        step * (5.5 + Math.min(1, swimming.speed) * 3.0) * traits.rate * (0.75 + propulsion * 0.25)
      pose.heading = swimming.heading
      this.transform.position.set(pose.x, pose.y, pose.z)
      this.transform.rotation.set(0, pose.heading, -swimming.turn * 0.1)
      this.transform.scale.set(
        (this.mobile ? 0.34 : 0.32) * traits.scale,
        0.34 * traits.scale,
        0.7 * traits.scale,
      )
      this.transform.updateMatrix()
      const mesh = required(this.meshes[i % 3])
      const instance = Math.floor(i / 3)
      mesh.setMatrixAt(instance, this.transform.matrix)
      const animation = mesh.geometry.getAttribute('aFishPhase')
      animation.setX(instance, swimming.phase)
      const motion = mesh.geometry.getAttribute('aFishMotion')
      motion.setXYZ(instance, effort, swimming.turn, (this.mobile ? 0.34 : 0.32) / 0.7)
      // Each shoal approaches, cruises and dives away on its own cadence.
      const alpha = mesh.geometry.getAttribute('aFishVisibility')
      alpha.setX(instance, visibility)
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.geometry.getAttribute('aFishPhase').needsUpdate = true
      mesh.geometry.getAttribute('aFishMotion').needsUpdate = true
      mesh.geometry.getAttribute('aFishVisibility').needsUpdate = true
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    for (const mesh of this.meshes) mesh.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    this.material.dispose()
  }
}

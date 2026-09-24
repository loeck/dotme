import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  InstancedBufferAttribute,
  DoubleSide,
  MeshStandardMaterial,
  Object3D,
} from 'three'
import type { BufferGeometry, Scene } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { sampleFishPointer } from './fish-pointer'
import type { FishPointerTarget } from './fish-pointer'
import { createFishSchools, sampleSchoolFish } from './fish-school'
import type { FishSchool } from './fish-school'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { FireflyPointer } from './lake-fireflies'
import { sampleWaterOptics } from './water-optics'
import { WIND_FIELD_GLSL } from './water-surface'
import { createWindUniforms, updateWindUniforms } from './wind'
import type { WindState } from './wind'

export const FISH_LAYER = 3

type WaterPointer = Readonly<{ x: number; z: number; strength?: number }>
type FishHabitat = Readonly<{ x: number; z: number }>
type FishPose = { x: number; y: number; z: number; heading: number }
export type FishSpecies = 'carp' | 'roach' | 'perch'
export type FishAppearance = Readonly<{
  species: FishSpecies
  scale: number
  rate: number
  phase: number
  tone: number
}>

const HABITAT_RADIUS = 1.35
const BODY_MARGIN = 0.8
const MIN_DEPTH = 1.65

/** Match the captured bed's cell-centered relief without snapping between cells. */
function bedDepth(bed: LakeBed, x: number, z: number) {
  const n = bed.resolution
  const gridX = ((x - LAKE_BOUNDS.minX) * n) / LAKE_BOUNDS.size - 0.5
  const gridZ = ((z - LAKE_BOUNDS.minZ) * n) / LAKE_BOUNDS.size - 0.5
  const column = Math.max(0, Math.min(n - 2, Math.floor(gridX)))
  const row = Math.max(0, Math.min(n - 2, Math.floor(gridZ)))
  const u = Math.max(0, Math.min(1, gridX - column))
  const v = Math.max(0, Math.min(1, gridZ - row))
  const i = row * n + column
  const near = bed.depth[i]! * (1 - u) + bed.depth[i + 1]! * u
  const far = bed.depth[i + n]! * (1 - u) + bed.depth[i + n + 1]! * u
  return near * (1 - v) + far * v
}

function swimmingHeight(bed: LakeBed, x: number, z: number, time: number, phase: number) {
  let depth = Infinity
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      depth = Math.min(depth, bedDepth(bed, x + dx * BODY_MARGIN, z + dz * BODY_MARGIN))
  // Follow the highest relief under the entire silhouette, including turns.
  // Retain belly/fin clearance when a deeper shoal crosses sloping relief.
  const cruiseDepth = 1.37 + 0.44 * (0.5 + 0.5 * Math.sin(phase))
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
      if (!bed.water[i] || bed.depth[i]! < MIN_DEPTH || bed.obstacle[i]! >= WATER_LEVEL - 0.65)
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
      if (i < 0 || bed.depth[i]! < MIN_DEPTH || bed.depth[i]! > 3.8) continue
      const centerX = LAKE_BOUNDS.minX + ((i % bed.resolution) + 0.5) * cell
      const centerZ = LAKE_BOUNDS.minZ + (Math.floor(i / bed.resolution) + 0.5) * cell
      const forward = 16 - centerZ
      const extent = Math.abs(centerX) + HABITAT_RADIUS + BODY_MARGIN
      // FOV 54°, 390/844 portrait and 16/9 desktop, with room for parallax.
      if (extent > forward * (mobile ? 0.21 : 0.7)) continue
      if ((2.3 + bed.depth[i]! + 0.2) / forward > 0.33) continue
      if (!safeHabitat(bed, centerX, centerZ)) continue
      candidates.push({
        x: centerX,
        z: centerZ,
        foreground: centerZ > -8 && extent < forward * (mobile ? 0.21 : 0.55),
        score:
          Math.abs(bed.depth[i]! - 2.6) * 0.65 +
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

const SPECIES: readonly FishSpecies[] = ['carp', 'roach', 'perch']

/** Small stepped volumes stay legible at lake scale, with dark flanks and a
 * subdued upper face. No anatomy texture or bright golden body to smear. */
function createFishGeometry(species: FishSpecies) {
  const parts: BufferGeometry[] = []
  const width = species === 'roach' ? 0.52 : species === 'perch' ? 0.62 : 0.7
  const block = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    length: number,
    eye = false,
  ) => {
    const geometry = new BoxGeometry(w, h, length).toNonIndexed()
    geometry.deleteAttribute('uv')
    geometry.translate(x, y, z)
    const positions = geometry.getAttribute('position')
    const normals = geometry.getAttribute('normal')
    const colors = new Float32Array(positions.count * 3)
    const bend = new Float32Array(positions.count)
    const color = new Color()
    for (let i = 0; i < positions.count; i++) {
      color.set(eye ? 0x111e24 : normals.getY(i) > 0.5 ? 0x6d898d : 0x344d58)
      colors.set([color.r, color.g, color.b], i * 3)
      bend[i] = Math.max(0, Math.min(1, (0.12 - positions.getZ(i)) / 0.85)) ** 2
    }
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    geometry.setAttribute('aFishTail', new Float32BufferAttribute(bend, 1))
    parts.push(geometry)
  }
  block(0, 0, 0.02, width, 0.62, 0.54)
  block(0, 0.01, 0.35, width * 0.72, 0.43, 0.18)
  block(0, 0, -0.34, width * 0.48, 0.32, 0.2)
  block(0, 0, -0.48, width * 0.2, 0.2, 0.12)
  block(0, 0.22, -0.62, 0.12, 0.35, 0.24)
  block(0, -0.22, -0.62, 0.12, 0.35, 0.24)
  block(0, 0.39, -0.02, 0.09, 0.22, 0.22)
  for (const sign of [-1, 1]) {
    block(sign * width * 0.6, -0.12, 0.01, width * 0.36, 0.08, 0.19)
    block(sign * width * 0.37, 0.08, 0.35, 0.025, 0.045, 0.045, true)
  }
  const geometry = mergeGeometries(parts)!
  for (const part of parts) part.dispose()
  geometry.name = `Voxel ${species} shoal`
  return geometry
}

/** Small voxel shoals in three instanced body-width variants. */
export class LakeFish {
  readonly habitats: readonly FishHabitat[]
  readonly count: number
  /** The other two batches are children, preserving the single visibility switch. */
  readonly mesh: InstancedMesh
  readonly meshes: readonly InstancedMesh[]
  readonly appearances: readonly FishAppearance[]
  private readonly geometries = SPECIES.map(createFishGeometry)
  private readonly material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.07,
    envMapIntensity: 0.85,
    vertexColors: true,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
  })
  private readonly optics = {
    uTime: { value: 0 },
    uFishClarity: { value: 1 },
    ...createWindUniforms(),
  }
  private readonly transform = new Object3D()
  private readonly poses: FishPose[] = []
  readonly schools: readonly FishSchool[]
  readonly schoolSizes: readonly number[]
  private readonly membership: readonly { school: number; member: number }[]
  private clock = 0
  private readonly avoidance: Array<{ x: number; z: number }>
  private readonly pointerTarget: FishPointerTarget = { x: 0, z: 0, strength: 0 }

  constructor(
    scene: Scene,
    private readonly bed: LakeBed,
    seed: number,
    private readonly mobile: boolean,
    private readonly reducedMotion = false,
  ) {
    this.habitats = createFishHabitats(bed, seed, 16, mobile)
    this.schools = createFishSchools(bed, this.habitats, seed, mobile ? 2 : 3)
    const sizes = mobile ? [6, 4] : [8, 4, 6]
    this.schoolSizes = this.schools.map((_, i) => sizes[(i + (seed >>> 0)) % sizes.length]!)
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
      const species = SPECIES[i % 3]!
      const schoolScale = [1, 0.82, 0.92][this.membership[i]!.school]!
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
        const traits = this.appearances[instance * 3 + speciesIndex]!
        mesh.setColorAt(instance, new Color().setScalar(traits.tone))
      }
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
    this.mesh = this.meshes[0]!
    this.mesh.add(this.meshes[1]!, this.meshes[2]!)
    for (let i = 0; i < this.count; i++) this.poses.push({ x: 0, y: 0, z: 0, heading: 0 })
    this.avoidance = this.poses.map(() => ({ x: 0, z: 0 }))
    this.attachMotionShader()
    this.update(0, 0)
    for (const mesh of this.meshes) {
      // A shoal travels well beyond its initial foreground footprint.
      mesh.frustumCulled = false
    }
    scene.add(this.mesh)
  }

  private attachMotionShader() {
    const previous = this.material.onBeforeCompile
    const cacheKey = this.material.customProgramCacheKey()
    this.material.onBeforeCompile = (shader, renderer) => {
      previous.call(this.material, shader, renderer)
      Object.assign(shader.uniforms, this.optics)
      shader.vertexShader = `attribute float aFishTail;
attribute float aFishPhase;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // WebGL Aquarium's rearward-growing traveling wave, with individual
        // propulsion phases and low-amplitude glides rather than synchronized tails.
        float amplitude = 0.05475;
        float phase = aFishPhase - position.z * 4.0;
        transformed.x += aFishTail * sin(phase) * amplitude;`,
      )
      // Refract each actual vertex analytically at the interface. Small fish
      // must not be reconstructed from the coarse bed capture's depth steps:
      // that splits their bodies into magnified patches. Only their surface
      // depth is lifted over the water for normal bank occlusion; depth writes
      // stay disabled so they cannot disturb the lake's fog or lens passes.
      shader.vertexShader = `${WIND_FIELD_GLSL}
attribute float aFishVisibility;
varying float vFishTransmission;
varying float vFishDepth;
uniform float uFishClarity;
${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `
vec4 fishWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
float fishDepth = max(0.0, ${WATER_LEVEL} - fishWorld.y);
vec2 towardCamera = cameraPosition.xz - fishWorld.xz;
float horizontal = max(0.001, length(towardCamera));
float cameraHeight = max(0.001, cameraPosition.y - ${WATER_LEVEL});
float offset = 0.0;
for (int i = 0; i < 3; i++) {
  float distance = max(0.0, horizontal - offset);
  float sine = distance / sqrt(distance * distance + cameraHeight * cameraHeight) / 1.333;
  offset = fishDepth * sine / sqrt(1.0 - sine * sine);
}
vec2 surfaceXZ = fishWorld.xz + towardCamera / horizontal * offset;
// Keep a whole fish coherent as a wave passes, rather than bending each tiny
// vertex with independent high-frequency normals.
vec4 center = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
vec4 surfaceField = windField(surfaceXZ, 0.08);
float wave = windField(center.xz, 0.08).x;
vec4 mvPosition = viewMatrix * vec4(surfaceXZ.x, ${WATER_LEVEL} + wave + 0.035, surfaceXZ.y, 1.0);
gl_Position = projectionMatrix * mvPosition;
vec3 surfaceNormal = normalize(vec3(-surfaceField.y, 1.0, -surfaceField.z));
vec3 surfaceView = normalize(cameraPosition - vec3(surfaceXZ.x, ${WATER_LEVEL} + wave, surfaceXZ.y));
float cosine = clamp(dot(surfaceNormal, surfaceView), 0.0, 1.0);
float fresnel = 0.02 + 0.98 * pow(1.0 - cosine, 5.0);
vFishDepth = fishDepth;
// The reflected surface stays visible over the silhouette, especially at
// grazing angles. Absorption removes contrast as a fish swims deeper.
vFishTransmission = aFishVisibility * exp(-fishDepth * mix(1.0, 0.24, uFishClarity))
  * mix(0.2, 0.95, uFishClarity) * (1.0 - fresnel * 0.45);
`,
      )
      shader.fragmentShader =
        `varying float vFishTransmission;\nvarying float vFishDepth;\n${shader.fragmentShader}`.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= exp(-vec3(0.2, 0.09, 0.04) * vFishDepth);
diffuseColor.a *= vFishTransmission;`,
        )
    }
    this.material.customProgramCacheKey = () => `${cacheKey}:refracted-shoals-v2`
    this.material.needsUpdate = true
  }

  update(
    time: number,
    dt: number,
    pointer: WaterPointer | null = null,
    scenePointer: FireflyPointer | null = null,
    wind?: WindState,
    rainIntensity = 0,
  ) {
    const step = this.reducedMotion || !Number.isFinite(dt) ? 0 : Math.max(0, Math.min(0.1, dt))
    this.clock += step
    const sampleTime = this.clock
    this.optics.uTime.value = this.reducedMotion ? 0 : time
    this.optics.uFishClarity.value = sampleWaterOptics(rainIntensity, 0).clarity
    if (wind) updateWindUniforms(this.optics, wind)
    for (let i = 0; i < this.count; i++) {
      const membership = this.membership[i]!
      const school = this.schools[membership.school]!
      const pose = this.poses[i]!
      const traits = this.appearances[i]!
      sampleSchoolFish(school, membership.member, sampleTime, pose)
      const avoidance = this.avoidance[i]!
      const threat = !this.reducedMotion
        ? scenePointer
          ? sampleFishPointer(pose, scenePointer, this.pointerTarget)
          : pointer
        : null
      let awayX = 0,
        awayZ = 0
      if (threat) {
        const dx = pose.x - threat.x,
          dz = pose.z - threat.z
        const distance = Math.hypot(dx, dz)
        const strength = Math.max(0, 1 - distance / 2) * 0.2 * (threat.strength ?? 1)
        awayX = (dx / Math.max(0.1, distance)) * strength
        awayZ = (dz / Math.max(0.1, distance)) * strength
      }
      const follow = 1 - Math.exp(-step * 4)
      avoidance.x += (awayX - avoidance.x) * follow
      avoidance.z += (awayZ - avoidance.z) * follow
      pose.x += avoidance.x
      pose.z += avoidance.z
      pose.y = swimmingHeight(this.bed, pose.x, pose.z, sampleTime, traits.phase)
      this.transform.position.set(pose.x, pose.y, pose.z)
      this.transform.rotation.set(0, pose.heading, Math.sin(sampleTime * 1.2 + traits.phase) * 0.07)
      this.transform.scale.set(
        (this.mobile ? 0.24 : 0.2) * traits.scale,
        0.3 * traits.scale,
        0.55 * traits.scale,
      )
      this.transform.updateMatrix()
      const mesh = this.meshes[i % 3]!
      const instance = Math.floor(i / 3)
      mesh.setMatrixAt(instance, this.transform.matrix)
      const animation = mesh.geometry.getAttribute('aFishPhase') as InstancedBufferAttribute
      animation.setX(instance, traits.phase + sampleTime * 7 * traits.rate)
      // A quiet interval between passages; the shoal dissolves into the depths
      // as it recedes. All members share the same passage window.
      const approach =
        0.5 + 0.5 * Math.cos((sampleTime / school.period) * Math.PI * 2 + school.phase)
      const visibility = Math.max(0, Math.min(1, (approach - 0.78) / 0.18))
      const alpha = mesh.geometry.getAttribute('aFishVisibility') as InstancedBufferAttribute
      alpha.setX(instance, visibility * visibility * (3 - 2 * visibility))
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.geometry.getAttribute('aFishPhase').needsUpdate = true
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

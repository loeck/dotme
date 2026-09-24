import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  InstancedBufferAttribute,
  DoubleSide,
  Shape,
  ShapeGeometry,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three'
import type { Scene } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { advanceFishMotion, createFishMotion } from './fish-motion'
import type { FishMotionState } from './fish-motion'
import { sampleFishPointer } from './fish-pointer'
import type { FishPointerTarget } from './fish-pointer'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { FireflyPointer } from './lake-fireflies'

type WaterPointer = Readonly<{ x: number; z: number }>
export type FishHabitat = Readonly<{ x: number; z: number; radius: number; phase: number }>
export type FishPose = { x: number; y: number; z: number; heading: number }
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
const MIN_DEPTH = 0.75

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
  // Keeping fish close to the bed avoids the refraction pass's 2m rejection.
  return WATER_LEVEL - depth + 0.3 + Math.sin(time * 0.4 + phase) * 0.015
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
  // Reserve each camera's central foreground for the first pair.
  for (let z = -34; z <= 5; z += cell * 2) {
    for (let x = -22; x <= 22; x += cell * 2) {
      const i = lakeIndex(bed, x, z)
      if (i < 0 || bed.depth[i]! < 1.2 || bed.depth[i]! > 3.8) continue
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
        radius: HABITAT_RADIUS,
        phase: random() * Math.PI * 2,
        foreground: centerZ > -8 && extent < forward * (mobile ? 0.21 : 0.55),
        score:
          bed.depth[i]! * 0.65 +
          Math.abs(centerZ - 2) * 0.12 +
          Math.abs(centerX) * 0.06 +
          random() * 0.12,
      })
    }
  }
  candidates.sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.score - b.score)
  for (const candidate of candidates) {
    if (habitats.length >= count) break
    if (habitats.some((area) => Math.hypot(area.x - candidate.x, area.z - candidate.z) < 4.7))
      continue
    habitats.push({
      x: candidate.x,
      z: candidate.z,
      radius: candidate.radius,
      // A lateral first pass reads as a fish from the grazing landscape camera.
      // Preserve seeded variation without starting a shoal nose-on to the viewer.
      phase:
        Math.PI * (candidate.phase > Math.PI ? 1.5 : 0.5) +
        ((candidate.phase % Math.PI) - Math.PI / 2) * 0.12,
    })
  }
  return habitats
}

/** Writes an orbit/escape target inside a prevalidated habitat without allocating. */
export function sampleFishPose(
  bed: LakeBed,
  habitat: FishHabitat,
  fishIndex: number,
  time: number,
  pointer: WaterPointer | null,
  target: FishPose,
  appearance?: FishAppearance,
) {
  const phase = habitat.phase + fishIndex * Math.PI
  // An analytic speed modulation keeps propulsion/gliding independent of frame rate.
  const swimTime = appearance
    ? time * appearance.rate +
      0.32 * (Math.sin(time * 0.65 + appearance.phase) - Math.sin(appearance.phase))
    : time
  const angle = swimTime * (0.14 + fishIndex * 0.015) + phase
  let dx = Math.cos(angle) * habitat.radius * 0.6
  let dz = Math.sin(angle) * habitat.radius * 0.26
  if (pointer) {
    const awayX = habitat.x + dx - pointer.x
    const awayZ = habitat.z + dz - pointer.z
    const distance = Math.hypot(awayX, awayZ)
    const escape = Math.max(0, 1 - distance / 3) * 0.7
    dx += (distance > 0.001 ? awayX / distance : Math.cos(phase)) * escape
    dz += (distance > 0.001 ? awayZ / distance : Math.sin(phase)) * escape
  }
  // Keep the full reaction path in the same convex, checked patch of water.
  const distance = Math.hypot(dx, dz)
  const scale = distance > habitat.radius ? habitat.radius / distance : 1
  target.x = habitat.x + dx * scale
  target.z = habitat.z + dz * scale
  target.y = swimmingHeight(bed, target.x, target.z, time, phase)
  target.heading = Math.atan2(-Math.sin(angle), Math.cos(angle) * (0.26 / 0.6))
  return target
}

const SPECIES: readonly FishSpecies[] = ['carp', 'roach', 'perch']

/** Anatomy/color references: FAO common-carp factsheet and the Wildlife Trusts'
 * real underwater carp (John Bridges), roach and perch photographs (Jack Perks).
 * These are three sculpted profiles, not differently tinted copies. */
const MORPHS = {
  carp: {
    widths: [0.1, 0.3, 0.44, 0.5, 0.46, 0.33, 0.19, 0.1, 0.07],
    heights: [0.16, 0.36, 0.52, 0.65, 0.61, 0.46, 0.27, 0.14, 0.09],
    flank: 0xb9a06b,
    back: 0x4d5840,
    belly: 0xe0cb97,
    fin: 0x967957,
    tail: 1.05,
    notch: -0.56,
    pectoral: 0.62,
  },
  roach: {
    widths: [0.025, 0.17, 0.29, 0.34, 0.3, 0.22, 0.12, 0.065, 0.05],
    heights: [0.07, 0.28, 0.49, 0.62, 0.6, 0.42, 0.23, 0.11, 0.07],
    flank: 0xd0d6c8,
    back: 0x4d6862,
    belly: 0xecebd9,
    fin: 0xa26e51,
    tail: 0.9,
    notch: -0.5,
    pectoral: 0.49,
  },
  perch: {
    widths: [0.06, 0.24, 0.37, 0.41, 0.35, 0.26, 0.14, 0.08, 0.055],
    heights: [0.14, 0.35, 0.65, 0.76, 0.64, 0.44, 0.25, 0.13, 0.08],
    flank: 0xaca864,
    back: 0x415640,
    belly: 0xd8cb96,
    fin: 0xaa6543,
    tail: 0.96,
    notch: -0.59,
    pectoral: 0.54,
  },
} as const
const PROFILE_Z = [0.4, 0.35, 0.27, 0.12, -0.05, -0.2, -0.31, -0.4, -0.43] as const

function profileAt(values: readonly number[], section: number, t: number) {
  const previous = Math.max(0, section - 1)
  const next = Math.min(PROFILE_Z.length - 1, section + 2)
  const step = PROFILE_Z[section + 1]! - PROFILE_Z[section]!
  const startSlope =
    (values[section + 1]! - values[previous]!) / (PROFILE_Z[section + 1]! - PROFILE_Z[previous]!)
  const endSlope = (values[next]! - values[section]!) / (PROFILE_Z[next]! - PROFILE_Z[section]!)
  const t2 = t * t
  const t3 = t2 * t
  return Math.max(
    0.01,
    (2 * t3 - 3 * t2 + 1) * values[section]! +
      (t3 - 2 * t2 + t) * startSlope * step +
      (-2 * t3 + 3 * t2) * values[section + 1]! +
      (t3 - t2) * endSlope * step,
  )
}

/** A curved, two-sided membrane, with separate local plane for upright fins. */
function finGeometry(shape: Shape, vertical: boolean, color: Color, y = 0.025) {
  const indexed = new ShapeGeometry(shape, 12)
  const geometry = indexed.toNonIndexed()
  indexed.dispose()
  geometry.deleteAttribute('uv')
  const positions = geometry.getAttribute('position')
  const colors = new Float32Array(positions.count * 3)
  for (let i = 0; i < positions.count; i++) {
    const across = positions.getX(i)
    const z = positions.getY(i)
    positions.setXYZ(i, vertical ? 0.008 * Math.sin(across * 3) : across, vertical ? across : y, z)
    // Gentle ray variation breaks up a flat solid-color paddle without textures.
    const ray = 0.87 + 0.13 * Math.cos(Math.atan2(across, z + 0.4) * 17) ** 2
    colors.set([color.r * ray, color.g * ray, color.b * ray], i * 3)
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  return geometry
}

function createFishGeometry(species: FishSpecies) {
  const morph = MORPHS[species]
  const radial = 20
  const ringCount = 49
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const flank = new Color(morph.flank)
  const back = new Color(morph.back)
  const belly = new Color(morph.belly)
  const pigment = new Color()
  for (let ring = 0; ring < ringCount; ring++) {
    const z = 0.4 - (ring / (ringCount - 1)) * 0.83
    let section = 0
    while (section < PROFILE_Z.length - 2 && z < PROFILE_Z[section + 1]!) section++
    const t = Math.max(
      0,
      Math.min(1, (PROFILE_Z[section]! - z) / (PROFILE_Z[section]! - PROFILE_Z[section + 1]!)),
    )
    const width = profileAt(morph.widths, section, t)
    const height = profileAt(morph.heights, section, t)
    for (let side = 0; side < radial; side++) {
      const angle = (side / radial) * Math.PI * 2
      const up = Math.sin(angle)
      positions.push(Math.cos(angle) * width, up * height, z)
      pigment.copy(flank).lerp(up > 0 ? back : belly, Math.abs(up) ** 3 * 0.5)
      // Perch's low-frequency bars remain visible through the water filtering.
      if (species === 'perch') {
        const bar = Math.max(0, Math.cos((z + 0.05) * 48 + Math.abs(up) * 0.7)) ** 4
        pigment.multiplyScalar(1 - bar * 0.56)
      } else {
        // Subtle scale-row sheen, subordinate to the silhouette and dorsal gradient.
        const scale = 0.96 + 0.04 * Math.cos(z * 100 + Math.floor(side / 2) * Math.PI) ** 2
        pigment.multiplyScalar(scale)
      }
      colors.push(pigment.r, pigment.g, pigment.b)
    }
  }
  for (let ring = 0; ring < ringCount - 1; ring++)
    for (let side = 0; side < radial; side++) {
      const a = ring * radial + side
      const b = ring * radial + ((side + 1) % radial)
      indices.push(a, a + radial, b, b, a + radial, b + radial)
    }
  // Close the snout and peduncle, keeping these genuine lit volumes from every angle.
  const nose = positions.length / 3
  positions.push(0, 0, 0.415, 0, 0, -0.437)
  colors.push(flank.r, flank.g, flank.b, flank.r, flank.g, flank.b)
  for (let side = 0; side < radial; side++) {
    const next = (side + 1) % radial
    indices.push(
      nose,
      side,
      next,
      nose + 1,
      (ringCount - 1) * radial + next,
      (ringCount - 1) * radial + side,
    )
  }
  const shell = new BufferGeometry()
  shell.setAttribute('position', new Float32BufferAttribute(positions, 3))
  shell.setAttribute('color', new Float32BufferAttribute(colors, 3))
  shell.setIndex(indices)
  shell.computeVertexNormals()
  const body = shell.toNonIndexed()
  shell.dispose()
  const finColor = new Color(morph.fin)
  const tail = new Shape()
  const span = morph.tail
  // True caudal anatomy: the fork is vertical (YZ), never a horizontal arrow.
  tail.moveTo(-0.07, -0.4)
  tail.quadraticCurveTo(-span * 0.48, -0.47, -span, -0.68)
  tail.quadraticCurveTo(-span * 0.96, -0.715, -span * 0.72, -0.675)
  tail.quadraticCurveTo(-span * 0.3, morph.notch - 0.02, 0, morph.notch)
  tail.quadraticCurveTo(span * 0.3, morph.notch - 0.02, span * 0.72, -0.675)
  tail.quadraticCurveTo(span * 0.96, -0.715, span, -0.68)
  tail.quadraticCurveTo(span * 0.48, -0.47, 0.07, -0.4)
  tail.closePath()
  const parts = [body, finGeometry(tail, true, finColor)]
  for (const sign of [-1, 1]) {
    const pectoral = new Shape()
    const shoulder = morph.widths[3] * 0.78
    pectoral.moveTo(sign * shoulder, 0.15)
    pectoral.quadraticCurveTo(sign * morph.pectoral, 0.08, sign * morph.pectoral, -0.065)
    pectoral.quadraticCurveTo(sign * morph.pectoral * 0.9, -0.155, sign * shoulder * 0.75, -0.11)
    pectoral.quadraticCurveTo(sign * shoulder * 0.9, 0.035, sign * shoulder, 0.15)
    parts.push(finGeometry(pectoral, false, finColor, -0.07))
    const pelvic = new Shape()
    pelvic.moveTo(sign * 0.15, -0.18)
    pelvic.quadraticCurveTo(sign * 0.34, -0.21, sign * 0.31, -0.34)
    pelvic.quadraticCurveTo(sign * 0.19, -0.36, sign * 0.12, -0.26)
    pelvic.closePath()
    parts.push(finGeometry(pelvic, false, finColor, -0.2))
  }
  const dorsal = new Shape()
  dorsal.moveTo(0.48, species === 'carp' ? 0.21 : 0.15)
  if (species === 'perch') {
    // Two separate dorsals: a high spiny front fin and smaller soft rear fin.
    dorsal.quadraticCurveTo(1.03, 0.19, 1.12, 0.055)
    for (let i = 0; i < 6; i++)
      dorsal.lineTo(1.07 - i * 0.075 + (i % 2 ? -0.09 : 0), 0.055 - i * 0.034)
    dorsal.lineTo(0.48, -0.17)
    const rear = new Shape()
    rear.moveTo(0.38, -0.2)
    rear.quadraticCurveTo(0.78, -0.23, 0.65, -0.3)
    rear.quadraticCurveTo(0.42, -0.36, 0.22, -0.37)
    rear.closePath()
    parts.push(finGeometry(rear, true, finColor))
  } else if (species === 'carp') {
    dorsal.quadraticCurveTo(1.05, 0.12, 0.87, -0.06)
    dorsal.quadraticCurveTo(0.69, -0.23, 0.26, -0.36)
  } else {
    dorsal.quadraticCurveTo(1.0, 0.13, 1.02, 0.025)
    dorsal.quadraticCurveTo(0.83, -0.12, 0.38, -0.19)
  }
  dorsal.closePath()
  parts.push(finGeometry(dorsal, true, finColor))
  for (const sign of [-1, 1]) {
    const source = new SphereGeometry(0.047, 8, 6)
    source.scale(1, 1, 0.6)
    source.translate(sign * morph.widths[2] * 0.85, morph.heights[2] * 0.48, 0.285)
    source.deleteAttribute('uv')
    const eye = source.toNonIndexed()
    source.dispose()
    eye.setAttribute(
      'color',
      new Float32BufferAttribute(
        new Float32Array(eye.getAttribute('position').count * 3).fill(0.018),
        3,
      ),
    )
    parts.push(eye)
  }
  for (const part of parts) {
    const vertices = part.getAttribute('position')
    const bend = new Float32Array(vertices.count)
    for (let i = 0; i < vertices.count; i++)
      bend[i] = Math.max(0, Math.min(1, (0.3 - vertices.getZ(i)) / 1.02)) ** 2
    part.setAttribute('aFishTail', new Float32BufferAttribute(bend, 1))
  }
  const geometry = mergeGeometries(parts)!
  for (const part of parts) part.dispose()
  geometry.name = `Freshwater ${species}`
  return geometry
}

/** Three genuine anatomical variants; at most three submerged-only draws. */
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
    roughness: 0.34,
    metalness: 0.07,
    envMapIntensity: 1.2,
    vertexColors: true,
    side: DoubleSide,
  })
  private readonly transform = new Object3D()
  private readonly poses: FishPose[] = []
  private readonly motions: FishMotionState[]
  private readonly previousPositions: Array<{ x: number; z: number }>
  private readonly pointerTarget: FishPointerTarget = { x: 0, z: 0, strength: 0 }

  constructor(
    scene: Scene,
    private readonly bed: LakeBed,
    seed: number,
    private readonly mobile: boolean,
    private readonly reducedMotion = false,
  ) {
    this.habitats = createFishHabitats(bed, seed, mobile ? 3 : 6, mobile)
    this.count = this.habitats.length * 2
    const random = randomGenerator(seed ^ 0x82ae)
    this.appearances = Array.from({ length: this.count }, (_, i) => {
      const species = SPECIES[i % 3]!
      const scale =
        (species === 'carp' ? 0.9 : species === 'roach' ? 0.65 : 0.76) +
        random() * (species === 'carp' ? 0.1 : 0.13)
      const rate =
        (species === 'carp' ? 0.76 : species === 'roach' ? 1.12 : 0.92) * (0.92 + random() * 0.16)
      return { species, scale, rate, phase: random() * Math.PI * 2, tone: 0.93 + random() * 0.07 }
    })
    this.meshes = this.geometries.map((geometry, speciesIndex) => {
      const count = Math.floor((this.count + 2 - speciesIndex) / 3)
      const mesh = new InstancedMesh(geometry, this.material, count)
      mesh.name = `Submerged ${SPECIES[speciesIndex]}`
      mesh.layers.set(1)
      mesh.receiveShadow = true
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      const motion = new Float32Array(count * 3)
      for (let instance = 0; instance < count; instance++) {
        const traits = this.appearances[instance * 3 + speciesIndex]!
        motion.set([traits.rate, traits.phase, traits.scale], instance * 3)
        mesh.setColorAt(instance, new Color().setScalar(traits.tone))
      }
      geometry.setAttribute('aFishMotion', new InstancedBufferAttribute(motion, 3))
      return mesh
    })
    this.mesh = this.meshes[0]!
    this.mesh.add(this.meshes[1]!, this.meshes[2]!)
    for (let i = 0; i < this.count; i++)
      this.poses.push(
        sampleFishPose(
          bed,
          this.habitats[Math.floor(i / 2)]!,
          i % 2,
          0,
          null,
          { x: 0, y: 0, z: 0, heading: 0 },
          this.appearances[i],
        ),
      )
    this.motions = this.poses.map((pose, i) => {
      const traits = this.appearances[i]!
      const carp = traits.species === 'carp'
      const roach = traits.species === 'roach'
      return createFishMotion(pose.x, pose.z, pose.heading, seed ^ Math.imul(i + 1, 0x85ebca6b), {
        cruiseSpeed: (carp ? 0.2 : roach ? 0.22 : 0.21) * traits.rate,
        burstSpeed: carp ? 0.46 : roach ? 0.7 : 0.6,
        agility: carp ? 1.45 : roach ? 2.6 : 2.1,
        acceleration: carp ? 0.42 : roach ? 0.8 : 0.64,
      })
    })
    this.previousPositions = this.poses.map((pose) => ({ x: pose.x, z: pose.z }))
    this.attachMotionShader()
    this.update(0, 0)
    for (const mesh of this.meshes) {
      mesh.computeBoundingSphere()
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 3
    }
    scene.add(this.mesh)
  }

  private attachMotionShader() {
    const previous = this.material.onBeforeCompile
    const cacheKey = this.material.customProgramCacheKey()
    this.material.onBeforeCompile = (shader, renderer) => {
      previous.call(this.material, shader, renderer)
      shader.vertexShader = `attribute float aFishTail;
attribute vec3 aFishMotion;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // WebGL Aquarium's rearward-growing traveling wave, with individual
        // propulsion phases and low-amplitude glides rather than synchronized tails.
        float amplitude = 0.025 + 0.085 * clamp(aFishMotion.y, 0.0, 1.0);
        float phase = aFishMotion.x - position.z * 4.0;
        transformed.x += aFishTail * sin(phase) * amplitude;`,
      )
    }
    this.material.customProgramCacheKey = () => `${cacheKey}:freshwater-morphs-v4`
    this.material.needsUpdate = true
  }

  update(
    time: number,
    dt: number,
    pointer: WaterPointer | null = null,
    scenePointer: FireflyPointer | null = null,
  ) {
    const sampleTime = this.reducedMotion ? 0 : time
    for (let i = 0; i < this.count; i++) {
      this.previousPositions[i]!.x = this.poses[i]!.x
      this.previousPositions[i]!.z = this.poses[i]!.z
    }
    for (let i = 0; i < this.count; i++) {
      const habitat = this.habitats[Math.floor(i / 2)]!
      const pose = this.poses[i]!
      const traits = this.appearances[i]!
      const motion = this.motions[i]!
      if (!this.reducedMotion) {
        const threat = scenePointer
          ? sampleFishPointer(pose, scenePointer, this.pointerTarget)
          : pointer
        advanceFishMotion(motion, habitat, dt, threat, this.previousPositions[i ^ 1])
        pose.x = motion.x
        pose.z = motion.z
        pose.heading = motion.heading
      }
      pose.y = swimmingHeight(
        this.bed,
        pose.x,
        pose.z,
        sampleTime,
        habitat.phase + (i % 2) * Math.PI,
      )
      // Turn banking follows actual effort; a tiny idle roll reveals the flanks.
      const bank = motion.roll + Math.sin(sampleTime * 0.25 + traits.phase) * 0.025
      this.transform.position.set(pose.x, pose.y, pose.z)
      this.transform.rotation.set(0, pose.heading, bank)
      this.transform.scale.set(
        // Preserve a readable body depth in the small refracted mobile image.
        (this.mobile ? 0.58 : 0.48) * traits.scale,
        (this.mobile ? 0.24 : 0.16) * traits.scale,
        (this.mobile ? 0.95 : 0.85) * traits.scale,
      )
      this.transform.updateMatrix()
      const mesh = this.meshes[i % 3]!
      const instance = Math.floor(i / 3)
      mesh.setMatrixAt(instance, this.transform.matrix)
      const animation = mesh.geometry.getAttribute('aFishMotion') as InstancedBufferAttribute
      animation.setXYZ(instance, motion.tailPhase, motion.effort, traits.scale)
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.geometry.getAttribute('aFishMotion').needsUpdate = true
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    for (const mesh of this.meshes) mesh.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    this.material.dispose()
  }
}

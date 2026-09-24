import {
  DynamicDrawUsage,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import type { Scene } from 'three'

import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { SplashImpacts } from './splash-impacts'
import { createSplashProfile } from './splash-profile'
import type { SplashProfile } from './splash-profile'
import { sampleWindField } from './water-surface'
import type { WindState } from './wind'

type Contact = { x: number; z: number; nx: number; nz: number; armed: boolean; next: number }
type Drop = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  born: number
  size: number
  life: number
  lastAge: number
  drag?: number
  windX?: number
  windZ?: number
}

/** Closed-form air drag keeps collision timing independent of the render step. */
function sampleDrop(drop: Drop, age: number, position: Vector3, velocity?: Vector3) {
  const drag = drop.drag ?? 0
  if (drag < 0.0001) {
    position.set(
      drop.x + drop.vx * age,
      drop.y + drop.vy * age - 4.905 * age * age,
      drop.z + drop.vz * age,
    )
    velocity?.set(drop.vx, drop.vy - 9.81 * age, drop.vz)
    return
  }
  const decay = Math.exp(-drag * age),
    travel = -Math.expm1(-drag * age) / drag
  const wx = drop.windX ?? 0,
    wz = drop.windZ ?? 0,
    terminal = 9.81 / drag
  position.set(
    drop.x + wx * age + (drop.vx - wx) * travel,
    drop.y + (drop.vy + terminal) * travel - terminal * age,
    drop.z + wz * age + (drop.vz - wz) * travel,
  )
  velocity?.set(
    wx + (drop.vx - wx) * decay,
    (drop.vy + terminal) * decay - terminal,
    wz + (drop.vz - wz) * decay,
  )
}
type Sheet = {
  x: number
  y: number
  z: number
  heading: number
  born: number
  energy: number
  profile: SplashProfile
}

/** Sparse impact jets tied to the same wind-wave field as the visible surface. */
export class LakeSplashes {
  readonly mesh: InstancedMesh<SphereGeometry, MeshStandardMaterial>
  readonly sheets: InstancedMesh<PlaneGeometry, MeshStandardMaterial>
  readonly impacts: SplashImpacts
  readonly contacts: Contact[] = []
  readonly capacity: number
  private readonly drops: Array<Drop | null>
  private readonly transform = new Object3D()
  private readonly up = new Vector3(0, 1, 0)
  private readonly velocity = new Vector3()
  private readonly dropPosition = new Vector3()
  private readonly sheetsState: Array<Sheet | null> = Array.from({ length: 24 }, () => null)
  private sheetCursor = 0
  onReturn?: (x: number, z: number, radius: number, velocity: number) => void
  private state: number
  private nextCheck = 0
  private cursor = 0
  private readonly shoreResolution: number
  private readonly shoreCell: number
  emitted = 0
  active = 0

  constructor(
    scene: Scene,
    private readonly bed: LakeBed,
    seed: number,
    mobile: boolean,
  ) {
    this.state = (seed ^ 0x591a7e) >>> 0
    this.impacts = new SplashImpacts(scene, mobile)
    this.capacity = mobile ? 144 : 320
    this.drops = Array.from({ length: this.capacity }, () => null)
    this.shoreResolution = Math.sqrt(bed.shore.length)
    this.shoreCell = LAKE_BOUNDS.size / this.shoreResolution
    const candidates: Array<Contact & { order: number }> = []
    const n = this.shoreResolution,
      cell = this.shoreCell
    for (let row = 1; row < n - 1; row += 2)
      for (let col = 1; col < n - 1; col += 2) {
        const index = row * n + col,
          distance = bed.shore[index]!
        if (distance <= 0 || distance > cell * 1.7) continue
        const x = LAKE_BOUNDS.minX + (col + 0.5) * cell
        const z = LAKE_BOUNDS.minZ + (row + 0.5) * cell
        if (Math.abs(x) > (mobile ? 25 : 55) || z < -80 || z > 12) continue
        let nx = bed.shore[index + 1]! - bed.shore[index - 1]!
        let nz = bed.shore[index + n]! - bed.shore[index - n]!
        const length = Math.hypot(nx, nz)
        if (length < 0.0001) continue
        nx /= length
        nz /= length
        candidates.push({
          x: x - nx * distance + nx * 0.04,
          z: z - nz * distance + nz * 0.04,
          nx,
          nz,
          armed: true,
          next: this.random() * 3,
          // Keep most detail on the shores that can be read from the camera.
          order:
            this.random() +
            Math.hypot(x * 0.8, z - 12) / 90 +
            (this.visibleFromCamera(x - nx * distance + nx * 0.04, z - nz * distance + nz * 0.04)
              ? 0
              : 4),
        })
      }
    candidates.sort((a, b) => a.order - b.order)
    for (const candidate of candidates) {
      if (this.contacts.length >= (mobile ? 64 : 160)) break
      if (
        this.contacts.every(
          (contact) => Math.hypot(contact.x - candidate.x, contact.z - candidate.z) > 1.3,
        )
      )
        this.contacts.push(candidate)
    }
    // Smooth ellipsoids rather than faceted voxel debris. Their long axis follows
    // velocity and contracts near the apex, where surface tension rounds drops.
    const geometry = new SphereGeometry(1, 10, 7)
    geometry.setAttribute(
      'aSplashOpacity',
      new InstancedBufferAttribute(new Float32Array(this.capacity), 1).setUsage(DynamicDrawUsage),
    )
    const material = new MeshStandardMaterial({
      color: 0xd3e7e6,
      roughness: 0.12,
      envMapIntensity: 1.35,
      metalness: 0,
      transparent: true,
      depthWrite: false,
    })
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float aSplashOpacity; varying float vSplashOpacity;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvSplashOpacity = aSplashOpacity;',
        )
      shader.fragmentShader =
        'varying float vSplashOpacity;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.a *= vSplashOpacity;',
        )
    }
    material.customProgramCacheKey = () => 'shore-impact-droplets-v1'
    this.mesh = new InstancedMesh(geometry, material, this.capacity)
    this.mesh.name = 'shore-impact-splashes'
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    this.mesh.visible = false
    this.mesh.renderOrder = 2
    scene.add(this.mesh)
    const sheetGeometry = new PlaneGeometry(1, 1, 36, 12)
    sheetGeometry.setAttribute(
      'aSheet',
      new InstancedBufferAttribute(new Float32Array(24 * 3), 3).setUsage(DynamicDrawUsage),
    )
    sheetGeometry.setAttribute(
      'aSheetShape',
      new InstancedBufferAttribute(new Float32Array(24 * 4), 4).setUsage(DynamicDrawUsage),
    )
    sheetGeometry.setAttribute(
      'aSheetTiming',
      new InstancedBufferAttribute(new Float32Array(24 * 3), 3).setUsage(DynamicDrawUsage),
    )
    const sheetMaterial = new MeshStandardMaterial({
      color: 0xbcd5d8,
      roughness: 0.12,
      envMapIntensity: 1.25,
      metalness: 0,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })
    sheetMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute vec3 aSheet;
attribute vec4 aSheetShape;
attribute vec3 aSheetTiming;
varying vec3 vSheetTiming;
varying vec3 vSheet;
varying vec2 vSheetUv;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `
vSheet = aSheet;
vSheetTiming = aSheetTiming;
vSheetUv = uv;
float angle = (uv.x - 0.5) * aSheetShape.x + aSheetShape.w;
float phase = clamp(aSheet.x / aSheetTiming.x, 0.0, 1.0);
float lobes = 3.0 + floor(fract(aSheet.z * 0.73) * 5.0);
float scallop = 1.0 + sin(uv.x * lobes * 6.283185 + aSheet.z) * 0.1
  + sin(uv.x * 17.0 + aSheet.z * 2.3) * 0.04;
// A short wall-wide upwash that tears before its apex, not an arc traced
// continuously from a nozzle to the water. Detached drops handle the return.
float rise = (1.0 - exp(-phase * 3.5)) * (0.06 + aSheet.y * 0.22) * aSheetShape.y;
float curl = pow(uv.y, 3.0) * phase * (0.07 + aSheet.y * 0.16);
vec3 transformed = vec3(
  (uv.x - 0.5) * aSheetTiming.z + sin(angle) * curl * aSheetShape.z,
  uv.y * rise * scallop,
  (uv.y * phase * 0.035 + cos(angle) * curl) * aSheetShape.z);
`,
      )
      shader.fragmentShader =
        `float sheetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float sheetNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(sheetHash(cell), sheetHash(cell+vec2(1,0)), f.x),
    mix(sheetHash(cell+vec2(0,1)), sheetHash(cell+vec2(1,1)), f.x), f.y);
}
varying vec3 vSheetTiming;
varying vec3 vSheet;
varying vec2 vSheetUv;
${shader.fragmentShader}`
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
vec2 p = vSheetUv;
float edge = smoothstep(0.0, 0.09, p.x) * smoothstep(0.0, 0.09, 1.0 - p.x)
  * smoothstep(0.0, 0.15, p.y) * smoothstep(0.0, 0.04, 1.0 - p.y);
float holes = sheetNoise(p * vec2(19.0, 8.0) + vSheet.z);
float threads = sheetNoise(p * vec2(37.0, 4.0) + vSheet.z * 2.0);
float phase = vSheet.x / vSheetTiming.x;
float breakup = smoothstep(vSheetTiming.y, 0.9, phase);
float film = smoothstep(breakup * 0.85, breakup * 0.85 + 0.12, holes * 0.7 + threads * 0.3);
diffuseColor.a *= edge * film * smoothstep(0.0, 0.03, vSheet.x)
  * (1.0 - smoothstep(0.55, 1.0, phase)) * 0.32;
if (diffuseColor.a < 0.005) discard;
`,
          )
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>
normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))) * (gl_FrontFacing ? 1.0 : -1.0);
`,
          )
    }
    sheetMaterial.customProgramCacheKey = () => 'shore-impact-upwash-v3'
    this.sheets = new InstancedMesh(sheetGeometry, sheetMaterial, 24)
    this.sheets.name = 'shore-impact-sheets'
    this.sheets.instanceMatrix.setUsage(DynamicDrawUsage)
    this.sheets.frustumCulled = false
    this.sheets.receiveShadow = true
    this.sheets.visible = false
    scene.add(this.sheets)
  }

  private visibleFromCamera(x: number, z: number) {
    const distance = Math.hypot(x, z - 16)
    for (let step = 0.5; step < distance; step += 0.45) {
      const t = step / distance
      const index = lakeIndex(this.bed, x * (1 - t), z + (16 - z) * t)
      if (index >= 0 && this.bed.obstacle[index]! > WATER_LEVEL + 0.04 + t * 2.3) return false
    }
    return true
  }

  private random() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0
    return this.state / 0x1_0000_0000
  }

  private shoreAt(x: number, z: number) {
    const n = this.shoreResolution
    const u = (x - LAKE_BOUNDS.minX) / this.shoreCell - 0.5
    const v = (z - LAKE_BOUNDS.minZ) / this.shoreCell - 0.5
    const col = Math.max(0, Math.min(n - 2, Math.floor(u))),
      row = Math.max(0, Math.min(n - 2, Math.floor(v)))
    const fx = Math.max(0, Math.min(1, u - col)),
      fz = Math.max(0, Math.min(1, v - row))
    const i = row * n + col,
      field = this.bed.shore
    return (
      (field[i]! * (1 - fx) + field[i + 1]! * fx) * (1 - fz) +
      (field[i + n]! * (1 - fx) + field[i + n + 1]! * fx) * fz
    )
  }

  private shoreOrigin(contact: Contact, offset: number) {
    // Slide on the actual wet boundary. Reject corners whose outward normal
    // no longer matches the struck face instead of emitting through solid rock.
    const x = contact.x - contact.nz * offset,
      z = contact.z + contact.nx * offset
    const distance = this.shoreAt(x, z)
    const px = x + contact.nx * (0.055 - distance),
      pz = z + contact.nz * (0.055 - distance)
    const wet = this.shoreAt(px, pz)
    if (
      wet < 0.005 ||
      wet > 0.16 ||
      this.shoreAt(px - contact.nx * 0.15, pz - contact.nz * 0.15) > -0.015
    )
      return null
    return { x: px, z: pz }
  }

  update(time: number, wind: WindState, reducedMotion = false, intro = 1) {
    if (reducedMotion) {
      this.mesh.visible = false
      this.sheets.visible = false
      this.impacts.update(time, true)
      return
    }
    if (time >= this.nextCheck && intro > 0.8) {
      this.nextCheck = time + 0.1
      let bursts = 0
      for (const contact of this.contacts) {
        const [height, , , velocity] = sampleWindField(contact.x, contact.z, time, wind, 0.08)
        if (velocity < -0.008) contact.armed = true
        const facing = Math.max(0, -contact.nx * wind.direction[0] - contact.nz * wind.direction[1])
        const force = Math.max(0, Math.min(1, (wind.speed - 1.7) / 5)) * facing
        if (
          !contact.armed ||
          time < contact.next ||
          force < 0.08 ||
          velocity < 0.018 ||
          height < -0.006
        )
          continue
        contact.armed = false
        contact.next = time + 1.8 + this.random() * 4.5
        // Qualifying waves can still wash quietly; exposed, stronger impacts
        // are more likely to break. There is no periodic splash emitter.
        if (bursts >= 3 || this.random() > 0.18 + force * 0.67) continue
        const energy = Math.min(1, force * 0.7 + velocity * 4)
        const profile = createSplashProfile(() => this.random(), energy)
        let origin = this.shoreOrigin(contact, (this.random() - 0.5) * 1.6)
        for (let attempt = 0; !origin && attempt < 3; attempt++)
          origin = this.shoreOrigin(contact, (this.random() - 0.5) * 1.2)
        if (!origin) continue
        const patch = { ...contact, x: origin.x, z: origin.z }
        // Fit the sheet to the same contiguous face used for its droplets.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (
            this.shoreOrigin(patch, -profile.width * 0.5) &&
            this.shoreOrigin(patch, profile.width * 0.5)
          )
            break
          profile.width *= 0.5
        }
        // A narrow invalid patch would recreate a fixed nozzle at block corners.
        if (profile.width < 0.18) continue
        const { count } = profile
        this.emitted++
        bursts++
        this.sheetsState[this.sheetCursor] = {
          x: origin.x,
          y: WATER_LEVEL + sampleWindField(origin.x, origin.z, time, wind, 0.08)[0],
          z: origin.z,
          heading: Math.atan2(contact.nx, contact.nz),
          born: time,
          energy,
          profile,
        }
        this.sheetCursor = (this.sheetCursor + 1) % this.sheetsState.length
        for (let i = 0; i < count; i++) {
          const jet =
            profile.jets[
              i < profile.jets.length ? i : Math.floor(this.random() * profile.jets.length)
            ]!
          const angle = jet.angle + (this.random() - 0.5) * 0.1
          const fine = this.random() < 0.32
          const source =
            this.shoreOrigin(patch, ((i + this.random()) / count - 0.5) * profile.width) ?? origin
          const speed =
            (0.25 + energy * 0.65) * profile.reach * jet.speed * (0.6 + this.random() * 0.8)
          const side = Math.sin(angle) * speed
          const outward = Math.cos(angle) * speed
          const lift =
            (0.55 + energy * 1.65) * profile.lift * jet.lift * (0.55 + this.random() * 0.9)
          const delay = jet.delay + (i / count) * profile.emission
          const size = fine
            ? 0.004 + this.random() * 0.007
            : 0.01 + this.random() ** 2 * (0.013 + energy * 0.019)
          this.drops[this.cursor] = {
            x: source.x + contact.nx * (0.015 + this.random() * 0.07),
            y:
              WATER_LEVEL +
              Math.max(
                0.015,
                sampleWindField(source.x, source.z, time + delay, wind, 0.08)[0] + 0.015,
              ) +
              this.random() * (0.025 + energy * 0.09),
            z: source.z + contact.nz * (0.015 + this.random() * 0.07),
            vx: contact.nx * outward - contact.nz * side + wind.direction[0] * wind.speed * 0.025,
            vz: contact.nz * outward + contact.nx * side + wind.direction[1] * wind.speed * 0.025,
            vy: lift,
            born: time + delay,
            size,
            drag: fine ? 4 + this.random() * 5 : 0.3 + this.random() * 0.9,
            windX: wind.direction[0] * wind.speed * 0.1,
            windZ: wind.direction[1] * wind.speed * 0.1,
            life: 1.6,
            lastAge: 0,
          }
          this.cursor = (this.cursor + 1) % this.capacity
        }
      }
    }
    const opacity = this.mesh.geometry.getAttribute('aSplashOpacity') as InstancedBufferAttribute
    this.transform.quaternion.identity()
    this.active = 0
    for (let i = 0; i < this.capacity; i++) {
      const drop = this.drops[i]
      if (!drop || time < drop.born) {
        this.transform.scale.setScalar(0)
        opacity.setX(i, 0)
      } else {
        const age = time - drop.born
        sampleDrop(drop, age, this.dropPosition, this.velocity)
        const { x, y, z } = this.dropPosition
        const descending = this.velocity.y < 0
        const surface = WATER_LEVEL + sampleWindField(x, z, time, wind, 0.08)[0]
        const landed = descending && y <= surface
        if (age < 0 || age > drop.life || landed || this.shoreAt(x, z) < -0.04) {
          if (landed && age <= drop.life) {
            // Solve the contact within this frame, rather than placing the
            // ripple at the next frame's already-submerged particle position.
            let low = drop.lastAge,
              high = age
            for (let iteration = 0; iteration < 7; iteration++) {
              const mid = (low + high) * 0.5
              sampleDrop(drop, mid, this.dropPosition)
              const gap =
                this.dropPosition.y -
                WATER_LEVEL -
                sampleWindField(
                  this.dropPosition.x,
                  this.dropPosition.z,
                  drop.born + mid,
                  wind,
                  0.08,
                )[0]
              if (gap > 0) low = mid
              else high = mid
            }
            sampleDrop(drop, high, this.dropPosition, this.velocity)
            const hitX = this.dropPosition.x,
              hitZ = this.dropPosition.z
            if (this.shoreAt(hitX, hitZ) > 0) {
              const speed = Math.max(0, -this.velocity.y)
              const energy = Math.min(1, Math.max(0.08, ((drop.size / 0.045) ** 2 * speed) / 3))
              this.impacts.add(hitX, hitZ, drop.born + high, energy)
              this.onReturn?.(hitX, hitZ, 0.15 + energy * 0.2, -(0.012 + energy * 0.05))
            }
          }
          this.drops[i] = null
          this.transform.scale.setScalar(0)
          opacity.setX(i, 0)
        } else {
          drop.lastAge = age
          this.active++
          this.transform.position.set(x, y, z)
          const speed = this.velocity.length()
          this.transform.quaternion.setFromUnitVectors(this.up, this.velocity.normalize())
          this.transform.scale.set(drop.size * 0.7, drop.size * (1 + speed * 0.22), drop.size * 0.7)
          opacity.setX(i, Math.min(1, age / 0.035) * Math.min(1, (drop.life - age) / 0.12) * 0.85)
        }
      }
      this.transform.updateMatrix()
      this.mesh.setMatrixAt(i, this.transform.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    opacity.needsUpdate = true
    this.mesh.visible = this.active > 0
    const sheetData = this.sheets.geometry.getAttribute('aSheet') as InstancedBufferAttribute
    const shapeData = this.sheets.geometry.getAttribute('aSheetShape') as InstancedBufferAttribute
    const timingData = this.sheets.geometry.getAttribute('aSheetTiming') as InstancedBufferAttribute
    let activeSheets = 0
    for (let i = 0; i < this.sheetsState.length; i++) {
      const sheet = this.sheetsState[i]
      const age = sheet ? time - sheet.born : 1
      if (!sheet || age < 0 || age > sheet.profile.lifetime) {
        this.sheetsState[i] = null
        this.transform.scale.setScalar(0)
        sheetData.setXYZ(i, 0, 0, 0)
        timingData.setXYZ(i, 1, 0.3, 0)
      } else {
        activeSheets++
        this.transform.position.set(sheet.x, sheet.y, sheet.z)
        this.transform.rotation.set(0, sheet.heading, 0)
        this.transform.scale.setScalar(1)
        sheetData.setXYZ(i, age, sheet.energy, sheet.profile.seed)
        shapeData.setXYZW(
          i,
          sheet.profile.fan,
          sheet.profile.lift,
          sheet.profile.reach,
          sheet.profile.lean,
        )
        timingData.setXYZ(i, sheet.profile.lifetime, sheet.profile.tear, sheet.profile.width)
      }
      this.transform.updateMatrix()
      this.sheets.setMatrixAt(i, this.transform.matrix)
    }
    this.sheets.instanceMatrix.needsUpdate = true
    sheetData.needsUpdate = shapeData.needsUpdate = timingData.needsUpdate = true
    this.sheets.visible = activeSheets > 0
    this.impacts.update(time)
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
    this.sheets.removeFromParent()
    this.sheets.geometry.dispose()
    this.sheets.material.dispose()
    this.sheets.dispose()
    this.impacts.dispose()
  }
}

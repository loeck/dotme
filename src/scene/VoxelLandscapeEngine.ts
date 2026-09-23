import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PointLight,
  Raycaster,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three'

import { DepthFocus } from './depth-focus'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { createLakeReflector } from './lake-water'
import type { LakeReflector } from './lake-water'
import { createSkyMaterial } from './sky-material'
import { SubmergedScene } from './submerged-scene'
import { createVoxelWorld } from './voxel-world'
import { WaterSimulation } from './water-simulation'
import { createWaterGeometry, swellHeight } from './water-surface'

export type VoxelLandscapeEngineOptions = Readonly<{
  container: HTMLDivElement
  onContextFailure: () => void
  onFirstFrame: () => void
  reducedMotion?: boolean
  seed?: number
}>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

const GLOW_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const GLOW_FRAGMENT = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = dot(p, p);
  float core = exp(-r * 39.0) * 0.76;
  float halo = exp(-r * 5.5) * 0.095;
  float vertical = exp(-p.x * p.x * 100.0 - p.y * p.y * 8.0) * 0.055;
  gl_FragColor = vec4(uColor * (core + halo + vertical) * uIntensity, 1.0);
}
`

type Mote = Readonly<{
  x: number
  y: number
  z: number
  size: number
  phase: number
  speed: number
}>

export class VoxelLandscapeEngine {
  private readonly options: VoxelLandscapeEngineOptions
  private readonly container: HTMLDivElement
  private readonly renderer: WebGLRenderer
  private readonly depthFocus: DepthFocus
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(54, 1, 0.05, 500)
  private readonly raycaster = new Raycaster()
  private readonly rayNdc = new Vector2()
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL)
  private readonly waterHit = new Vector3()
  private readonly pointer = new Vector2(0, 0)
  private readonly pointerClient = new Vector2(-1, -1)
  private readonly target = new Vector2(0, 0)
  private readonly waterPointerTarget = new Vector3(0, 0, 0)
  private readonly objects: Object3D[] = []
  private readonly materials: Array<{ dispose: () => void }> = []
  private readonly geometries: Array<{ dispose: () => void }> = []
  private readonly glows: Array<{ material: ShaderMaterial; phase: number; base: number }> = []
  private readonly lampLights: Array<{ light: PointLight; intensity: number; phase: number }> = []
  private readonly motes: Mote[] = []
  private moteMesh: InstancedMesh<BoxGeometry, MeshBasicMaterial> | null = null
  private readonly moteTransform = new Object3D()
  private readonly drawingBufferSize = new Vector2()
  private readonly water: LakeReflector
  private readonly simulation: WaterSimulation
  private readonly submerged: SubmergedScene
  private bed!: LakeBed
  private pointerActive = false
  private pointerType = 'mouse'
  private pointerHeight = 0
  private pointerRevision = 0
  private pointerBusy = false
  private pendingPointer: { x: number; y: number; time: number } | null = null
  private previousPointer: { x: number; y: number; time: number } | null = null
  private readonly skyMaterial: ShaderMaterial
  private readonly sky: Mesh<SphereGeometry, ShaderMaterial>
  private readonly voxelGroup = new Group()
  private frame = 0
  private lastFrameAt = 0
  private elapsed = 0
  private intro = 0
  private introStartedAt: number | null = null
  private dragging = false
  private dragPointerId = -1
  private disposed = false
  private rendered = false
  private width = 1
  private height = 1
  private mobile = false

  constructor(options: VoxelLandscapeEngineOptions) {
    this.options = options
    this.container = options.container
    this.mobile = window.innerWidth < 768
    this.renderer = new WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setClearColor(0x080c11)
    this.depthFocus = new DepthFocus(this.renderer, this.mobile)
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.domElement.className = 'block h-full w-full touch-none'
    this.renderer.domElement.dataset.seed = String((options.seed ?? 0) >>> 0)
    this.renderer.domElement.dataset.generatorVersion = 'voxel-landscape-v1'
    this.container.append(this.renderer.domElement)
    this.scene.fog = new FogExp2(0x14202a, 0.009)
    this.scene.background = new Color(0x080c11)
    this.scene.add(new AmbientLight(0x526074, 0.38))
    // Grazing moonlight separates the top and side faces without lifting the sky.
    const moonRim = new DirectionalLight(0xa3bfd6, 1.15)
    moonRim.position.set(-35, 28, -48)
    this.scene.add(moonRim)
    const moon = new PointLight(0x758ba6, 11, 100, 1.4)
    moon.position.set(-18, 20, -23)
    this.scene.add(moon)

    this.skyMaterial = createSkyMaterial((options.seed ?? 0) >>> 0, this.mobile)
    const skyGeometry = new SphereGeometry(260, 32, 16)
    this.sky = new Mesh(skyGeometry, this.skyMaterial)
    this.sky.frustumCulled = false
    this.scene.add(this.sky)
    this.materials.push(this.skyMaterial)
    this.geometries.push(skyGeometry)

    this.scene.add(this.voxelGroup)
    this.buildWorld((options.seed ?? 0) >>> 0)
    this.simulation = new WaterSimulation(this.renderer, this.bed, this.mobile)
    this.submerged = new SubmergedScene(this.scene, this.bed, this.simulation.available)
    this.scene.traverse((object) => {
      if ('isLight' in object) object.layers.enable(1)
    })
    const waterGeometry = createWaterGeometry(this.mobile)
    this.water = createLakeReflector(waterGeometry, this.mobile)
    const uniforms = this.water.material.uniforms
    uniforms.uState!.value = this.simulation.texture
    uniforms.uMask!.value = this.simulation.mask
    uniforms.uCell!.value = LAKE_BOUNDS.size / this.simulation.resolution
    uniforms.uBedColor!.value = this.submerged.target.texture
    uniforms.uBedDepth!.value = this.submerged.target.depthTexture
    uniforms.uBedHeight!.value = this.submerged.depthField
    this.renderer.domElement.dataset.waterMode = this.simulation.available ? 'gpu' : 'analytic'
    if (!this.simulation.available) this.water.getRenderTarget().texture.type = UnsignedByteType
    this.water.rotation.x = -Math.PI / 2
    this.water.position.y = WATER_LEVEL
    this.scene.add(this.water)
    this.objects.push(this.water)
    this.geometries.push(waterGeometry)

    this.camera.position.set(0, 2.3, 16)
    this.camera.lookAt(0, this.mobile ? 2.3 : 7.3, -25)

    this.resize()
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.addEventListener('lostpointercapture', this.onLostCapture)
    window.addEventListener('blur', this.onPointerLeave)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost)
    this.lastFrameAt = performance.now()
    this.frame = requestAnimationFrame(this.render)
  }

  private buildWorld(seed: number) {
    const world = createVoxelWorld(seed, this.mobile)
    this.bed = world.lakeBed
    const terrainEnd =
      world.groups.ground.count + world.groups.shore.count + world.groups.rock.count
    const leafStart = terrainEnd + world.groups.treeTrunk.count
    const leafEnd = leafStart + world.groups.treeLeaf.count
    const groups = new Map<
      string,
      { color: number; level: number; warm: boolean; voxels: typeof world.voxels }
    >()
    for (let index = 0; index < world.voxels.length; index += 1) {
      const voxel = world.voxels[index]!
      const isTerrain = index < terrainEnd
      const isLeaf = index >= leafStart && index < leafEnd
      let light = 0
      let warm = true
      for (const lamp of world.lamps) {
        const dx = voxel.x - lamp.x
        const dz = voxel.z - lamp.z
        const dy = voxel.y - lamp.y - 0.85
        // The cap lights a few neighboring stones, not the full bank or tree crown.
        if (voxel.y > lamp.y + (isLeaf ? 4.5 : 1.45)) continue
        const distance = dx * dx + dz * dz + dy * dy * (isLeaf ? 0.75 : 1.8)
        const prominent = lamp.warm && lamp.intensity >= 0.95
        const influence =
          lamp.intensity * (prominent ? 0.92 : 1) * Math.exp(-distance / (prominent ? 6.5 : 4.6))
        if (influence > light) {
          light = influence
          warm = lamp.warm
        }
      }
      const facetSeed =
        Math.sin(voxel.x * 12.9898 + voxel.y * 78.233 + voxel.z * 37.719) * 43758.5453
      const facet = facetSeed - Math.floor(facetSeed)
      const lampLevel = light > 0.63 && facet > 0.84 ? 2 : light > 0.28 && facet > 0.52 ? 1 : 0
      const moonFacet =
        (isLeaf && voxel.y > 2 && facet > 0.82) ||
        (isTerrain && voxel.y < 0.8 && voxel.z > -48 && facet > 0.91) ||
        (isTerrain && voxel.y > 2 && voxel.x > 35 && voxel.z < -32 && facet > 0.91)
      const level = Math.max(lampLevel, moonFacet ? 1 : 0)
      if (lampLevel === 0 && moonFacet) warm = false
      const key = `${voxel.color}:${level}:${warm ? 1 : 0}`
      let group = groups.get(key)
      if (!group) {
        group = { color: voxel.color, level, warm, voxels: [] }
        groups.set(key, group)
      }
      group.voxels.push(voxel)
    }
    const box = new BoxGeometry(1, 1, 1)
    this.geometries.push(box)
    const dummy = new Object3D()
    for (const { color, level, warm, voxels } of groups.values()) {
      const lightColor = new Color(warm ? 0xb0a495 : 0x9aafbc)
      const baseColor = new Color(color)
      const lightAmount = level === 2 ? 0.22 : level === 1 ? 0.055 : 0
      const material = new MeshStandardMaterial({
        color: baseColor.clone().lerp(lightColor, lightAmount * 0.28),
        emissive: baseColor.clone().lerp(lightColor, lightAmount),
        emissiveIntensity: level === 2 ? 0.35 : level === 1 ? 0.21 : 0.1,
        roughness: 0.96,
        metalness: 0.08,
        flatShading: true,
        transparent: true,
        opacity: 0,
      })
      this.materials.push(material)
      const mesh = new InstancedMesh(box, material, voxels.length)
      for (let i = 0; i < voxels.length; i += 1) {
        const voxel = voxels[i]!
        dummy.position.set(voxel.x, voxel.y, voxel.z)
        dummy.scale.setScalar(voxel.size)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      this.voxelGroup.add(mesh)
      this.objects.push(mesh)
    }

    const poleGeometry = new BoxGeometry(0.055, 0.84, 0.055)
    const capGeometry = new BoxGeometry(0.065, 0.28, 0.065)
    const poleMaterial = new MeshStandardMaterial({
      color: 0x42464c,
      roughness: 0.8,
      metalness: 0.55,
    })
    const capMaterial = new MeshBasicMaterial({ color: 0xffd9a1 })
    const glowGeometry = new PlaneGeometry(2.15, 2.15)
    this.geometries.push(poleGeometry, capGeometry, glowGeometry)
    this.materials.push(poleMaterial, capMaterial)
    world.lamps.forEach((lamp, index) => {
      const warm = lamp.warm
      const pole = new Mesh(poleGeometry, poleMaterial)
      pole.position.set(lamp.x, lamp.y + 0.42, lamp.z)
      this.scene.add(pole)
      this.objects.push(pole)
      const cap = new Mesh(
        capGeometry,
        new MeshBasicMaterial({ color: warm ? 0xffd2a3 : 0xb4d9f5 }),
      )
      cap.position.set(lamp.x, lamp.y + 0.89, lamp.z)
      this.scene.add(cap)
      this.objects.push(cap)
      this.materials.push(cap.material)
      const prominent = warm && lamp.intensity >= 0.95
      const intensity = prominent ? 38 : warm ? 22 : 6.5
      const light = new PointLight(
        warm ? 0xffd5ad : 0xa5d4ee,
        intensity,
        prominent ? 11 : 8,
        prominent ? 2 : 1.5,
      )
      light.position.copy(cap.position)
      this.scene.add(light)
      this.objects.push(light)
      this.lampLights.push({ light, intensity, phase: index * 2.31 })
      const glowMaterial = new ShaderMaterial({
        vertexShader: GLOW_VERTEX,
        fragmentShader: GLOW_FRAGMENT,
        uniforms: {
          uColor: { value: new Color(warm ? 0xffd8b3 : 0xa5d9ff) },
          uIntensity: { value: 0 },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      })
      const glow = new Mesh(glowGeometry, glowMaterial)
      glow.position.copy(cap.position)
      glow.position.y += 0.01
      glow.frustumCulled = false
      this.scene.add(glow)
      this.objects.push(glow)
      this.materials.push(glowMaterial)
      this.glows.push({
        material: glowMaterial,
        phase: index * 2.31,
        base: prominent ? 1.05 : warm ? 0.78 : 0.58,
      })
    })

    // A few dim, square flecks drift in depth. They provide a living scale cue without
    // turning the open sky into a particle field.
    let randomState = (seed ^ 0x6a09e667) >>> 0
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return randomState / 0x1_0000_0000
    }
    const moteCount = this.mobile ? 6 : 16
    const moteGeometry = new BoxGeometry(1, 1, 1)
    const moteMaterial = new MeshBasicMaterial({
      color: 0x5b7080,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const moteMesh = new InstancedMesh(moteGeometry, moteMaterial, moteCount)
    for (let index = 0; index < moteCount; index += 1) {
      const z = -11 - random() * 65
      const x = (random() - 0.5) * (this.mobile ? 23 : 110)
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
      this.moteTransform.position.set(mote.x, mote.y, mote.z)
      this.moteTransform.scale.setScalar(mote.size)
      this.moteTransform.updateMatrix()
      moteMesh.setMatrixAt(index, this.moteTransform.matrix)
    }
    moteMesh.instanceMatrix.needsUpdate = true
    moteMesh.computeBoundingSphere()
    this.moteMesh = moteMesh
    this.scene.add(moteMesh)
    this.objects.push(moteMesh)
    this.geometries.push(moteGeometry)
    this.materials.push(moteMaterial)
  }

  private hitWater(clientX: number, clientY: number): Vector3 | null {
    const canvas = this.renderer.domElement
    if (document.elementFromPoint(clientX, clientY) !== canvas) return null
    const bounds = canvas.getBoundingClientRect()
    const x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    const y = -((clientY - bounds.top) / bounds.height) * 2 + 1
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return null
    this.rayNdc.set(x, y)
    this.raycaster.setFromCamera(this.rayNdc, this.camera)
    const ray = this.raycaster.ray
    this.waterPlane.constant = -WATER_LEVEL
    if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    for (let i = 0; i < 3; i++) {
      this.waterPlane.constant = -(
        WATER_LEVEL +
        this.pointerHeight +
        swellHeight(this.waterHit.x, this.waterHit.z, this.elapsed)
      )
      if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    }
    const distance = this.waterHit.distanceTo(this.camera.position)
    const index = lakeIndex(this.bed, this.waterHit.x, this.waterHit.z)
    if (distance > 130 || index < 0 || !this.bed.water[index]) return null
    // Conservative raster of the actual solids includes stones and tree silhouettes.
    const cell = LAKE_BOUNDS.size / this.bed.resolution
    for (let d = 0; d < distance - 0.05; d += cell * 0.5) {
      const px = ray.origin.x + ray.direction.x * d
      const pz = ray.origin.z + ray.direction.z * d
      const i = lakeIndex(this.bed, px, pz)
      if (i >= 0 && this.bed.obstacle[i]! >= ray.origin.y + ray.direction.y * d) return null
    }
    return this.waterHit.clone()
  }

  private async processPointer() {
    const event = this.pendingPointer
    if (!event || this.pointerBusy || this.disposed) return
    this.pendingPointer = null
    this.pointerBusy = true
    const revision = this.pointerRevision
    try {
      let point = this.hitWater(event.x, event.y)
      if (!point) {
        this.previousPointer = null
        return
      }
      this.pointerHeight = await this.simulation.heightAt(point.x, point.z)
      if (this.disposed || revision !== this.pointerRevision) return
      point = this.hitWater(event.x, event.y)
      if (!point) {
        this.previousPointer = null
        return
      }
      const previous = this.previousPointer
      if (previous && (event.x !== previous.x || event.y !== previous.y)) {
        // Reproject both client positions with the SAME camera. Parallax is never input energy.
        const start = this.hitWater(previous.x, previous.y)
        if (start) {
          const distance = start.distanceTo(point)
          const seconds = Math.max(0.008, (event.time - previous.time) / 1000)
          const speed = Math.min(25, distance / seconds)
          const samples = Math.min(48, Math.ceil(distance / 0.22))
          for (let i = 1; i <= samples; i++) {
            const t = i / samples
            // Screen-space samples are visibility checked; a long stroke cannot cross a bank.
            const contact = this.hitWater(
              previous.x + (event.x - previous.x) * t,
              previous.y + (event.y - previous.y) * t,
            )
            if (contact)
              this.simulation.addImpulse(
                contact.x,
                contact.z,
                this.dragging ? 0.48 : 0.36,
                -Math.min(0.45, 0.018 + speed * 0.018) *
                  (this.dragging ? 1.5 : 0.55) *
                  Math.min(1, distance / Math.max(1, samples) / 0.22),
              )
          }
        }
      }
      this.previousPointer = event
    } finally {
      this.pointerBusy = false
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    if (this.options.reducedMotion || event.button !== 0) return
    const point = this.hitWater(event.clientX, event.clientY)
    if (!point) return
    // Queue the contact immediately so a quick touch ending before the next frame still ripples.
    this.simulation.addImpulse(point.x, point.z, 0.48, -0.4)
    this.dragging = true
    this.dragPointerId = event.pointerId
    this.pointerType = event.pointerType
    this.pointerActive = true
    this.pointerClient.set(event.clientX, event.clientY)
    this.previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.pendingPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.options.reducedMotion || (this.dragging && event.pointerId !== this.dragPointerId))
      return
    this.pointerType = event.pointerType
    this.pointerActive = event.pointerType !== 'touch' || this.dragging
    this.target.set(
      clamp((event.clientX / this.width) * 2 - 1, -1, 1),
      clamp((event.clientY / this.height) * 2 - 1, -1, 1),
    )
    if (this.pointerClient.x === event.clientX && this.pointerClient.y === event.clientY) return
    this.pointerClient.set(event.clientX, event.clientY)
    if (!this.pointerActive || !this.hitWater(event.clientX, event.clientY)) {
      this.previousPointer = null
      this.pendingPointer = null
      this.pointerRevision += 1
      return
    }
    this.pendingPointer = {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    }
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.dragPointerId) return
    this.dragging = false
    this.dragPointerId = -1
    if (event.type === 'pointercancel' || this.pointerType === 'touch') this.onPointerLeave()
    if (this.renderer.domElement.hasPointerCapture(event.pointerId))
      this.renderer.domElement.releasePointerCapture(event.pointerId)
  }

  private onLostCapture = () => {
    if (this.dragging) this.onPointerLeave()
  }

  private onPointerLeave = () => {
    const pointerId = this.dragPointerId
    this.pointerActive = false
    this.dragging = false
    this.dragPointerId = -1
    this.previousPointer = null
    this.pendingPointer = null
    this.pointerRevision += 1
    this.waterPointerTarget.z = 0
    if (pointerId >= 0 && this.renderer.domElement.hasPointerCapture(pointerId))
      this.renderer.domElement.releasePointerCapture(pointerId)
  }

  private onVisibilityChange = () => {
    this.onPointerLeave()
    if (document.hidden) return
    this.lastFrameAt = performance.now()
    if (this.options.reducedMotion && this.frame === 0)
      this.frame = requestAnimationFrame(this.render)
  }

  private onContextLost = (event: Event) => {
    event.preventDefault()
    this.options.onContextFailure()
    this.dispose()
  }

  private render = (now: number) => {
    if (this.disposed) return
    if (this.options.reducedMotion) this.frame = 0
    else this.frame = requestAnimationFrame(this.render)
    if (document.hidden) return
    const dt = clamp((now - this.lastFrameAt) / 1000, 0, 0.05)
    this.lastFrameAt = now
    if (!this.options.reducedMotion) this.elapsed += dt
    if (this.introStartedAt === null) this.introStartedAt = now
    this.intro = this.options.reducedMotion ? 1 : clamp((now - this.introStartedAt) / 2200, 0, 1)

    const envelope = smooth(0, 0.62, this.intro)
    for (const child of this.voxelGroup.children) {
      const mesh = child as InstancedMesh<BoxGeometry, MeshStandardMaterial>
      mesh.material.opacity = envelope
    }
    const parallax = this.options.reducedMotion ? 0 : 1 - Math.exp(-dt * 2.8)
    this.pointer.lerp(this.target, parallax)
    const idleDrift = this.options.reducedMotion ? 0 : Math.sin(this.elapsed * 0.17) * 0.15
    this.camera.position.x += (this.pointer.x * 1.9 + idleDrift - this.camera.position.x) * parallax
    this.camera.position.y += (2.3 + this.pointer.y * -0.16 - this.camera.position.y) * parallax
    this.camera.position.z = 16
    this.camera.lookAt(this.camera.position.x * 0.22, this.mobile ? 2.3 : 7.3, -25)
    this.camera.updateMatrixWorld()
    const waterPoint = this.pointerActive
      ? this.hitWater(this.pointerClient.x, this.pointerClient.y)
      : null
    if (waterPoint) this.waterPointerTarget.set(waterPoint.x, waterPoint.z, 1)
    else this.waterPointerTarget.z = 0
    void this.processPointer().catch(() => {
      this.previousPointer = null
    })
    const uniforms = this.water.material.uniforms
    for (const [index, lamp] of this.lampLights.entries()) {
      const light = lamp.light
      ;(uniforms.uLamps!.value[index] as Vector4).set(
        light.position.x,
        light.position.y,
        light.position.z,
        light.intensity,
      )
      uniforms.uWarm!.value[index] = light.color.r > light.color.b ? 1 : 0
    }
    uniforms.uBedInverseViewProjection!.value.copy(this.submerged.inverseViewProjection)
    uniforms.uBedViewProjection!.value.copy(this.submerged.viewProjection)
    this.sky.position.copy(this.camera.position)
    this.skyMaterial.uniforms.uTime!.value = this.elapsed
    this.water.material.uniforms.uTime!.value = this.elapsed
    const waterPointer = this.water.material.uniforms.uPointer!.value as Vector3
    // The contact point must stay under the cursor while the camera eases.
    // Only the optical reveal trails off; smoothing x/z makes the surface feel detached.
    waterPointer.x = this.waterPointerTarget.x
    waterPointer.y = this.waterPointerTarget.y
    waterPointer.z += (this.waterPointerTarget.z - waterPointer.z) * (1 - Math.exp(-dt * 8))
    for (const [index, glow] of this.glows.entries()) {
      glow.material.uniforms.uIntensity!.value =
        smooth(0.12 + index * 0.045, 0.55 + index * 0.045, this.intro) *
        glow.base *
        (1 + Math.sin(this.elapsed * (1.1 + index * 0.13) + glow.phase) * 0.065)
    }
    for (const lamp of this.lampLights) {
      lamp.light.intensity =
        lamp.intensity *
        (1 + Math.sin(this.elapsed * 1.17 + lamp.phase) * (this.options.reducedMotion ? 0 : 0.035))
    }
    if (this.moteMesh) {
      this.moteMesh.material.opacity = smooth(0.25, 0.9, this.intro) * 0.2
      if (!this.options.reducedMotion) {
        for (const [index, mote] of this.motes.entries()) {
          this.moteTransform.position.set(
            mote.x + Math.sin(this.elapsed * mote.speed * 0.71 + mote.phase) * 0.11,
            mote.y + Math.sin(this.elapsed * mote.speed + mote.phase) * 0.22,
            mote.z,
          )
          this.moteTransform.scale.setScalar(mote.size)
          this.moteTransform.updateMatrix()
          this.moteMesh.setMatrixAt(index, this.moteTransform.matrix)
        }
        this.moteMesh.instanceMatrix.needsUpdate = true
      }
    }
    if (!this.options.reducedMotion) this.simulation.step(dt)
    uniforms.uState!.value = this.simulation.texture
    this.submerged.render(this.renderer, this.scene)
    this.depthFocus.render(this.renderer, this.scene, this.camera)
    if (!this.rendered) {
      this.rendered = true
      this.options.onFirstFrame()
    }
  }

  resize = () => {
    if (this.disposed) return
    const bounds = this.container.getBoundingClientRect()
    this.width = Math.max(1, bounds.width)
    this.height = Math.max(1, bounds.height)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.width < 768 ? 1.5 : 1.75),
    )
    this.renderer.setSize(this.width, this.height, false)
    this.renderer.getDrawingBufferSize(this.drawingBufferSize)
    this.depthFocus.resize(
      this.drawingBufferSize.x,
      this.drawingBufferSize.y,
      this.width,
      this.height,
    )
    this.submerged.resize(this.mobile)
    this.water.material.uniforms.uBedTexel!.value.set(
      1 / this.submerged.target.width,
      1 / this.submerged.target.height,
    )
    const reflectionScale = Math.min(
      this.mobile ? 0.4 : 0.46,
      768 / this.drawingBufferSize.x,
      832 / this.drawingBufferSize.y,
    )
    this.water
      .getRenderTarget()
      .setSize(
        Math.max(256, Math.round(this.drawingBufferSize.x * reflectionScale)),
        Math.max(256, Math.round(this.drawingBufferSize.y * reflectionScale)),
      )
    if (this.options.reducedMotion && this.rendered && this.frame === 0)
      this.frame = requestAnimationFrame(this.render)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.removeEventListener('lostpointercapture', this.onLostCapture)
    window.removeEventListener('blur', this.onPointerLeave)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    for (const object of this.objects) this.scene.remove(object)
    this.pointerRevision += 1
    this.simulation.dispose()
    this.submerged.dispose()
    this.water.dispose()
    this.depthFocus.dispose()
    for (const material of this.materials) material.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

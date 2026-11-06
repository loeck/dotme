import {
  abs,
  attribute,
  cameraPosition,
  dot,
  float,
  min,
  normalize,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  saturate,
  sin,
  texture,
  transformNormalToView,
  uniform,
  uv,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three/webgpu'
import type { Node, Object3D } from 'three/webgpu'

import type { LightingState } from './lighting'
import type { PointerLightResponse } from './pointer-light'
import type { MeshData } from './vegetation-meshes'
import type { PreparedVegetation } from './vegetation-placement'
import { WindGusts } from './wind-gusts'

/** Shadow casters live on this layer; see the moon's shadow camera. */
const SHADOW_LAYER = 5
/** Foreground undergrowth: only the main camera enables this layer, so the water reflection,
 * the environment probe and the shadow pass never draw it. */
export const UNDERGROWTH_LAYER = 7
/** Wind speed (m/s) at which vegetation reaches its full lean. */
const FULL_LEAN_SPEED = 9
/** Height of the atlas's needle and leaf domes, metres: a few millimetres, as real shoots. */
const RELIEF_METRES = 0.004
/**
 * How the night cursor's lantern lights each draw. Leaves, needles and blades pass a good
 * share of a light to their far side, and a crown's cards face every way. Its leaves are
 * also darker than the ground and its cutouts show the night behind, so on a crown the same
 * lantern read as a faint smudge next to its pool on the ground: the gain brings it level.
 */
const FOLIAGE_POINTER_LIGHT: PointerLightResponse = { translucency: 0.6, gain: 4 }
const UNDERGROWTH_POINTER_LIGHT: PointerLightResponse = { translucency: 0.5 }
/** Fastest flutter, about 1.1 Hz. */
const MAX_FLUTTER_OMEGA = 7

/**
 * The forest as three draws: tube-meshed wood, foliage cards and procedural undergrowth. Sway follows Voxen's ADR 0110 (a height-squared shear, a rest lean and three
 * buffeting sines at 1.2/√H Hz); cards and blades add a light flutter.
 */
export class Vegetation {
  readonly meshes: Mesh[] = []
  /** How each mesh takes the night cursor's light; wood keeps the opaque default. */
  readonly pointerLight = new Map<Mesh, PointerLightResponse>()
  private readonly time = uniform(0)
  /** Gusts the visitor raises by sweeping the pointer across the scene. */
  readonly gusts = new WindGusts()
  private readonly wind = uniform(new Vector2(1, 0))
  private readonly strength = uniform(0)
  private readonly sunDirection = uniform(new Vector3(0, 1, 0))
  private readonly sunColour = uniform(new Color())
  private readonly ambient = uniform(new Color())
  private readonly disposables: Array<{ dispose(): void }> = []

  constructor(parent: Object3D, prepared: PreparedVegetation) {
    const atlas = new DataTexture(
      prepared.atlas.data,
      prepared.atlas.width,
      prepared.atlas.height,
      RGBAFormat,
      UnsignedByteType,
    )
    atlas.colorSpace = NoColorSpace
    // The worker bakes a coverage-preserving mip chain (see `foliage-atlas.ts`).
    atlas.mipmaps = prepared.atlas.mipmaps.map((level) => ({ ...level }))
    atlas.generateMipmaps = false
    atlas.minFilter = LinearMipmapLinearFilter
    atlas.magFilter = LinearFilter
    atlas.needsUpdate = true
    this.disposables.push(atlas)

    this.add(parent, 'wood', prepared.wood, this.woodMaterial(), true, false, {})
    this.add(
      parent,
      'foliage',
      prepared.foliage,
      this.foliageMaterial(atlas),
      true,
      false,
      FOLIAGE_POINTER_LIGHT,
    )
    this.add(
      parent,
      'undergrowth',
      prepared.undergrowth,
      this.undergrowthMaterial(),
      false,
      true,
      UNDERGROWTH_POINTER_LIGHT,
    )
  }

  private add(
    parent: Object3D,
    name: string,
    data: MeshData,
    material: MeshStandardNodeMaterial,
    castShadow: boolean,
    mainViewOnly: boolean,
    pointerLight: PointerLightResponse,
  ) {
    if (!data.indices.length) {
      material.dispose()
      return
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3, true))
    geometry.setAttribute('color', new BufferAttribute(data.colors, 3))
    geometry.setAttribute('wind', new BufferAttribute(data.wind, 4))
    if (data.uvs.length) geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2))
    geometry.setIndex(new BufferAttribute(data.indices, 1))
    geometry.computeBoundingSphere()
    // Sway and flutter reach a little beyond the rest bounds.
    if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.5
    const mesh = new Mesh(geometry, material)
    mesh.name = `Vegetation ${name}`
    mesh.castShadow = castShadow
    if (castShadow) mesh.layers.enable(SHADOW_LAYER)
    if (mainViewOnly) mesh.layers.set(UNDERGROWTH_LAYER)
    parent.add(mesh)
    this.meshes.push(mesh)
    this.pointerLight.set(mesh, pointerLight)
    this.disposables.push(geometry, material)
  }

  /** World-space wind offset from the per-vertex (bend, phase, flutter, ω) attribute. */
  private sway(): Node<'vec3'> {
    const wind = attribute<'vec4'>('wind')
    const bend = wind.x,
      phase = wind.y,
      flutter = wind.z,
      omega = wind.w
    const t = this.time.mul(omega)
    const buffet = sin(t.mul(0.53).add(phase))
      .mul(0.5)
      .add(sin(t.mul(0.97).add(phase.mul(1.7))).mul(0.3))
      .add(sin(t.mul(1.61).add(phase.mul(2.3))).mul(0.2))
    const lean = this.strength.mul(this.strength.mul(0.6).add(buffet.mul(0.25)).add(0.1))
    // Flutter moves each card, blade or leaflet as one piece (its vertices share the phase) at a
    // bounded rate. Varying it per vertex deformed cards, and tying it to fast natural rates made
    // the vegetation tremble, as Voxen's ADR 0110 found for a fixed 2 Hz flutter.
    const shiver = sin(
      this.time.mul(min(omega.mul(1.7), MAX_FLUTTER_OMEGA)).add(phase.mul(5.3)),
    ).mul(flutter.mul(this.strength.add(0.15)))
    const direction = vec3(this.wind.x, float(0), this.wind.y)
    return direction
      .mul(lean.mul(bend).add(shiver))
      .add(vec3(0, shiver.mul(0.5), 0))
      .add(this.gusts.sway(positionLocal, bend, phase, this.time))
  }

  private woodMaterial() {
    const material = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
    })
    material.positionNode = positionLocal.add(this.sway())
    return material
  }

  private foliageMaterial(atlas: DataTexture) {
    // Needles and leaves are matte at this scale: a full sky reflection at grazing angles
    // paled every crown's top edge against the sky.
    const material = new MeshStandardNodeMaterial({
      roughness: 0.95,
      metalness: 0,
      envMapIntensity: 0.45,
      side: DoubleSide,
    })
    material.positionNode = positionLocal.add(this.sway())
    const sample = texture(atlas, uv())
    // The mip chain already keeps each tile's coverage, so distant crowns neither thin out nor
    // fill their cards into squares.
    const coverage = sample.a
    material.alphaTest = 0.5
    // Needle-to-needle and leaf-to-leaf tone, kept within about ±35% of the palette: a wider
    // spread pushed sunlit leaves into the tone curve's shoulder, which washed them pale grey.
    const albedo = vertexColor().rgb.mul(sample.r.mul(0.6).add(0.55))
    // Coverage rides in the colour's alpha: three's shadow pass multiplies by `colorNode.a` and
    // keeps `alphaTest`, so cards cast their cutout rather than square shadows.
    material.colorNode = vec4(albedo, coverage)
    // Card normals lean toward the outside of their crown and must not flip on back faces.
    const normal = normalize(attribute<'vec3'>('normal'))
    // Each needle and leaf is a small dome in the atlas: its screen-space slope tilts the normal
    // (surface gradient, as the terrain's detail relief), so a near spray shades as rounded
    // shoots rather than a flat card. Mip levels flatten the relief with distance on their own.
    const base = transformNormalToView(normal).normalize()
    const relief = sample.g.mul(RELIEF_METRES)
    const dpdx = positionView.dFdx(),
      dpdy = positionView.dFdy()
    const r1 = dpdy.cross(base),
      r2 = base.cross(dpdx)
    const det = dpdx.dot(r1)
    const gradient = det.sign().mul(relief.dFdx().mul(r1).add(relief.dFdy().mul(r2)))
    material.normalNode = det.abs().mul(base).sub(gradient).normalize()
    const toEye = normalize(cameraPosition.sub(positionWorld))
    const facing = abs(dot(normal, toEye)).oneMinus()
    // Sky-light rim and back-light translucency, strongest at the crown rim.
    const rim = pow(facing, 3).mul(0.2)
    const back = pow(saturate(dot(this.sunDirection.negate(), toEye)), 4)
      .mul(0.4)
      .mul(facing.mul(0.6).add(0.4))
    // Light through a leaf comes out a saturated yellow-green: chlorophyll passes green and
    // some red and absorbs blue, so back-lit crown rims glow rather than wash grey.
    const transmitted = albedo.mul(vec3(1, 1.15, 0.45))
    material.emissiveNode = albedo
      .mul(this.ambient.mul(rim))
      .add(transmitted.mul(this.sunColour.mul(back)))
    return material
  }

  private undergrowthMaterial() {
    // A sward hides most of its blades from the sky behind its neighbours: at grazing view a
    // full sky reflection washed the bank blue-grey.
    const material = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.35,
      side: DoubleSide,
    })
    material.positionNode = positionLocal.add(this.sway())
    const normal = normalize(attribute<'vec3'>('normal'))
    material.normalNode = transformNormalToView(normal)
    const toEye = normalize(cameraPosition.sub(positionWorld))
    // Grass transmission (Voxen): sun through thin blades when looking toward the light.
    const into = saturate(dot(this.sunDirection.negate(), toEye))
    // Only the thin, light upper blade passes much light; a whole bank glowing reads as straw.
    material.emissiveNode = vertexColor().rgb.mul(this.sunColour).mul(pow(into, 6).mul(0.05))
    return material
  }

  /** `direction` is the world XZ wind direction; reduced motion freezes `elapsed`. */
  update(
    elapsed: number,
    direction: readonly [number, number],
    speed: number,
    light: LightingState,
  ) {
    this.time.value = elapsed
    this.wind.value.set(direction[0], direction[1])
    this.strength.value = Math.min(1.2, Math.max(0, speed) / FULL_LEAN_SPEED)
    this.sunDirection.value.copy(light.direction)
    this.sunColour.value.copy(light.color).multiplyScalar(light.intensity)
    this.ambient.value.copy(light.ambient)
  }

  dispose() {
    for (const mesh of this.meshes) mesh.removeFromParent()
    for (const item of this.disposables) item.dispose()
    this.meshes.length = 0
    this.pointerLight.clear()
  }
}

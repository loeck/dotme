import {
  abs,
  attribute,
  cameraPosition,
  dFdx,
  dFdy,
  dot,
  float,
  log2,
  max,
  min,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  sin,
  texture,
  transformNormalToView,
  uniform,
  uv,
  vec2,
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
import type { MeshData } from './vegetation-meshes'
import type { PreparedVegetation } from './vegetation-placement'

/** Shadow casters live on this layer; see the moon's shadow camera. */
const SHADOW_LAYER = 5
/** Foreground undergrowth: only the main camera enables this layer, so the water reflection,
 * the environment probe and the shadow pass never draw it. */
export const UNDERGROWTH_LAYER = 7
/** Wind speed (m/s) at which vegetation reaches its full lean. */
const FULL_LEAN_SPEED = 9
/** Fastest flutter, about 1.1 Hz. */
const MAX_FLUTTER_OMEGA = 7

/**
 * Last Signal's vegetation as three draws: voxel wood, foliage clump cards and procedural
 * undergrowth. Sway follows Voxen's ADR 0110 (a height-squared shear, a rest lean and three
 * buffeting sines at 1.2/√H Hz); cards and blades add a light flutter.
 */
export class Vegetation {
  readonly meshes: Mesh[] = []
  private readonly time = uniform(0)
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
    atlas.generateMipmaps = true
    atlas.minFilter = LinearMipmapLinearFilter
    atlas.magFilter = LinearFilter
    atlas.needsUpdate = true
    this.disposables.push(atlas)

    this.add(parent, 'wood', prepared.wood, this.woodMaterial(), true, false)
    this.add(
      parent,
      'foliage',
      prepared.foliage,
      this.foliageMaterial(atlas, prepared),
      true,
      false,
    )
    this.add(parent, 'undergrowth', prepared.undergrowth, this.undergrowthMaterial(), false, true)
  }

  private add(
    parent: Object3D,
    name: string,
    data: MeshData,
    material: MeshStandardNodeMaterial,
    castShadow: boolean,
    mainViewOnly: boolean,
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
    return direction.mul(lean.mul(bend).add(shiver)).add(vec3(0, shiver.mul(0.5), 0))
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

  private foliageMaterial(atlas: DataTexture, prepared: PreparedVegetation) {
    const material = new MeshStandardNodeMaterial({
      roughness: 0.85,
      metalness: 0,
      side: DoubleSide,
    })
    material.positionNode = positionLocal.add(this.sway())
    const sample = texture(atlas, uv())
    // Mip coverage compensation keeps distant crowns from thinning as alpha averages out.
    const texel = uv().mul(vec2(prepared.atlas.width, prepared.atlas.height))
    const lod = max(log2(max(dFdx(texel).length(), dFdy(texel).length())), 0)
    const coverage = saturate(sample.a.mul(lod.mul(0.3).add(1)))
    material.alphaTest = 0.5
    const albedo = vertexColor().rgb.mul(sample.r.mul(1.35).add(0.15))
    // Coverage rides in the colour's alpha: three's shadow pass multiplies by `colorNode.a` and
    // keeps `alphaTest`, so cards cast their cutout rather than square shadows.
    material.colorNode = vec4(albedo, coverage)
    // Card normals lean 90% toward the clump's open direction and must not flip on back faces.
    const normal = normalize(attribute<'vec3'>('normal'))
    material.normalNode = transformNormalToView(normal)
    const toEye = normalize(cameraPosition.sub(positionWorld))
    const facing = abs(dot(normal, toEye)).oneMinus()
    // Last Signal: sky-light rim and back-light translucency strongest at the crown rim.
    const rim = pow(facing, 3).mul(0.35)
    const back = pow(saturate(dot(this.sunDirection.negate(), toEye)), 4)
      .mul(0.4)
      .mul(facing.mul(0.6).add(0.4))
    material.emissiveNode = albedo.mul(this.ambient.mul(rim).add(this.sunColour.mul(back)))
    return material
  }

  private undergrowthMaterial() {
    const material = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.8,
      metalness: 0,
      side: DoubleSide,
    })
    material.positionNode = positionLocal.add(this.sway())
    const normal = normalize(attribute<'vec3'>('normal'))
    material.normalNode = transformNormalToView(normal)
    const toEye = normalize(cameraPosition.sub(positionWorld))
    // Grass transmission (Voxen): sun through thin blades when looking toward the light.
    const into = saturate(dot(this.sunDirection.negate(), toEye))
    material.emissiveNode = vertexColor().rgb.mul(this.sunColour).mul(pow(into, 4).mul(0.12))
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
  }
}

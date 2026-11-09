import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu'
import type {
  Camera,
  DirectionalLight,
  Group,
  Object3D,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu'

import { LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import { FISH_LAYER } from './lake-fish'
import type { LakeReflector } from './lake-water'
import type { LightingState } from './lighting'
import type { ResourceScope } from './resource-scope'
import type { createSkyMaterial } from './sky-material'
import { SPLASH_IMPACT_LAYER } from './splash-impacts'
import { stableShadowFilter } from './stable-shadow'
import type { SubmergedScene } from './submerged-scene'
import type { TerrainSkyFill } from './terrain-detail'
import { createBoulderMaterial, createTerrainMaterial } from './terrain-material'
import type { TerrainTextures } from './terrain-textures'
import type { WaterSimulation } from './water-simulation'
import type { TerrainPart } from './world-data'

/**
 * The sun and moon's directional light: one wide shadow map over the whole basin, refreshed
 * only when the light moves (the casters are static terrain on layer 5).
 */
export function configureSkyLight(
  moon: DirectionalLight,
  lowPower: boolean,
  resources: ResourceScope,
) {
  moon.position.set(-35, 48, -48)
  moon.target.position.set(0, 0, -28)
  moon.castShadow = true
  moon.shadow.autoUpdate = false
  resources.own(moon.shadow)
  moon.shadow.camera.layers.set(5)
  moon.shadow.mapSize.setScalar(lowPower ? 1024 : 2048)
  Object.assign(moon.shadow.camera, {
    left: -260,
    right: 260,
    top: 260,
    bottom: -260,
    near: 0.5,
    far: 640,
  })
  moon.shadow.camera.updateProjectionMatrix()
  moon.shadow.normalBias = 0.12
  moon.shadow.bias = -0.00015
  // Anchored to the shadow map, so edges hold still while the view or the light moves.
  Object.assign(moon.shadow, {
    filterNode: stableShadowFilter(moon.shadow.mapSize.x, lowPower),
  })
}

export type LakeMount = Readonly<{
  renderer: WebGPURenderer
  camera: Camera
  skyMaterial: ReturnType<typeof createSkyMaterial>
  simulation: WaterSimulation
  submerged: SubmergedScene
  lowPower: boolean
  /** The mirror's camera layers; see the engine's `setReflectionLayers`. */
  setReflectionLayers: (camera: Camera) => void
}>

/**
 * Places the lake surface at the water level as a static mesh, sets up its mirror (layers,
 * filtering, the sky's reflection capture flag) and binds the wave solver and the lakebed
 * capture beneath it.
 */
export function mountLake(water: LakeReflector, mount: LakeMount) {
  const { renderer, camera, skyMaterial, simulation, submerged } = mount
  const reflectedCamera = water.getReflectionCamera(camera)
  mount.setReflectionLayers(reflectedCamera)
  const reflection = water.getRenderTarget(reflectedCamera).texture
  reflection.anisotropy = Math.min(mount.lowPower ? 4 : 8, renderer.getMaxAnisotropy())
  reflection.name = 'Lake reflection'
  skyMaterial.uniforms.uReflectionCapture.onObjectUpdate(({ camera: viewer }) =>
    viewer === reflectedCamera ? 1 : 0,
  )
  const uniforms = water.material.uniforms
  uniforms.uState.value = simulation.texture
  uniforms.uMask.value = simulation.mask
  uniforms.uCell.value = LAKE_BOUNDS.size / simulation.resolution
  uniforms.uBedColor.value = submerged.target.texture
  const bedDepth = submerged.target.depthTexture
  if (!bedDepth) throw new Error('Missing lake depth texture')
  uniforms.uBedDepth.value = bedDepth
  uniforms.uBedAtlas.value = submerged.atlasLayout
  uniforms.uFishInverseViewProjection.value = submerged.fishInverseViewProjection
  uniforms.uBedHeight.value = submerged.depthField
  uniforms.uBedFieldLayout.value = submerged.fieldLayout
}

/** After the detail layer has hooked the surface: the static transform and shadow receiving. */
export function placeLake(water: LakeReflector) {
  water.rotation.x = -Math.PI / 2
  water.position.y = WATER_LEVEL
  water.updateMatrixWorld(true)
  water.matrixAutoUpdate = water.matrixWorldAutoUpdate = false
  water.receiveShadow = true
}

export type TerrainHost = Readonly<{
  resources: ResourceScope
  /** Objects the engine removes from the scene on dispose. */
  objects: Object3D[]
  /** Receives the lit terrain and boulder meshes. */
  terrainGroup: Group
  /** Receives their depth-only casters on the shadow layer (5). */
  shadowGroup: Group
}>

/**
 * The terrain and the boulders: one static mesh and material each, wrapping the worker's
 * buffers, plus depth-only shadow casters sharing their geometry.
 */
export function buildTerrainMeshes(
  terrain: TerrainPart['terrain'],
  sky: TerrainSkyFill,
  textures: TerrainTextures | undefined,
  host: TerrainHost,
) {
  const { resources, objects, terrainGroup, shadowGroup } = host
  const meshes = [
    { data: terrain.surface, material: createTerrainMaterial(sky, textures) },
    { data: terrain.boulders, material: createBoulderMaterial(sky, textures) },
  ]
  for (const { data, material } of meshes) {
    resources.own(material)
    if (!data.indices.length) continue
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3, true))
    geometry.setAttribute('surface', new BufferAttribute(data.surface, 4, true))
    geometry.setIndex(new BufferAttribute(data.indices, 1))
    geometry.computeBoundingSphere()
    resources.own(geometry)
    const mesh = new Mesh(geometry, material)
    mesh.receiveShadow = true
    mesh.updateMatrixWorld(true)
    mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false
    terrainGroup.add(mesh)
    objects.push(mesh)
  }
  const casterMaterial = resources.own(new MeshBasicNodeMaterial())
  for (const source of terrainGroup.children) {
    if (!(source instanceof Mesh)) continue
    const mesh = new Mesh(source.geometry, casterMaterial)
    mesh.castShadow = true
    mesh.layers.set(5)
    mesh.updateMatrixWorld(true)
    mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false
    shadowGroup.add(mesh)
    objects.push(mesh)
  }
}

/**
 * Lights also reach the lakebed capture's layers (1 and the fish), and the splash impacts; the
 * lit materials returned are the ones the cloud shadows and pointer light must reach.
 */
export function prepareLitScene(scene: Scene) {
  scene.traverse((object) => {
    if ('isLight' in object) {
      object.layers.enable(1)
      object.layers.enable(FISH_LAYER)
      object.layers.enable(SPLASH_IMPACT_LAYER)
    }
  })
  const lit = new Set<MeshStandardNodeMaterial>()
  scene.traverse((object) => {
    if (object instanceof Mesh && object.material instanceof MeshStandardNodeMaterial)
      lit.add(object.material)
  })
  return lit
}

/** The lake surface's per-frame light: the sun or moon, the night and the direct sun's glint. */
export function lightLake(
  water: LakeReflector,
  light: LightingState,
  diffuse: number,
  rain: number,
) {
  const uniforms = water.material.uniforms
  uniforms.uWaterScatter.value.copy(light.waterScatter)
  uniforms.uLightDirection.value.copy(light.direction)
  uniforms.uLightColor.value.copy(light.color).multiplyScalar(light.intensity)
  uniforms.uNight.value = 1 - light.daylight
  uniforms.uDirectSun.value = Math.max(0, (diffuse - 0.5) / 0.5) * (1 - 0.5 * rain)
}

/**
 * The contact point stays under the cursor while the camera eases; only the optical reveal
 * (z) trails off, since smoothing x/z makes the surface feel detached.
 */
export function pointLake(
  water: LakeReflector,
  target: Vector3,
  strength: number,
  dt: number,
  reducedMotion: boolean,
) {
  const pointer = water.material.uniforms.uPointer.value
  pointer.x = target.x
  pointer.y = target.y
  pointer.z += (target.z - pointer.z) * (reducedMotion ? 1 : 1 - Math.exp(-dt * 8))
  if (strength === 0) pointer.z = 0
}

import { Mesh, Scene, SphereGeometry } from 'three/webgpu'
import type { PerspectiveCamera } from 'three/webgpu'

import type { LandscapeState } from './landscape-state'
import type { ResourceScope } from './resource-scope'
import type { SkyAtmosphere } from './sky-atmosphere'
import { createSkyMaterial } from './sky-material'
import { ShootingStars } from './stars'
import type { VolumetricClouds } from './volumetric-clouds'

/**
 * The sky dome: one material drawn in the scene and, alone in its own scene, for the lake's
 * sky reflection; it carries the stars and the shooting stars a wish or the night brings.
 */
export class SkyDome {
  readonly stars: ShootingStars
  readonly material: ReturnType<typeof createSkyMaterial>
  readonly mesh: Mesh<SphereGeometry, ReturnType<typeof createSkyMaterial>>
  /** The sky dome alone, captured every frame for the lake's sky reflection. */
  readonly reflected = new Scene()
  private starTime = 0

  constructor(
    seed: number,
    mobile: boolean,
    clouds: VolumetricClouds,
    atmosphere: SkyAtmosphere,
    scene: Scene,
    resources: ResourceScope,
  ) {
    this.stars = new ShootingStars(seed)
    this.material = resources.own(createSkyMaterial(seed, mobile, clouds, atmosphere))
    const geometry = new SphereGeometry(260, 32, 16)
    this.mesh = new Mesh(geometry, this.material)
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
    const reflected = new Mesh(geometry, this.material)
    reflected.frustumCulled = false
    this.reflected.add(reflected)
    resources.own(geometry)
  }

  /** The star field's clock and the shooting stars, stopped under reduced motion. */
  advanceStars(
    activeDelta: number,
    sunHeight: number,
    covered: boolean,
    state: Readonly<LandscapeState>,
    camera: PerspectiveCamera,
  ) {
    if (!state.reducedMotion) this.starTime += activeDelta
    this.stars.advance(activeDelta, sunHeight, covered, state.reducedMotion, camera)
    const uniforms = this.material.uniforms
    uniforms.uStarTime.value = this.starTime
    uniforms.uMeteorAge.value = this.stars.age
    uniforms.uMeteorStart.value.copy(this.stars.start)
    uniforms.uMeteorEnd.value.copy(this.stars.end)
  }
}

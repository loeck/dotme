import { attribute, cos, float, positionLocal, sin, uniform, vec3 } from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Vector2,
} from 'three/webgpu'
import type { Scene } from 'three/webgpu'

import type { PreparedVegetation, VegetationLayer } from './vegetation-placement'

/** Shadow casters live on this layer; see the moon's shadow camera. */
const SHADOW_LAYER = 5
/** Foreground undergrowth: only the main camera enables this layer, so the water reflection,
 * the environment probe and the shadow pass never draw it. */
export const UNDERGROWTH_LAYER = 7
/** Wind speed (m/s) at which vegetation reaches its full lean. */
const FULL_LEAN_SPEED = 9

/**
 * Instanced micro-voxel vegetation. Sway follows Voxen's ADR 0110: one shear per instance,
 * growing with the square of height, a rest lean with the wind plus three buffeting sines
 * (rates 0.53, 0.97, 1.61; weights 0.5, 0.3, 0.2) at 1.2/√H Hz.
 */
export class Vegetation {
  readonly meshes: InstancedMesh[] = []
  private readonly time = uniform(0)
  private readonly wind = uniform(new Vector2(1, 0))
  private readonly strength = uniform(0)
  private readonly disposables: Array<{ dispose(): void }> = []

  constructor(scene: Scene, prepared: PreparedVegetation) {
    const matrix = new Matrix4()
    for (const layer of prepared.layers) {
      const geometry = this.geometry(layer)
      const material = this.material(layer)
      const count = layer.motion.length / 2
      const mesh = new InstancedMesh(geometry, material, count)
      for (let index = 0; index < count; index++) {
        matrix.fromArray(layer.matrices, index * 16)
        mesh.setMatrixAt(index, matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.name = `Vegetation ${layer.name}`
      mesh.castShadow = layer.castShadow
      if (layer.castShadow) mesh.layers.enable(SHADOW_LAYER)
      if (layer.mainViewOnly) mesh.layers.set(UNDERGROWTH_LAYER)
      // Bounds over every instance, padded for sway, let probe faces and views skip a layer.
      mesh.computeBoundingSphere()
      if (mesh.boundingSphere)
        mesh.boundingSphere.radius += layer.sway * layer.geometry.height * 1.5
      scene.add(mesh)
      this.meshes.push(mesh)
      this.disposables.push(geometry, material, mesh)
    }
  }

  private geometry(layer: VegetationLayer) {
    const geometry = new BufferGeometry()
    const { positions, normals, colors, bend, indices } = layer.geometry
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(normals, 3, true))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    geometry.setAttribute('bend', new BufferAttribute(bend, 1))
    geometry.setAttribute('motion', new InstancedBufferAttribute(layer.motion, 2))
    geometry.setIndex(new BufferAttribute(indices, 1))
    geometry.computeBoundingSphere()
    return geometry
  }

  private material(layer: VegetationLayer) {
    const material = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
    })
    // Yaw and sway phase per instance, owned by the geometry so its disposal frees them.
    const motion = attribute<'vec2'>('motion')
    const yaw = motion.x,
      phase = motion.y
    const height = Math.max(layer.geometry.height, 0.05)
    const omega = (2 * Math.PI * 1.2) / Math.sqrt(height)
    const t = this.time.mul(omega)
    const buffet = sin(t.mul(0.53).add(phase))
      .mul(0.5)
      .add(sin(t.mul(0.97).add(phase.mul(1.7))).mul(0.3))
      .add(sin(t.mul(1.61).add(phase.mul(2.3))).mul(0.2))
    const lean = this.strength.mul(this.strength.mul(0.6).add(buffet.mul(0.4).add(0.1)))
    const displacement = lean.mul(layer.sway * height).mul(attribute<'float'>('bend'))
    // Wind is a world direction; instances are yawed, so rotate it into model space.
    const c = cos(yaw),
      s = sin(yaw)
    const local = vec3(
      c.mul(this.wind.x).sub(s.mul(this.wind.y)),
      float(0),
      s.mul(this.wind.x).add(c.mul(this.wind.y)),
    )
    material.positionNode = positionLocal.add(local.mul(displacement))
    return material
  }

  /** `direction` is the world XZ wind direction; reduced motion freezes `elapsed`. */
  update(elapsed: number, direction: readonly [number, number], speed: number) {
    this.time.value = elapsed
    this.wind.value.set(direction[0], direction[1])
    this.strength.value = Math.min(1.2, Math.max(0, speed) / FULL_LEAN_SPEED)
  }

  dispose() {
    for (const mesh of this.meshes) mesh.removeFromParent()
    for (const item of this.disposables) item.dispose()
    this.meshes.length = 0
  }
}

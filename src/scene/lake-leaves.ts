import {
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three'
import type { IUniform, Scene } from 'three'

import type { LakeBed } from './lake-bed'
import { WATER_LEVEL } from './lake-bed'
import { LeafDrift } from './leaf-drift'
import { WATER_FIELD_GLSL } from './water-surface'
import type { WindState } from './wind'

export class LakeLeaves {
  readonly drift: LeafDrift
  readonly mesh: InstancedMesh<BufferGeometry, MeshStandardMaterial>
  private readonly transform = new Object3D()
  private readonly uniforms: Record<string, IUniform> = {}

  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean, frozen: boolean) {
    this.drift = new LeafDrift(bed, seed, mobile, frozen)
    const geometry = new BufferGeometry()
    // Faceted thin blade, a raised central vein and six angular edges.
    const outline = [
      [0, -1],
      [-0.48, -0.35],
      [-0.4, 0.4],
      [0, 1],
      [0.4, 0.4],
      [0.48, -0.35],
    ]
    const positions: number[] = []
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!,
        b = outline[(i + 1) % outline.length]!
      positions.push(0, 0.004, 0, a[0]!, 0, a[1]!, b[0]!, 0, b[1]!)
    }
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.computeVertexNormals()
    const material = new MeshStandardMaterial({
      roughness: 0.88,
      side: DoubleSide,
      forceSinglePass: true,
    })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = `${WATER_FIELD_GLSL}\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vec3 leafWorld = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        // Every blade vertex shares the actual rendered water height. A small lift
        // covers triangulation error while preserving the local wave inclination.
        transformed.y += (heightAt(leafWorld.xz, 0.0) + 0.018) / length(instanceMatrix[1].xyz);
      `,
      )
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>
        normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))) * (gl_FrontFacing ? 1.0 : -1.0);
      `,
      )
    }
    material.customProgramCacheKey = () => 'lake-leaves-water-field-v1'
    this.mesh = new InstancedMesh(geometry, material, this.drift.leaves.length)
    this.mesh.name = 'lake-leaves'
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    const colors = [0x777a3b, 0xa88b46, 0x73553b]
    this.drift.leaves.forEach((l, i) => this.mesh.setColorAt(i, new Color(colors[l.variant]!)))
    scene.add(this.mesh)
    this.writeInstances()
  }

  setWaterSurface(uniforms: Record<string, IUniform>) {
    for (const name of [
      'uTime',
      'uState',
      'uMask',
      'uCell',
      'uWindRotation',
      'uWindRotationVelocity',
      'uWindResponse',
    ])
      this.uniforms[name] = uniforms[name]!
  }

  private writeInstances() {
    this.drift.leaves.forEach((leaf, i) => {
      this.transform.position.set(leaf.x, WATER_LEVEL, leaf.z)
      this.transform.rotation.set(0, leaf.angle, 0)
      this.transform.scale.set(leaf.size * [1, 0.8, 1.2][leaf.variant]!, 1, leaf.size)
      this.transform.updateMatrix()
      this.mesh.setMatrixAt(i, this.transform.matrix)
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }
  update(dt: number, wind: WindState) {
    this.drift.advance(dt, wind)
    this.writeInstances()
  }
  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}

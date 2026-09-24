import {
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three'
import type { IUniform, Scene } from 'three'

import type { LakeBed } from './lake-bed'
import { WATER_LEVEL } from './lake-bed'
import { LeafDrift } from './leaf-drift'
import {
  createLeafGeometry,
  LEAF_SURFACE_GLSL,
  LEAF_COLOR_GLSL,
  LEAF_NORMAL_GLSL,
} from './leaf-surface'
import { WATER_FIELD_GLSL } from './water-surface'
import type { WindState } from './wind'

export class LakeLeaves {
  readonly drift: LeafDrift
  readonly mesh: InstancedMesh<BufferGeometry, MeshStandardMaterial>
  private readonly transform = new Object3D()
  private readonly uniforms: Record<string, IUniform> = {}

  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean, frozen: boolean) {
    this.drift = new LeafDrift(bed, seed, mobile, frozen)
    const geometry = createLeafGeometry()
    geometry.setAttribute(
      'leafTraits',
      new InstancedBufferAttribute(
        new Float32Array(this.drift.leaves.flatMap((leaf) => [leaf.variant, leaf.phase])),
        2,
      ),
    )
    const material = new MeshStandardMaterial({
      roughness: 0.43,
      side: DoubleSide,
      forceSinglePass: true,
    })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = `${WATER_FIELD_GLSL}
        attribute vec2 leafTraits;
        varying vec2 vLeafUv;
        varying vec2 vLeafTraits;
        ${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vLeafUv = uv;
        vLeafTraits = leafTraits;
        // Three related broadleaf silhouettes, with individual curl and lobing.
        float lobed = step(1.5, leafTraits.x);
        transformed.x *= 1.0 + lobed * 0.18 * sin(uv.y * 19.0);
        transformed.y *= 0.75 + 0.35 * sin(leafTraits.y);
        vec3 leafWorld = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        // Every blade vertex shares the actual rendered water height. A small lift
        // covers triangulation error while preserving the local wave inclination.
        transformed.y += (heightAt(leafWorld.xz, 0.0) + 0.018) / length(instanceMatrix[1].xyz);
      `,
      )
      shader.fragmentShader = `${LEAF_SURFACE_GLSL}\n${shader.fragmentShader}`
        .replace('#include <color_fragment>', `#include <color_fragment>\n${LEAF_COLOR_GLSL}`)
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>\n${LEAF_NORMAL_GLSL}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + dryEdge * 0.18 + mottling * 0.08 - veins * 0.06, 0.28, 0.72);`,
        )
    }
    material.customProgramCacheKey = () => 'lake-leaves-veined-water-field-v2'
    this.mesh = new InstancedMesh(geometry, material, this.drift.leaves.length)
    this.mesh.name = 'lake-leaves'
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    const colors = [0x8d9848, 0xc4a04c, 0xa46c3d]
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
      this.transform.scale.set(leaf.size * [1.1, 0.88, 1.18][leaf.variant]!, 1, leaf.size)
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

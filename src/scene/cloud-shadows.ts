import {
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
} from 'three'
import type { IUniform, MeshStandardMaterial, WebGLRenderer } from 'three'

import { CLOUD_DENSITY_GLSL } from './cloud-density'

// Fixed world coverage, independent of every rendering camera. The scene is below
// the cloud base; projection onto y=0 identifies an entire moonward light ray.
export const CLOUD_SHADOW_BOUNDS = { minX: -256, minZ: -376, size: 512 } as const

export const CLOUD_SHADOW_GLSL = `
uniform sampler2D uCloudShadowAtlas;
uniform float uCloudShadowPreviousOffset;
uniform vec3 uCloudShadowPreviousDirection;
uniform vec3 uCloudShadowNextDirection;
uniform float uCloudShadowBlend;
uniform float uCloudShadowStrength;
float cloudTransmission(float offset, vec3 direction, vec3 world) {
  vec2 ground = world.xz - world.y * direction.xz / max(direction.y, 0.1);
  vec2 uv = (ground - vec2(${CLOUD_SHADOW_BOUNDS.minX.toFixed(1)}, ${CLOUD_SHADOW_BOUNDS.minZ.toFixed(1)})) / ${CLOUD_SHADOW_BOUNDS.size.toFixed(1)};
  float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  // Clamp within each 256-pixel tile so linear filtering never crosses timestamps.
  uv = clamp(uv, vec2(0.5 / 256.0), vec2(1.0 - 0.5 / 256.0));
  uv.x = uv.x * 0.5 + offset;
  return mix(1.0, texture2D(uCloudShadowAtlas, uv).r, smoothstep(0.0, 0.06, edge));
}
float cloudShadow(vec3 world) {
  float transmission = mix(
    cloudTransmission(uCloudShadowPreviousOffset, uCloudShadowPreviousDirection, world),
    cloudTransmission(0.5 - uCloudShadowPreviousOffset, uCloudShadowNextDirection, world), uCloudShadowBlend);
  return mix(1.0, transmission, uCloudShadowStrength);
}
`

/** Beer–Lambert shadow maps, captured on the exact same clock as the visible sky. */
export class CloudShadows {
  // Both capture times share one sampler, leaving room for seven lamp shadow maps
  // in the water shader on devices with the WebGL2 minimum of 16 fragment samplers.
  private readonly atlas = new WebGLRenderTarget(512, 256, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  private readonly directions = [new Vector3(), new Vector3()]
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: ShaderMaterial
  readonly uniforms = {
    uCloudShadowAtlas: { value: this.atlas.texture },
    uCloudShadowPreviousOffset: { value: 0 },
    uCloudShadowPreviousDirection: { value: this.directions[0]! },
    uCloudShadowNextDirection: { value: this.directions[1]! },
    uCloudShadowBlend: { value: 0 },
    uCloudShadowStrength: { value: 0.95 },
  }

  constructor(
    private readonly renderer: WebGLRenderer,
    volumeUniforms: Record<string, IUniform>,
    blend: IUniform<number>,
  ) {
    this.uniforms.uCloudShadowBlend = blend
    this.atlas.texture.name = 'Moonlight cloud transmission atlas'
    this.atlas.scissorTest = true
    this.material = new ShaderMaterial({
      uniforms: volumeUniforms,
      defines: { SHADOW_STEPS: 32 },
      vertexShader:
        'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        ${CLOUD_DENSITY_GLSL}
        uniform vec3 uMoonDirection;
        varying vec2 vUv;
        void main() {
          vec3 ground = vec3(${CLOUD_SHADOW_BOUNDS.minX.toFixed(1)} + vUv.x * ${CLOUD_SHADOW_BOUNDS.size.toFixed(1)}, 0.0,
            ${CLOUD_SHADOW_BOUNDS.minZ.toFixed(1)} + vUv.y * ${CLOUD_SHADOW_BOUNDS.size.toFixed(1)});
          float stepLength = (CLOUD_TOP - CLOUD_BASE) / (uMoonDirection.y * float(SHADOW_STEPS));
          float entry = CLOUD_BASE / uMoonDirection.y;
          float opticalDepth = 0.0;
          for (int i = 0; i < SHADOW_STEPS; i++) {
            vec3 p = ground + uMoonDirection * (entry + (float(i) + 0.5) * stepLength);
            opticalDepth += density(p, true) * stepLength * CLOUD_EXTINCTION;
            if (opticalDepth > 5.0) break;
          }
          gl_FragColor = vec4(vec3(exp(-opticalDepth)), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.scene.add(new Mesh(this.geometry, this.material))
  }

  capture(index: number) {
    const previous = this.renderer.getRenderTarget()
    const face = this.renderer.getActiveCubeFace()
    const mip = this.renderer.getActiveMipmapLevel()
    try {
      this.directions[index]!.copy(this.material.uniforms.uMoonDirection!.value)
      this.atlas.viewport.set(index * 256, 0, 256, 256)
      this.atlas.scissor.copy(this.atlas.viewport)
      this.renderer.setRenderTarget(this.atlas)
      this.renderer.render(this.scene, this.camera)
    } finally {
      this.renderer.setRenderTarget(previous, face, mip)
    }
  }

  select(previous: number) {
    this.uniforms.uCloudShadowPreviousOffset.value = previous * 0.5
    this.uniforms.uCloudShadowPreviousDirection.value = this.directions[previous]!
    this.uniforms.uCloudShadowNextDirection.value = this.directions[1 - previous]!
  }

  /** Shade moonlight and approximate local sky visibility; preserve lamps and emission. */
  applyTo(material: MeshStandardMaterial) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader =
        'varying vec3 vCloudWorldPosition;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 cloudPosition = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            cloudPosition = batchingMatrix * cloudPosition;
          #endif
          #ifdef USE_INSTANCING
            cloudPosition = instanceMatrix * cloudPosition;
          #endif
          vCloudWorldPosition = (modelMatrix * cloudPosition).xyz;`,
        )
      shader.fragmentShader =
        `varying vec3 vCloudWorldPosition;\n${CLOUD_SHADOW_GLSL}\n` +
        shader.fragmentShader
          .replace(
            '#include <lights_fragment_begin>',
            'float cloudVisibility = cloudShadow(vCloudWorldPosition);\n' +
              ShaderChunk.lights_fragment_begin.replace(
                'getDirectionalLightInfo( directionalLight, directLight );',
                'getDirectionalLightInfo( directionalLight, directLight );\n directLight.color *= cloudVisibility;',
              ),
          )
          .replace(
            '#include <lights_fragment_end>',
            `// Local sky fill loses illumination beneath thick cloud cover.
          // Keep direct point lights and emission outside this approximation.
          float cloudFill = mix(0.35, 1.0, cloudVisibility);
          #if defined(RE_IndirectDiffuse)
            irradiance *= cloudFill;
            iblIrradiance *= cloudFill;
          #endif
          #if defined(RE_IndirectSpecular)
            radiance *= mix(0.65, 1.0, cloudVisibility);
          #endif
          #include <lights_fragment_end>`,
          )
    }
    material.customProgramCacheKey = () => 'moon-cloud-shadow-v1'
    material.needsUpdate = true
  }

  dispose() {
    this.atlas.dispose()
    this.material.dispose()
    this.geometry.dispose()
  }
}

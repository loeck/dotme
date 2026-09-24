import {
  Fn,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dFdx,
  dFdy,
  exp,
  sin,
  fwidth,
  float,
  max,
  min,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pmremTexture,
  reflector,
  reflect,
  refract,
  screenUV,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DataTexture,
  DoubleSide,
  Matrix4,
  Mesh,
  NodeMaterial,
  RGBAFormat,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import type { BufferGeometry, Camera, Node } from 'three/webgpu'

import { clipDepth } from './backend-nodes'
import { cloudShadow } from './cloud-shadows'
import type { CloudShadowUniforms } from './cloud-shadows'
import { pointerLightAt } from './pointer-light'
import type { PointerLightUniforms } from './pointer-light'
import { WATER_IOR, WaterLightingModel } from './water-lighting'
import { contactNoise } from './water-noise'
import { createWindNodes, fieldUvNode, rippleSlopeNode, windFieldNode } from './water-surface'

type LakeInputs = {
  wind: Omit<ReturnType<typeof createWindNodes>, 'uTime'>
  cloud: CloudShadowUniforms
  pointer: PointerLightUniforms
}

/** Uniform nodes are stable graph inputs; update their values, never replace them. */
export class LakeWaterMaterial extends NodeMaterial {
  readonly waterLighting = new WaterLightingModel()
  emissiveNode: Node<'vec3'> | null = null
  private readonly empty = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat)
  readonly uniforms = {
    ...createWindNodes(),
    uCell: uniform(0.16),
    uState: texture(this.empty),
    uMask: texture(this.empty),
    uRainSlopeMap: texture(this.empty),
    uRainResolution: uniform(new Vector2(1, 1)),
    uRainSlopesEnabled: uniform(0),
    uBedColor: texture(this.empty),
    uBedDepth: texture(this.empty),
    uBedHeight: texture(this.empty),
    uBedAtlas: uniform(new Vector4(1, 0.5, 1, 0.5)),
    uFishInverseViewProjection: uniform(new Matrix4()),
    uBedFieldLayout: uniform(new Vector4(0.5, 1 / 3, 1, 1)),
    uBedInverseViewProjection: uniform(new Matrix4()),
    uBedViewProjection: uniform(new Matrix4()),
    uBedTexel: uniform(new Vector2(1, 1)),
    uPointer: uniform(new Vector3()),
    uWaterScatter: uniform(new Color().setRGB(0.0022, 0.0043, 0.0065)),
    uWaterClarity: uniform(1),
    uWaterAgitation: uniform(0.2),
    uNight: uniform(0),
    uEnvironment: pmremTexture(this.empty),
    uPointerLightPosition: uniform(new Vector3()),
    uPointerLightSource: uniform(new Vector3()),
    uPointerLightStrength: uniform(0),
  }

  constructor() {
    super()
    this.side = DoubleSide
    this.depthWrite = true
    this.fog = false
    this.lights = true
    this.empty.needsUpdate = true
  }

  override setupLightingModel() {
    return this.waterLighting
  }

  override dispose() {
    super.dispose()
    this.uniforms.uEnvironment.dispose()
    this.empty.dispose()
  }
}

export class LakeReflector extends Mesh<BufferGeometry, LakeWaterMaterial> {
  readonly reflectorNode
  constructor(geometry: BufferGeometry, mobile: boolean, inputs?: LakeInputs) {
    const material = new LakeWaterMaterial()
    super(geometry, material)
    this.reflectorNode = reflector({
      target: this,
      resolutionScale: mobile ? 0.35 : 0.6,
      generateMipmaps: true,
      bounces: false,
      samples: 0,
    })
    // Environment reflection is composed explicitly with scenery coverage.
    // The water lighting model needs no second IBL or BRDF lookup sampler.
    material.envNode = vec3(0)
    const u = material.uniforms
    if (inputs) Object.assign(u, inputs.wind, inputs.pointer)
    const interactionHeight = (point: Node<'vec2'>) => {
      const coordinate = fieldUvNode(point)
      const inside = coordinate.x
        .greaterThanEqual(0)
        .and(coordinate.x.lessThanEqual(1))
        .and(coordinate.y.greaterThanEqual(0))
        .and(coordinate.y.lessThanEqual(1))
      return inside.select(u.uState.sample(coordinate).r, 0)
    }
    // The geometry's local z axis becomes world y after the lake rotation.
    const vertexWorld = vec2(positionLocal.x, positionLocal.y.negate())
    const vertexHeight = windFieldNode(vertexWorld, float(0), u).x.add(
      interactionHeight(vertexWorld),
    )
    material.positionNode = positionLocal.add(vec3(0, 0, vertexHeight))
    const p = positionWorld.xz
    const fieldUv = fieldUvNode(p)
    const flatP = cameraPosition.xz.add(
      p
        .sub(cameraPosition.xz)
        .mul(cameraPosition.y.add(0.035).div(max(0.001, cameraPosition.y.sub(positionWorld.y)))),
    )
    const footprint = max(dFdx(flatP).length(), dFdy(flatP).length())
    const halfTexel = u.uBedFieldLayout.zw.mul(0.5)
    const shoreDistanceAt = (coordinate: Node<'vec2'>) => {
      const start = vec2(0, u.uBedFieldLayout.y)
      return u.uBedHeight.sample(
        clamp(
          start.add(coordinate.mul(vec2(1, float(1).sub(start.y)))),
          start.add(halfTexel),
          vec2(1).sub(halfTexel),
        ),
      ).r
    }
    const shore = shoreDistanceAt(fieldUv)
    const shoreStep = vec2(u.uCell.div(160), 0)
    const shoreGradient = vec2(
      shoreDistanceAt(fieldUv.add(shoreStep)).sub(shoreDistanceAt(fieldUv.sub(shoreStep))),
      shoreDistanceAt(fieldUv.add(shoreStep.yx)).sub(shoreDistanceAt(fieldUv.sub(shoreStep.yx))),
    )
    const shoreNormal = shoreGradient.div(max(shoreGradient.length(), 0.0001))
    const stepSize = max(u.uCell, footprint.mul(0.5))
    const state = u.uState.sample(clamp(fieldUv, 0, 1))
    const field = windFieldNode(p, footprint, u)
    const wetHeight = (point: Node<'vec2'>) =>
      shoreDistanceAt(fieldUvNode(point)).lessThanEqual(0).select(state.x, interactionHeight(point))
    const rippleSlope = vec2(
      wetHeight(p.add(vec2(stepSize, 0))).sub(wetHeight(p.sub(vec2(stepSize, 0)))),
      wetHeight(p.add(vec2(0, stepSize))).sub(wetHeight(p.sub(vec2(0, stepSize)))),
    ).div(stepSize.mul(2))
    const rain = u.uRainSlopeMap.sample(screenUV).mul(u.uRainSlopesEnabled)
    const capillary = rippleSlopeNode(
      p,
      footprint,
      clamp(u.uWindResponse.y, 0.4, 1.6).mul(u.uWaterAgitation.mul(0.6).add(0.8)),
      u,
    )
    const incidentSlope = field.yz.add(rippleSlope).add(rain.xy).add(capillary)
    const slope = incidentSlope.sub(
      shoreNormal
        .mul(incidentSlope.dot(shoreNormal))
        .mul(float(1).sub(smoothstep(0, u.uCell.mul(2), max(0, shore)))),
    )
    const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()))
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(normal, 0)).xyz)
    const view = normalize(cameraPosition.sub(positionWorld))
    const fresnel = float(1)
      .sub(clamp(normal.dot(view), 0, 1))
      .pow(5)
      .mul(0.97963)
      .add(0.02037)
    const reveal = exp(p.sub(u.uPointer.xy).dot(p.sub(u.uPointer.xy)).div(-2.8)).mul(u.uPointer.z)
    const roughness = mix(
      mix(0.035, 0.085, u.uWaterAgitation).mul(mix(1, 0.7, u.uNight)),
      0.025,
      reveal,
    )
      .pow(2)
      .add(min(0.04, rain.z))
      .sqrt()
    const reflected = reflect(view.negate(), normal)
    const flatReflected = reflect(view.negate(), vec3(0, 1, 0))
    const reflectionMatrix = new Matrix4()
    const reflectionProjection = uniform(reflectionMatrix).onObjectUpdate(({ camera }) => {
      if (camera) {
        const virtualCamera = this.getReflectionCamera(camera)
        reflectionMatrix.multiplyMatrices(
          virtualCamera.projectionMatrix,
          virtualCamera.matrixWorldInverse,
        )
      }
      return reflectionMatrix
    })
    const rayDistance = mix(2, 8, float(1).sub(clamp(normal.dot(view), 0, 1)))
    const offset = reflected.sub(flatReflected).mul(rayDistance)
    const projectedReflection = reflectionProjection.mul(vec4(positionWorld.add(offset), 1))
    this.reflectorNode.uvNode = projectedReflection.xy
      .div(projectedReflection.w)
      .mul(0.5)
      .add(0.5)
      .flipY()
    const mirrorUv = projectedReflection.xy.div(projectedReflection.w).mul(0.5).add(0.5).flipY()
    const mirrorEdge = min(
      min(mirrorUv.x, mirrorUv.y),
      min(float(1).sub(mirrorUv.x), float(1).sub(mirrorUv.y)),
    )
    u.uEnvironment.uvNode = reflected
    // Let the surface roughness choose its reflection detail; an extra floor
    // smears the sky across otherwise resolved wave slopes.
    u.uEnvironment.levelNode = roughness
    const environment = u.uEnvironment
    const localReflection = this.reflectorNode
    const reflection = mix(
      environment,
      localReflection.rgb.add(environment.mul(float(1).sub(clamp(localReflection.a, 0, 1)))),
      smoothstep(0, 0.06, mirrorEdge),
    )
    const bedDepthAt = (coordinate: typeof fieldUv) =>
      u.uBedHeight.sample(
        clamp(coordinate.mul(u.uBedFieldLayout.xy), halfTexel, u.uBedFieldLayout.xy.sub(halfTexel)),
      ).r
    const direction = refract(view.negate(), normal, 1 / WATER_IOR)
    const candidate = Fn(() => {
      const point = positionWorld.toVar()
      const depth = bedDepthAt(fieldUv).toVar()
      for (let i = 0; i < 4; i++) {
        point.assign(
          positionWorld.add(
            direction.mul(
              min(
                18,
                max(0.02, depth.add(positionWorld.y).add(0.035)).div(
                  max(0.25, direction.y.negate()),
                ),
              ),
            ),
          ),
        )
        depth.assign(bedDepthAt(fieldUvNode(point.xz)))
      }
      return point
    })()
    const projected = u.uBedViewProjection.mul(vec4(candidate, 1))
    const projectedUv = projected.xy.div(projected.w).mul(0.5).add(0.5).flipY()
    const captureEdge = min(
      min(projectedUv.x, projectedUv.y),
      min(float(1).sub(projectedUv.x), float(1).sub(projectedUv.y)),
    )
    const bedUv = clamp(projectedUv, u.uBedTexel, vec2(1).sub(u.uBedTexel))
    const bottomDepth = u.uBedDepth.sample(bedUv.mul(u.uBedAtlas.xy)).r
    const bottomPoint = u.uBedInverseViewProjection.mul(
      vec4(bedUv.flipY().mul(2).sub(1), clipDepth(bottomDepth), 1),
    )
    const actualBottom = bottomPoint.xyz.div(bottomPoint.w)
    const valid = float(1)
      .sub(smoothstep(-0.06, -0.035, actualBottom.y))
      .mul(float(1).sub(smoothstep(0.5, 2, actualBottom.sub(candidate).length())))
      .mul(smoothstep(0, 0.045, captureEdge))
    const path = min(40, candidate.sub(positionWorld).length())
    const depth = bedDepthAt(fieldUvNode(candidate.xz))
    const nearShallow = float(1)
      .sub(smoothstep(2.8, 6, depth))
      .mul(float(1).sub(smoothstep(24, 48, cameraPosition.xz.sub(p).length())))
    const clarity = max(u.uWaterClarity.mul(nearShallow.mul(0.1).add(0.9)), reveal)
    const absorption = mix(vec3(0.48, 0.22, 0.14), vec3(0.3, 0.05, 0.028), clarity)
    const transmission = exp(absorption.mul(path).negate())
    const bedBlur = u.uBedTexel.mul(mix(1.1, 0.18, clarity))
    const bed = u.uBedColor
      .sample(bedUv.mul(u.uBedAtlas.xy))
      .rgb.mul(0.4)
      .add(
        u.uBedColor
          .sample(
            clamp(bedUv.add(bedBlur), u.uBedTexel, vec2(1).sub(u.uBedTexel)).mul(u.uBedAtlas.xy),
          )
          .rgb.mul(0.3),
      )
      .add(
        u.uBedColor
          .sample(
            clamp(bedUv.sub(bedBlur), u.uBedTexel, vec2(1).sub(u.uBedTexel)).mul(u.uBedAtlas.xy),
          )
          .rgb.mul(0.3),
      )
    const scatter = u.uWaterScatter.rgb
      .mul(
        inputs
          ? mix(mix(0.25, 0.8, u.uNight), 1, cloudShadow(positionWorld, inputs.cloud))
          : float(1),
      )
      .mul(mix(vec3(1.18, 1.12, 0.92), vec3(0.8, 1.08, 1.12), u.uWaterClarity))
    const shallow = float(1).sub(smoothstep(0.3, 3.2, depth))
    const litBed = bed
      .mul(exp(absorption.mul(depth).negate()))
      .mul(mix(vec3(1), vec3(0.34, 0.58, 0.8).mul(shallow.mul(0.9).add(0.1)), u.uNight))
    const transmitted = mix(
      scatter,
      litBed.mul(transmission).add(scatter.mul(vec3(1).sub(transmission))),
      valid,
    )
    const fishUv = clamp(screenUV.add(normal.xz.mul(0.0025)), 0.001, 0.999)
    const fishAtlasUv = vec2(0, u.uBedAtlas.y).add(fishUv.mul(u.uBedAtlas.zw))
    const fish = u.uBedColor.sample(fishAtlasUv)
    const fishDepth = u.uBedDepth.sample(fishAtlasUv).r
    const fishPoint = u.uFishInverseViewProjection.mul(
      vec4(fishUv.flipY().mul(2).sub(1), clipDepth(fishDepth), 1),
    )
    const fishPath = max(0, float(-0.035).sub(fishPoint.y.div(fishPoint.w)))
      .mul(WATER_IOR)
      .div(max(0.35, direction.y.negate()))
    const fishTransmission = exp(absorption.mul(fishPath).negate())
    const waterColumn = transmitted
      .mul(float(1).sub(fish.a))
      .add(fish.rgb.mul(fishTransmission))
      .add(scatter.mul(vec3(1).sub(fishTransmission)).mul(fish.a))
    const window = float(1)
      .sub(smoothstep(30, 85, cameraPosition.xz.sub(p).length()))
      .mul(u.uWaterClarity)
    const reflectance = mix(fresnel, min(fresnel, mix(0.14, 0.1, u.uNight)), window)
    const shorePixel = min(1, fwidth(shore)),
      distance = max(0, shore)
    const crest = smoothstep(-0.018, 0.04, field.x.add(state.x))
    const impact = smoothstep(0.008, 0.12, field.w.add(state.y).abs())
    const arrival = crest.mul(mix(0.65, 1, impact))
    const tangent = vec2(shoreNormal.y.negate(), shoreNormal.x)
    const anchor = p.sub(shoreNormal.mul(distance))
    const patches = contactNoise(anchor.mul(0.9).add(tangent.mul(u.uTime).mul(0.045)))
    const width = max(mix(0.32, 1.15, arrival), shorePixel.mul(1.45)).mul(mix(0.65, 1, patches))
    const contact = float(1).sub(
      smoothstep(width.mul(0.25), width.add(shorePixel.mul(0.5)), distance),
    )
    const flow = p
      .sub(shoreNormal.mul(u.uTime.mul(0.16).add(crest.mul(0.12))))
      .sub(tangent.mul(sin(u.uTime.mul(0.35).add(patches.mul(6)))).mul(0.09))
    const lace = contactNoise(flow.mul(3.2))
    const grain = mix(contactNoise(flow.mul(16)), 0.5, smoothstep(0.035, 0.18, footprint))
    const breakup = smoothstep(0.24, 0.67, lace.add(grain.mul(0.18)))
    const residual = mix(0.08, 0.6, smoothstep(0.32, 0.62, patches))
    const film = contact.mul(mix(residual, 0.9, arrival)).mul(mix(0.28, 1, breakup))
    const front = float(1).sub(
      smoothstep(
        shorePixel.mul(0.25).add(0.07),
        shorePixel.mul(0.6).add(0.19),
        distance.sub(width.mul(0.7)).abs(),
      ),
    )
    const fragments = front
      .mul(arrival)
      .mul(smoothstep(0.38, 0.7, lace))
      .mul(float(1).sub(smoothstep(1.2, 1.9, distance)))
    const foam = min(0.92, film.add(fragments.mul(0.5)).add(rain.a))
    material.waterLighting.foamNode = foam
    material.waterLighting.roughnessNode = roughness
    material.waterLighting.worldNormalNode = normal
    material.colorNode = vec3(0.84, 0.89, 0.87).mul(foam)
    material.emissiveNode = mix(
      waterColumn,
      reflection,
      mix(reflectance, min(reflectance, 0.16), reveal.mul(0.85)),
    )
      .mul(float(1).sub(foam))
      .add(
        pointerLightAt(positionWorld, normal, u)
          .mul(fresnel.mul(0.035).add(0.006))
          .mul(float(1).sub(foam.mul(0.65))),
      )
  }

  getReflectionCamera(camera: Camera) {
    return this.reflectorNode.reflector.getVirtualCamera(camera)
  }
  setReflectionScale(scale: number) {
    this.reflectorNode.reflector.resolutionScale = scale
  }
  getRenderTarget(camera: Camera) {
    return this.reflectorNode.reflector.getRenderTarget(camera)
  }
  override dispose() {
    super.dispose()
    this.reflectorNode.dispose()
    this.material.dispose()
  }
}

export function createLakeReflector(
  geometry: BufferGeometry,
  mobile: boolean,
  _filteredEnvironment = true,
  inputs?: LakeInputs,
) {
  return new LakeReflector(geometry, mobile, inputs)
}

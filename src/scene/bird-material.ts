import {
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  exp,
  faceDirection,
  float,
  mix,
  normalize,
  output,
  positionWorld,
  pow,
  saturate,
  sign,
  sin,
  smoothstep,
  specularColor,
  specularColorBlended,
  specularF90,
  step,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, DoubleSide, FogExp2, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu'
import type { Fog, Node, NodeBuilder } from 'three/webgpu'

import type { BirdPlumage } from './bird-species'
import type { LightingState } from './lighting'

/**
 * Share of the scene's haze the birds take. The scene's exponential fog is tuned for hills a
 * kilometre off; at 20–60 m it lifted a black crow a third of the way to the sky's colour, the
 * grey look birds must not have. Birds keep a little of it, so the farthest still recede.
 */
const BIRD_HAZE = 0.4

/**
 * Feathers are matte: a dielectric's full grazing reflectance (F90 = 1) turns a crow's thin,
 * edge-on wing into a pale streak against the sky. `sheen` is the reflectance at normal
 * incidence: a faint blue-purple on a crow's back.
 */
class FeatherMaterial extends MeshStandardNodeMaterial {
  readonly sheen = uniform(new Color(0.025, 0.025, 0.025))
  readonly hazeColour = uniform(new Color())
  readonly hazeDensity = uniform(0)

  override setupSpecular() {
    specularColor.assign(this.sheen)
    specularColorBlended.assign(this.sheen)
    specularF90.assign(0.12)
  }

  /** The scene's exponential haze, thinned to `BIRD_HAZE` (uniforms set from the scene fog). */
  override setupFog(_builder: NodeBuilder, outputNode: Node): Node {
    // As three's own fog does: the lit colour through the `output` property.
    output.assign(outputNode)
    const colour = output
    const depth = positionWorld.sub(cameraPosition).length().mul(this.hazeDensity)
    const haze = float(1).sub(exp(depth.mul(depth).negate()))
    return vec4(mix(colour.rgb, this.hazeColour, haze), colour.a)
  }
}

/**
 * The birds' material: lit by the scene's sun and sky like the leaves, two-sided, with the
 * plumage painted by region (`bird-geometry.ts`) from species uniforms, so changing species
 * never changes the program. The wings hinge in the vertex shader from per-bird pose
 * attributes; each bird carries its own frame (no instance matrix: the hinge works in the
 * bird's own space). Against the sun the thin wing feathers glow, pale ones most; a faint rim
 * keeps a dark bird's edge from melting into a dark wood.
 *
 * Per instance: `aAxisX`, `aAxisY`, `aAxisZ` (the bird's scaled frame; w: shoulder angle, wrist
 * angle, hand fold) and `aOrigin` (position; w: 2 for the alternate head + brightness).
 */
export class BirdMaterial {
  readonly material: FeatherMaterial
  private readonly colours = {
    mantle: uniform(new Color()),
    wing: uniform(new Color()),
    tip: uniform(new Color()),
    belly: uniform(new Color()),
    underwing: uniform(new Color()),
    head: uniform(new Color()),
    headAlt: uniform(new Color()),
    bill: uniform(new Color()),
    tail: uniform(new Color()),
  }
  private readonly tipStart = uniform(1)
  private readonly roughness = uniform(0.8)
  private readonly sunDirection = uniform(new Vector3(0, 1, 0))
  private readonly sunColour = uniform(new Color())
  private readonly skyColour = uniform(new Color())

  constructor() {
    const material = new FeatherMaterial({
      side: DoubleSide,
      metalness: 0,
      envMapIntensity: 0.35,
    })
    const axisX = attribute<'vec4'>('aAxisX'),
      axisY = attribute<'vec4'>('aAxisY'),
      axisZ = attribute<'vec4'>('aAxisZ'),
      origin = attribute<'vec4'>('aOrigin')
    const rest = attribute<'vec3'>('position')
    const wing = attribute<'vec4'>('aWing')
    const shoulder = axisX.w,
      wrist = shoulder.add(axisY.w),
      fold = axisZ.w
    // Arm about the shoulder, hand about the wrist; on the upstroke the hand tucks in and back.
    const arm = wing.x,
      hand = wing.y.mul(float(1).sub(fold.mul(0.45)))
    const side = sign(rest.x)
    const local = vec3(
      rest.x.add(
        side.mul(
          arm
            .mul(cos(shoulder).sub(1))
            .add(hand.mul(cos(wrist)))
            .sub(wing.y),
        ),
      ),
      rest.y.add(arm.mul(sin(shoulder))).add(hand.mul(sin(wrist))),
      rest.z.sub(wing.y.mul(fold).mul(0.6)),
    )
    material.positionNode = origin.xyz
      .add(axisX.xyz.mul(local.x))
      .add(axisY.xyz.mul(local.y))
      .add(axisZ.xyz.mul(local.z))
    // Panel normals follow the hinge; the body keeps its flat rest normals.
    const panel = mix(shoulder, wrist, step(1e-5, wing.y))
    const wingNormal = vec3(side.negate().mul(sin(panel)), cos(panel), 0)
    const restNormal = attribute<'vec3'>('normal')
    const normalLocal = mix(restNormal, wingNormal, wing.w)
    const worldNormal = varying(
      axisX.xyz
        .mul(normalLocal.x)
        .add(axisY.xyz.mul(normalLocal.y))
        .add(axisZ.xyz.mul(normalLocal.z)),
      'vBirdNormal',
    )
    const facing = normalize(worldNormal).mul(faceDirection)
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(facing, 0)).xyz)

    // Plumage: body from mantle to belly, the head and bill, the tail; the wing's upper side
    // darkens to the tip, its underside is paler. The front face of a wing is its upper side.
    const paint = attribute<'vec4'>('aPaint')
    const c = this.colours
    const alt = step(1.5, origin.w)
    const brightness = origin.w.sub(alt.mul(2))
    let body = mix(c.mantle, c.belly, paint.y)
    body = mix(body, mix(c.head, c.headAlt, alt), paint.x)
    body = mix(body, c.bill, paint.w)
    body = mix(body, c.tail, paint.z)
    const tipMask = smoothstep(this.tipStart, this.tipStart.add(0.08), wing.z)
    const upper = mix(mix(c.mantle, c.wing, smoothstep(0, 0.12, wing.x)), c.tip, tipMask)
    const under = mix(c.underwing, mix(c.tip, c.underwing, 0.3), tipMask)
    const wingColour = mix(under, upper, step(0, faceDirection))
    const albedo = mix(body, wingColour, wing.w).mul(brightness)
    material.colorNode = albedo
    material.roughnessNode = this.roughness

    const toEye = normalize(cameraPosition.sub(positionWorld))
    // Wing feathers against the sun: light through the vane, strongest looking into the sun
    // and when the lit side faces away.
    const into = pow(saturate(this.sunDirection.negate().dot(toEye)), 3)
    const through = float(0.3).add(saturate(facing.dot(this.sunDirection).negate()).mul(0.7))
    const transmitted = albedo
      .mul(this.sunColour)
      .mul(into.mul(through).mul(wing.w.mul(0.75).add(0.15)).mul(0.22))
    // A thin sky rim at grazing angles.
    const rim = pow(float(1).sub(abs(facing.dot(toEye))), 4)
      .mul(0.18)
      .mul(albedo)
      .mul(this.skyColour)
    // Light from the sky and the water below: a gull's white underside stays pale in shade.
    const fill = albedo.mul(this.skyColour).mul(saturate(facing.y.negate()).mul(0.5))
    material.emissiveNode = transmitted.add(rim).add(fill)
    this.material = material
  }

  /** Paints the species: uniform values only. */
  setPlumage(plumage: BirdPlumage, hood?: number) {
    const c = this.colours
    c.mantle.value.setHex(plumage.mantle)
    c.wing.value.setHex(plumage.wing)
    c.tip.value.setHex(plumage.tip)
    c.belly.value.setHex(plumage.belly)
    c.underwing.value.setHex(plumage.underwing)
    c.head.value.setHex(hood ?? plumage.head)
    c.headAlt.value.setHex(plumage.headAlt)
    c.bill.value.setHex(plumage.bill)
    c.tail.value.setHex(plumage.tail)
    this.tipStart.value = plumage.tipStart >= 1 ? 2 : plumage.tipStart
    this.roughness.value = plumage.roughness
    this.material.sheen.value.setRGB(...plumage.sheen)
  }

  /** Follows the scene's haze (an exponential fog), thinned for birds; none without one. */
  setHaze(fog: Fog | FogExp2 | null) {
    if (fog instanceof FogExp2) {
      this.material.hazeColour.value.copy(fog.color)
      this.material.hazeDensity.value = fog.density * BIRD_HAZE
    } else this.material.hazeDensity.value = 0
  }

  /** The key light and the sky's ambient for transmission and rim. */
  setLight(light: Readonly<LightingState>) {
    this.sunDirection.value.copy(light.direction)
    this.sunColour.value.copy(light.color).multiplyScalar(light.intensity)
    this.skyColour.value.copy(light.ambient)
  }

  dispose() {
    this.material.dispose()
  }
}

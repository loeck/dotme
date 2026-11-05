import {
  attribute,
  cameraPosition,
  float,
  fwidth,
  mix,
  mx_noise_float,
  normalView,
  normalWorldGeometry,
  positionView,
  positionWorld,
  smoothstep,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import type { TerrainSkyFill } from './terrain-detail'

/*
 * Procedural, texture-free ground for the smooth terrain. Layers follow what a Nordic lake shore
 * shows at this scale: moss and low heath on gentle ground, straw-dry grass in open patches,
 * needle litter under the conifers, damp peat in hollows, bare granite on steep faces and ridges,
 * gravel then dark wet mud at the waterline. Albedos stay in measured ranges for visible light
 * (moss and conifer litter 0.04–0.12, soil about 0.1, weathered granite 0.13–0.22).
 *
 * Every noise octave is band-limited: it fades out before one cell covers less than about two
 * pixels (Quilez, "bandlimiting"), so the grazing camera never sees shimmer. The detail normal is
 * a world-space height turned into a surface gradient (Mikkelsen), applied after differentiation
 * so triangle facets never print through, and fades out with distance.
 */

type FloatNode = Node<'float'>
type Vec3Node = Node<'vec3'>

const linear = (r: number, g: number, b: number) => vec3(r, g, b)

/** World metres covered by one pixel, the scale every octave is filtered against. */
const footprint = () => {
  const width = fwidth(positionWorld)
  return width.x.max(width.y).max(width.z)
}

/** One Perlin octave in [-1, 1], faded to zero before it would alias. */
function octave(position: Vec3Node, frequency: number, pixel: FloatNode): FloatNode {
  const fade = smoothstep(0.55, 0.22, pixel.mul(frequency))
  return mx_noise_float(position.mul(frequency)).mul(fade)
}

/** Perturbed view-space normal from a world-space height (surface gradient method). */
function bumpNormal(height: FloatNode, strength: FloatNode): Vec3Node {
  const dpdx = positionView.dFdx()
  const dpdy = positionView.dFdy()
  const r1 = dpdy.cross(normalView)
  const r2 = normalView.cross(dpdx)
  const det = dpdx.dot(r1)
  const gradient = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)))
  return det.abs().mul(normalView).sub(gradient.mul(strength)).normalize()
}

/**
 * Weathered granite, as on glaciated shores: dark warm grey with feldspar speckle, joint
 * fissures a metre or two apart (visible from afar, so they live in the albedo rather than only
 * in the fading relief), muted grey-green lichen crusts and dark rain streaks down the faces.
 */
function graniteColour(p: Vec3Node, pixel: FloatNode, tone: FloatNode): Vec3Node {
  const speckle = octave(p, 23, pixel)
    .mul(0.5)
    .add(octave(p, 61, pixel).mul(0.5))
  const blotch = octave(p, 0.9, pixel)
    .mul(0.6)
    .add(octave(p, 3.1, pixel).mul(0.4))
  // Ridged noise: thin dark lines where the Perlin field crosses zero.
  // Joints run mostly upright on faces: stretch the field vertically so cracks read as sets of
  // near-parallel lines rather than a mud-crack network.
  const jointPoint = vec3(p.x, p.y.mul(0.3), p.z)
  const jointField = octave(jointPoint, 0.7, pixel).add(octave(jointPoint, 2.1, pixel).mul(0.25))
  const joints = smoothstep(0.055, 0.0, jointField.abs()).mul(smoothstep(1.2, 0.3, pixel.mul(0.7)))
  const streak = smoothstep(
    0.2,
    0.8,
    octave(vec3(p.x.mul(2.6), p.y.mul(0.3), p.z.mul(2.6)), 1, pixel),
  )
  const crust = smoothstep(0.2, 0.62, octave(p, 1.9, pixel).add(octave(p, 6.5, pixel).mul(0.4)))
  const base = mix(
    linear(0.052, 0.048, 0.043),
    linear(0.125, 0.115, 0.1),
    tone.add(blotch.mul(0.3)).clamp(),
  )
  const speckled = base.mul(speckle.mul(0.2).add(1))
  const lichened = mix(speckled, linear(0.105, 0.112, 0.088), crust.mul(0.45))
  return lichened.mul(streak.mul(0.25).oneMinus()).mul(joints.mul(0.38).oneMinus())
}

export function createTerrainMaterial(sky: TerrainSkyFill): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: 0.8,
  })
  sky.applyTo(material)
  const surface = attribute<'vec4'>('surface', 'vec4')
  const rockHint = surface.x,
    skyVisibility = surface.y,
    hollow = surface.z,
    litter = surface.w
  const p = positionWorld
  const pixel = footprint()
  const up = normalWorldGeometry.y
  const steep = up.oneMinus()
  const above = p.y.sub(WATER_LEVEL)

  const macro = mx_noise_float(p.mul(0.06)).mul(0.5).add(0.5)
  const patch = octave(p, 0.32, pixel).mul(0.5).add(0.5)
  const grain = octave(p, 3.1, pixel)
    .mul(0.55)
    .add(octave(p, 8.5, pixel).mul(0.3))
    .add(octave(p, 21, pixel).mul(0.15))
  const tuft = octave(p, 1.4, pixel).mul(0.5).add(0.5)

  // Moss carpet with brighter cushions where open sky reaches it.
  let ground: Vec3Node = mix(
    linear(0.026, 0.04, 0.016),
    linear(0.058, 0.082, 0.028),
    tuft.add(grain.mul(0.25)).clamp(),
  )
  ground = mix(
    ground,
    linear(0.092, 0.112, 0.038),
    smoothstep(0.58, 0.85, patch).mul(skyVisibility).mul(0.55),
  )
  // Heath and straw-dry grass in open, gentle patches.
  const dry = smoothstep(0.6, 0.82, macro.add(patch.mul(0.25)))
    .mul(smoothstep(0.82, 0.95, up))
    .mul(litter.oneMinus())
  ground = mix(ground, linear(0.15, 0.118, 0.062), dry.mul(0.7))
  // Damp peat and soil gather in hollows.
  ground = mix(
    ground,
    linear(0.05, 0.036, 0.026),
    smoothstep(0.56, 0.78, hollow.add(grain.mul(0.04))).mul(0.65),
  )
  // Needle and leaf litter under the trees' drip lines.
  const needles = smoothstep(0.25, 0.75, litter.add(grain.mul(0.18)))
  ground = mix(ground, linear(0.1, 0.06, 0.032), needles)

  // Rock where the ground is steep, on ridges and where the composition put stone.
  // Moss and heath hold on up to about 50°; bare rock shows on steeper faces, on convex
  // knobs and where the composition placed stone, in patches rather than whole hillsides.
  const rockWeight = steep
    .mul(1.45)
    .add(rockHint.mul(0.22))
    .add(hollow.oneMinus().sub(0.5).max(0).mul(0.7))
    .add(patch.sub(0.5).mul(0.3))
  const rock = smoothstep(0.56, 0.64, rockWeight.add(grain.mul(0.08)))
  // Thin vegetation creeps back over rock in its fissures and on ledges.
  const ledges = smoothstep(0.75, 0.9, up).mul(smoothstep(0.45, 0.7, tuft))
  const stone = graniteColour(p, pixel, macro)

  // The waterline: gravel and pebbles, then dark saturated mud, broken by noise.
  // A narrow strip a hand or two above the water: on a low, grassy bank the turf runs almost to
  // the waterline, as it does on a real lake shore.
  const gravelLine = float(0.04).add(patch.mul(0.06)).add(grain.mul(0.03))
  const gravel = smoothstep(gravelLine, gravelLine.sub(0.05), above).mul(
    steep.mul(2.2).oneMinus().clamp(),
  )
  const pebbles = linear(0.12, 0.112, 0.098).mul(octave(p, 14, pixel).mul(0.25).add(1))
  const mud = smoothstep(float(0.035).add(grain.mul(0.015)), float(0.005), above)

  let albedo: Vec3Node = mix(ground, pebbles, gravel)
  albedo = mix(albedo, stone, rock.mul(ledges.mul(0.7).oneMinus()))
  albedo = mix(albedo, linear(0.042, 0.038, 0.03), mud.mul(0.85))
  // Slow tint across the hills hides any repetition at 30–70 m.
  albedo = albedo.mul(macro.mul(0.24).add(0.88))
  material.colorNode = albedo

  const roughness = mix(
    mix(mix(float(0.96), float(0.86), needles), float(0.8), gravel),
    float(0.68),
    rock,
  )
  // Wet silt, not a mirror: glossier, it caught the whole sky at grazing view like concrete.
  material.roughnessNode = mix(roughness, float(0.62), mud)
  material.aoNode = skyVisibility

  // Detail relief: moss tufts on the ground, cracks and grain on stone, pebbles at the shore.
  const distance = p.distance(cameraPosition)
  const near = smoothstep(42, 5, distance)
  const groundRelief = octave(p, 2.2, pixel)
    .mul(0.014)
    .add(octave(p, 7, pixel).mul(0.006))
  const rockRelief = octave(p, 1.1, pixel)
    .mul(0.05)
    .add(octave(p, 3.4, pixel).mul(0.018))
    .add(octave(p, 11, pixel).mul(0.005))
  const pebbleRelief = octave(p, 13, pixel).abs().mul(0.012)
  const relief = mix(mix(groundRelief, pebbleRelief, gravel), rockRelief, rock)
  material.normalNode = bumpNormal(relief, near)
  return material
}

/**
 * Granite boulders and the waterfall's rock face: tone per stone, moss caps, lichen, a dark wet
 * band at the waterline, and darker, glossier stone where spray wets it.
 */
export function createBoulderMaterial(sky: TerrainSkyFill): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.7,
    metalness: 0,
    envMapIntensity: 0.8,
  })
  sky.applyTo(material)
  const surface = attribute<'vec4'>('surface', 'vec4')
  const tone = surface.x,
    mossBias = surface.y,
    base = surface.z,
    // Spray on the rock face behind a waterfall: darker, glossier stone.
    spray = surface.w
  const p = positionWorld
  const pixel = footprint()
  const up = normalWorldGeometry.y
  const above = p.y.sub(WATER_LEVEL)
  const grain = octave(p, 6, pixel)
    .mul(0.6)
    .add(octave(p, 17, pixel).mul(0.4))

  const stone = graniteColour(p, pixel, tone.mul(0.7).add(0.15))
  // Moss caps on the upper faces, away from the splash zone, more on some stones.
  const moss = smoothstep(0.45, 0.85, up.add(mossBias.mul(0.35)).add(grain.mul(0.15)).sub(0.3)).mul(
    smoothstep(0.12, 0.35, above),
  )
  const mossColour = mix(
    linear(0.03, 0.045, 0.017),
    linear(0.07, 0.092, 0.03),
    octave(p, 4, pixel).mul(0.5).add(0.5),
  )
  // Waterline: a darker, slightly brown-green film where waves keep the stone wet.
  const waterline = smoothstep(0.16, 0.0, above.add(grain.mul(0.03)))
  // The buried foot gathers soil.
  const foot = smoothstep(0.2, 0.0, base).mul(smoothstep(0.05, 0.2, above))

  let albedo: Vec3Node = mix(stone, mossColour, moss.mul(spray.oneMinus()))
  albedo = mix(albedo, linear(0.045, 0.042, 0.032), waterline.mul(0.8))
  albedo = mix(albedo, linear(0.06, 0.045, 0.032), foot.mul(0.6))
  albedo = albedo.mul(spray.mul(-0.45).add(1))
  material.colorNode = albedo
  material.roughnessNode = mix(
    mix(mix(float(0.66), float(0.93), moss), float(0.3), waterline),
    float(0.22),
    spray,
  )

  const distance = p.distance(cameraPosition)
  const near = smoothstep(30, 3, distance)
  const relief = octave(p, 2.3, pixel)
    .mul(0.02)
    .add(octave(p, 7, pixel).mul(0.008))
    .add(octave(p, 19, pixel).mul(0.003))
  material.normalNode = bumpNormal(relief, near)
  return material
}

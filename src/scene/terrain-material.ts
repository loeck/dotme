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
  texture,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'

import { WATER_LEVEL } from './lake-bed'
import type { TerrainSkyFill } from './terrain-detail'
import type { TerrainTextures } from './terrain-textures'

/*
 * Scanned grass and forest litter over procedural ground. Layers follow what a temperate lake in
 * summer shows at this scale: lush meadow grass on gentle ground with drifts of buttercups,
 * rougher tussocky grass in patches, leaf litter under the trees, damp soil in hollows, pale
 * weathered limestone on steep faces and ridges, gravel then dark wet mud at the waterline, and
 * past the mid-ground a closed broadleaf canopy over the hills. Albedos stay in measured ranges
 * for visible light (green grass 0.06–0.14, soil about 0.1, weathered limestone 0.2–0.35).
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
 * Weathered limestone, as on the outcrops of a temperate upland: pale warm grey with a fine
 * speckle, joint fissures a metre or two apart (visible from afar, so they live in the albedo
 * rather than only in the fading relief), pale lichen crusts and dark rain streaks down the faces.
 */
function limestoneColour(p: Vec3Node, pixel: FloatNode, tone: FloatNode): Vec3Node {
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
    linear(0.13, 0.122, 0.105),
    linear(0.3, 0.285, 0.25),
    tone.add(blotch.mul(0.3)).clamp(),
  )
  const speckled = base.mul(speckle.mul(0.2).add(1))
  // Crustose lichens: pale grey-green rosettes in patches, and rare orange ones (Xanthoria,
  // Caloplaca) that shore rocks carry; both make up much of what a granite boulder shows.
  const pale = mix(
    linear(0.26, 0.26, 0.23),
    linear(0.34, 0.335, 0.3),
    octave(p, 9, pixel).mul(0.5).add(0.5),
  )
  const lichened = mix(speckled, pale, crust.mul(0.62))
  const orange = smoothstep(0.42, 0.6, octave(p.add(17.3), 2.7, pixel)).mul(0.5)
  const spotted = mix(lichened, linear(0.3, 0.2, 0.08), orange.mul(crust.oneMinus()).mul(0.2))
  return spotted.mul(streak.mul(0.3).oneMinus()).mul(joints.mul(0.42).oneMinus())
}

export function createTerrainMaterial(
  sky: TerrainSkyFill,
  scans?: TerrainTextures,
): MeshStandardNodeMaterial {
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
  // World-space mapping follows the heightfield without mesh UV seams. A second,
  // rotated sample blends across broad patches to hide the scans' repeating tiles.
  const coordinates = p.xz.mul(0.25)
  const rotated = vec2(p.x.mul(0.8).sub(p.z.mul(0.6)), p.x.mul(0.6).add(p.z.mul(0.8)))
    .mul(0.21)
    .add(0.37)
  const scan = (maps: TerrainTextures['grass']) => {
    const color = texture(maps.color)
    const detail = texture(maps.surface)
    return {
      color: mix(color.sample(coordinates).rgb, color.sample(rotated).rgb, patch),
      surface: mix(detail.sample(coordinates).rg, detail.sample(rotated).rg, patch),
    }
  }
  const grassScan = scans && scan(scans.grass)
  const forestScan = scans && scan(scans.forest)

  // Meadow grass: a fresh, yellow-green sward, brighter where open sky and sun reach it.
  let ground: Vec3Node = mix(
    linear(0.052, 0.09, 0.018),
    linear(0.09, 0.14, 0.026),
    tuft.add(grain.mul(0.25)).clamp(),
  )
  ground = mix(
    ground,
    linear(0.12, 0.165, 0.032),
    smoothstep(0.55, 0.85, patch).mul(skyVisibility).mul(0.5),
  )
  // Seeding grass in open, gentle patches: paler and a little golden, still mostly green.
  const dry = smoothstep(0.62, 0.84, macro.add(patch.mul(0.25)))
    .mul(smoothstep(0.82, 0.95, up))
    .mul(litter.oneMinus())
  ground = mix(ground, linear(0.15, 0.16, 0.05), dry.mul(0.4))
  // Rough, tussocky grassland in patches a few metres across: darker, bluer clumps (tufted
  // hair-grass, rushes, bramble) over a clumpy grain, so slopes read as tall vegetation.
  const roughPatch = octave(p, 0.42, pixel).add(octave(p, 1.3, pixel).mul(0.35))
  const roughGrass = smoothstep(0.05, 0.4, roughPatch)
    .mul(smoothstep(0.78, 0.92, up))
    .mul(litter.oneMinus())
    .mul(smoothstep(0.25, 0.6, above))
  const roughTone = octave(p, 0.9, pixel).mul(0.5).add(0.5)
  const rough = mix(linear(0.038, 0.072, 0.018), linear(0.06, 0.095, 0.024), roughTone)
  const clumps = octave(p, 5.5, pixel)
    .mul(0.5)
    .add(octave(p, 13, pixel).mul(0.25))
  ground = mix(ground, rough.mul(clumps.mul(0.35).add(1)), roughGrass.mul(0.55))
  if (grassScan) ground = mix(ground, grassScan.color.mul(vec3(0.78, 1, 0.65)), float(0.72))
  // Buttercups in drifts over the open meadow: yellow heads a few centimetres across, which
  // blend to a faint golden cast where the heads fall below a pixel.
  // Drifts reuse the slow tint and the patch octave: every Perlin octave costs on a field
  // that covers most of the screen.
  const drift = smoothstep(0.6, 0.85, macro.mul(0.8).add(patch.mul(0.35)))
    .mul(smoothstep(0.85, 0.95, up))
    .mul(litter.oneMinus())
    .mul(smoothstep(0.15, 0.4, above))
  const heads = smoothstep(0.35, 0.6, octave(p, 11, pixel))
  const resolved = smoothstep(0.55, 0.22, pixel.mul(11))
  const buttercup = linear(0.42, 0.32, 0.02)
  ground = mix(ground, buttercup, drift.mul(mix(float(0.12), heads.mul(0.85), resolved)))
  // Damp soil gathers in hollows.
  ground = mix(
    ground,
    linear(0.05, 0.04, 0.024),
    smoothstep(0.6, 0.8, hollow.add(grain.mul(0.04))).mul(0.55),
  )
  // Last year's leaf litter under the trees' drip lines.
  const needles = smoothstep(0.25, 0.75, litter.add(grain.mul(0.18)))
  ground = mix(ground, forestScan?.color ?? linear(0.085, 0.06, 0.03), needles)

  // Rock where the ground is steep, on ridges and where the composition put stone.
  // Bare rock shows on steep faces, on convex knobs and where the composition placed stone,
  // in patches rather than whole hillsides.
  const rockWeight = steep
    .mul(1.45)
    .add(rockHint.mul(0.22))
    .add(hollow.oneMinus().sub(0.5).max(0).mul(0.7))
    .add(patch.sub(0.5).mul(0.3))
  // A meadow sward holds on steep ground: bare rock shows only on real outcrops.
  const rock = smoothstep(0.64, 0.72, rockWeight.add(grain.mul(0.08)))
  // Thin vegetation creeps back over rock in its fissures and on ledges.
  const ledges = smoothstep(0.75, 0.9, up).mul(smoothstep(0.45, 0.7, tuft))
  // Ivy, ferns and grass cling to the faces in ragged, mostly upright streaks.
  const clinging = smoothstep(0.15, 0.45, roughPatch.add(grain.mul(0.3))).mul(0.7)
  const stone = mix(limestoneColour(p, pixel, macro), rough, clinging)

  // The waterline: gravel and pebbles, then dark saturated mud, broken by noise.
  // A narrow strip a hand or two above the water: on a low, grassy bank the turf runs almost to
  // the waterline, as it does on a real lake shore.
  const gravelLine = float(0.04).add(patch.mul(0.06)).add(grain.mul(0.03))
  const gravel = smoothstep(gravelLine, gravelLine.sub(0.05), above).mul(
    steep.mul(2.2).oneMinus().clamp(),
  )
  const pebbles = linear(0.12, 0.112, 0.098).mul(octave(p, 14, pixel).mul(0.25).add(1))
  const mud = smoothstep(float(0.035).add(grain.mul(0.015)), float(0.005), above)

  // Past the mid-ground the hills carry a closed broadleaf wood (the trees themselves stop at
  // the far shore): a dark, billowing canopy of crowns a few metres across, sunlit on their
  // tops, that thins into the meadow in slow patches and leaves the outcrops bare.
  const distance = p.distance(cameraPosition)
  const woodland = smoothstep(
    0.45,
    0.62,
    smoothstep(48, 95, distance).mul(0.8).add(macro.mul(0.5)).sub(steep.mul(0.9)),
  ).mul(smoothstep(0.8, 2.2, above))
  // Crowns from the patch and tuft octaves already sampled (about 3 m and 0.7 m cells).
  const crowns = patch.mul(0.65).add(tuft.mul(0.35))
  const canopy = mix(
    linear(0.016, 0.034, 0.01),
    linear(0.05, 0.098, 0.022),
    smoothstep(0.3, 0.8, crowns).mul(up.mul(0.6).add(0.4)),
  )
  ground = mix(ground, canopy, woodland.mul(rock.oneMinus()))

  let albedo: Vec3Node = mix(ground, pebbles, gravel)
  albedo = mix(albedo, stone, rock.mul(ledges.mul(0.7).oneMinus()))
  albedo = mix(albedo, linear(0.042, 0.038, 0.03), mud.mul(0.85))
  // Slow tint across the hills hides any repetition at 30–70 m.
  albedo = albedo.mul(macro.mul(0.24).add(0.88))
  material.colorNode = albedo

  const groundRoughness =
    grassScan && forestScan
      ? mix(grassScan.surface.r, forestScan.surface.r, needles).clamp(0.58, 0.98)
      : mix(float(0.96), float(0.86), needles)
  const roughness = mix(mix(groundRoughness, float(0.8), gravel), float(0.68), rock)
  // Wet silt, not a mirror: glossier, it caught the whole sky at grazing view like concrete.
  material.roughnessNode = mix(roughness, float(0.62), mud)
  material.aoNode = skyVisibility

  // Detail relief: grass tufts on the ground, cracks and grain on stone, pebbles at the shore.
  const near = smoothstep(42, 5, distance)
  let groundRelief = octave(p, 2.2, pixel)
    .mul(0.014)
    .add(octave(p, 7, pixel).mul(0.006))
  if (grassScan && forestScan)
    groundRelief = groundRelief.add(
      mix(grassScan.surface.g, forestScan.surface.g, needles).mul(0.035),
    )
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
 * Limestone boulders and the waterfall's rock face: tone per stone, moss caps, lichen, a dark wet
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

  const stone = limestoneColour(p, pixel, tone.mul(0.7).add(0.15))
  // Grass and moss caps on the upper faces, away from the splash zone, more on some stones: an
  // outcrop in a meadow wears turf on every ledge, leaving its pale flanks bare.
  const moss = smoothstep(0.32, 0.62, up.add(mossBias.mul(0.35)).add(grain.mul(0.15)).sub(0.3)).mul(
    smoothstep(0.12, 0.35, above),
  )
  const mossColour = mix(
    linear(0.045, 0.08, 0.018),
    linear(0.09, 0.135, 0.026),
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
  const near = smoothstep(45, 3, distance)
  // Weathered granite: knobbly grain, and cracks cut in where a ridged field crosses zero.
  const crack = smoothstep(0.06, 0.0, octave(p, 1.6, pixel).abs()).mul(0.012)
  const relief = octave(p, 2.3, pixel)
    .mul(0.032)
    .add(octave(p, 7, pixel).mul(0.012))
    .add(octave(p, 19, pixel).mul(0.004))
    .sub(crack)
  material.normalNode = bumpNormal(relief, near)
  return material
}

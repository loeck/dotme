# Vegetation

Trees, bushes and foreground undergrowth follow Voxen's _Last Signal_ (`pine.model.ts`,
`undergrowth.model.ts`, `props.toml`, `forest.toml`) and the renderer decisions behind it:
wood stays voxels, foliage masks become botanical cards (ADR 0114), and undergrowth is
procedural geometry (ADR 0107 for grass blades, ADR 0112 for fern fronds). The world worker
builds everything (`vegetation-models.ts`, `vegetation-meshes.ts`, `foliage-atlas.ts`,
`vegetation-placement.ts`) and transfers typed arrays; the render thread only wraps them
(`vegetation.ts`).

## Models

Models are carved from ellipsoid, cone and limb operations on an 8 cm grid (10 cm on phones),
about a third of the 25 cm terrain voxel. Each cell has a role: wood, needles or leaves.

- Spruce: Last Signal's conical form, a core cone and seven boughs per tier turned by the
  golden angle, drooping 28° and tapering 84% toward the top; 15% of boughs use the pale needle
  colour. One variant uses the darker spruce needles. A solid needle spire over the top third
  carries the crown to its tip, so the small top tiers do not float apart. Boughs start at 27–33% of the height so
  a short dark trunk shows under the skirt.
- Pine: Last Signal's mature form, a tall trunk orange from 55% of the canopy base, bark flakes
  below, and an uneven crown of scaffold lobes around a dense inner mass.
- Birch: a pale trunk with rotated dark marks and forked leaf sprays from half its height, the
  main value break against the dark conifers.
- Bush: a dozen overlapping leaf clumps; tree companions in about a third of two slots per tree.

Trunks are deliberately stout (Last Signal's pine: 0.18 m at the base) so they still read from
the default camera, tens of metres away. Trees cluster into groves with clearings, keep 1.6 m between trunks and grow up to 35% larger
toward the horizon. Birches stay in the mid-ground band.

## Wood and foliage

Wood cells are meshed once: exposed faces only, classic per-corner voxel occlusion and a small
hashed tone per voxel. Foliage cells are never drawn as voxels. As in Voxen's clump planner,
every three-cell block with an exposed foliage cell becomes one seed: its centroid, majority
role, mean colour, and the crown shape probed in 26 directions one to three pitches out, which
gives the open direction and openness. Each seed emits three to five cards from a small
procedural atlas: drooping, serrated bough sprays for needles (0.6 as tall as wide, tipped
upward) and hanging leaf clusters for leaves. The first card loosely faces the camera; seeds
with openness under 0.6 add a dark core disc so gaps inside a crown show foliage, not sky.
Cluster scales range over [0.85, 1.45], each tree takes a factor in [0.85, 1.2], isolated
tufts shrink to 0.6 and far clumps grow up to 1.25× from 15 to 55 m. Seeds on a crown's
underside get cards up to 40% smaller that never drop below the seed, so the trunk stays visible
under the crown. Cards stay within about 30° of vertical, so a low camera never sees a crown's top
cards edge-on as pale slivers. Card normals lean toward the open direction, with its upward
part damped so sunlit crown tops do not read as a pale lid. Albedo takes a cluster value hash, a per-tree hue and value jitter,
a cool-underside to warm-top ramp and an openness and height shade.

The atlas (512 × 256 RGBA8) stores a palette-relative tone and cutout coverage. Cards use an
alpha test with a mip-level coverage boost, so distant crowns do not thin out. Lighting adds
Last Signal's sky-light rim and back-light translucency, strongest at the crown rim and against
a low sun.

## Undergrowth

Grass, ferns and flowers grow on the mossy foreground bank, in 1.6 m clumps inside 8 m patches,
with some patches drying toward straw. A grass tuft is a sparse fan of six to ten quadratic
Bézier ribbons with four rows of widths 0.55, 1, 0.5 and 0.12 and a pointed tip, tinted from
the ground to the tip. A fern crown is a ring of arching, drooping rachis strips cut into
alternating leaflets. Flowers have a thin stem and five cupped petals around a warm heart.
Under the clumps, a ground cover of short tufts (seven to ten blades of 6–13 cm, two rows
and a tip, three triangles each) grows on most of the bank's columns, thinner on bare patches
and drier where the clumps dry, so the soil between tall tufts reads as turf rather than bare
voxels. Thin blades pass some sunlight when the view faces a low sun.

## Streaming

The forest never holds up the first frame. The world worker that builds the lake surfaces
posts them first, then grows the forest and posts it as its own message, also when it beats
the terrain. Once the scene is presented, the engine builds the three meshes off-scene, gives
their materials the scene's cloud shadows, pointer light and fog hand-off, and compiles them
for every view that draws them: main view, mirror, environment probe and shadow maps. Then
they join the scene, the shadow maps refresh, and the forest dissolves in over 0.7 s through
a screen-space interleaved-gradient mask (instant under reduced motion). On a failed or
cancelled preparation the scene simply stays without vegetation.

## Cost

The forest is three merged world-space meshes, so three draws: wood, foliage cards and
undergrowth. The undergrowth sits on `UNDERGROWTH_LAYER`, which only the main camera enables,
so the water reflection, the environment probe and the shadow pass never draw it. Wood and
foliage cast shadows through the shadow layer, with the cards' cutout. On seed 9182 the desktop
forest is about 258k triangles (197k of them undergrowth) and the phone forest about 48k. Preparation runs after the surfaces on the
same worker, off the first frame's critical path. Unit tests bound the triangle budget and check determinism.

## Wind

Sway follows Voxen's ADR 0110: a height-squared shear, a rest lean with the wind speed and three
buffeting sines (rates 0.53, 0.97, 1.61; weights 0.5, 0.3, 0.2) at 1.2/√H Hz. Cards, blades and
leaflets add a light flutter. The per-vertex `wind` attribute stores bend, phase, flutter and
angular frequency. Reduced motion freezes the time, keeping only the static lean.

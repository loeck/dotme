# Vegetation

The lake shore's forest is Norway spruce, Scots pine and weeping birch, with low shrubs on the
banks and grass, ferns and flowers on the foreground bank. Trees and shrubs are procedural
models: a branch skeleton grown by each species' habit, wood meshed as smooth tapered tubes and
twigs clothed in foliage cards from a procedural botanical atlas. Undergrowth is procedural
geometry (Voxen's ADR 0107 for grass blades, ADR 0112 for fern fronds). The world worker builds
everything (`vegetation-models.ts`, `vegetation-meshes.ts`, `foliage-atlas.ts`,
`vegetation-placement.ts`) and transfers typed arrays; the render thread only wraps them
(`vegetation.ts`).

## Models

Trees are 5 to 7.5 m tall before their placement scale, in the proportions of young stands on a
Nordic shore:

- Norway spruce: a straight trunk and a whorl of four to six branches every 30 cm, with smaller
  internodal branches between whorls. Branches leave nearly level at the bottom and rise a little
  toward the top, sag and lift their tips, and are longest low down, so the crown is a narrow
  pointed cone (radius about 18% of the height) with branches down to 10–17% of it. Sprays hang
  along each branch's outer two thirds, shrinking toward the tip; some turn across the branch so
  one pointing at the viewer still shows. Dark cores round the trunk stand for the shaded inner
  branches. One variant has darker, bluer needles.
- Scots pine: a trunk that wanders slightly, grey-brown and furrowed below and orange above,
  bare to 55–65% of the height but for a few dead stubs. Ten to thirteen scaffold limbs rise
  15–45° and fork, and every limb and fork ends in a flattish cloud of needle tufts.
- Weeping birch: a slender white trunk with black lenticel dashes and a dark, fissured foot.
  Thirteen to sixteen limbs rise steeply and arch over, longest mid-crown for an ovoid outline,
  and curtains of hanging twigs spread off both sides of them.
- Shrub: a low dome of leafy cards; tree companions in about a third of two slots per tree, and
  mid-ground cover (below).

Trees cluster into groves with clearings, keep 1.6 m between trunks and grow up to 35% larger
toward the horizon. Birches stay in the mid-ground band. Each islet first gets a tree on its
crown (its highest open ground, nearest the centre on a tie) at three quarters of the usual
size, so no mound reads as a bare stone pyramid and the tree stays in proportion to it.

Past the foreground, grass blades would shrink below a pixel, so the mid-ground turf reads
through scattered bushes instead (Last Signal's islet and bank cover): one candidate per 3 × 3
columns between the undergrowth and the far shore, jittered, gathered into 5 m patches, off
tree trunks, other bushes and a step's last column. Up to 180 on desktop and 32 on phones.

## Wood and foliage

Wood is generalized cylinders: rings along each limb with parallel-transported frames, so tubes
never twist, with eight sides on a trunk and three or four on a limb (six and three on phones).
Only a spruce's main branches carry wood; the foliage hides its thin internodal ones. Bark colour
is per vertex: plates and furrows from the angle and height, the pine's orange upper trunk, the
birch's dashes and dark foot.

Foliage cards keep their place on their twig, in model space, rather than facing the camera. Each
card's normal leans 65% toward the outside of its crown (from an axis through the crown's centre),
so a crown shades as one mass, and cards deep inside, near the trunk, darken to half their value.
Colour takes the species' palette, a per-tree hue and value jitter and a small per-card hash.

The atlas has eight tiles: two Norway spruce sprays (a shoot across the top with combed,
needle-clothed branchlets hanging from it, each branchlet its own shade), two Scots pine tuft
sets (brushes of long needles on short twigs), two weeping birch tiles (slender hanging twigs
with small ovate leaves), shrub foliage and a lobed core disc. Desktop bakes 256-texel tiles
(1024 × 512); phones bake 128-texel ones, a quarter of the work, for their smaller trees. Each
texel stores a palette-relative tone and cutout coverage. Cards use an alpha test with a
mip-level coverage boost, so distant crowns do not thin out. Lighting adds a sky-light rim and
back-light translucency, strongest at the crown rim and against a low sun.

## Undergrowth

Grass, ferns and flowers grow on the mossy foreground bank, in 1.6 m clumps inside 8 m patches,
with some patches drying toward straw. A grass tuft is a sparse fan of six to ten quadratic
Bézier ribbons with four rows of widths 0.55, 1, 0.5 and 0.12 and a pointed tip, tinted from
the ground to the tip. A fern crown is a ring of arching, drooping rachis strips cut into
alternating leaflets. Flowers have a thin stem and five cupped petals around a warm heart.
Under the clumps, a ground cover of short tufts (seven to ten blades of 6–13 cm, two rows
and a tip, three triangles each) grows on most of the bank's columns, thinner on bare patches
and drier where the clumps dry, so the soil between tall tufts reads as turf rather than bare
ground. Placement reads the smooth ground's neighbouring 12.5 cm columns (a slope only counts as
a step beyond 5 cm per column of distance): tall clumps keep off a step's last column,
and blades near a step or a wall turn away from it and lean less, while ground cover there moves
inward and stays shorter, so no blade hangs over a drop. Thin blades pass some sunlight when the
view faces a low sun.

## Loading

The forest is part of the first frame, so trees never pop in after the loader. The world
worker that builds the lake surfaces posts them first, then grows the forest and posts it as
its own message; the engine waits for it after building the scene, adds the three meshes,
gives their materials the scene's cloud shadows, pointer light and fog hand-off, and compiles
them for every view that draws them (main view, mirror, environment probe and shadow maps) in
the same batch as the scene's shaders. The forest message usually lands about 0.1 s after the
world data, and its compiles run alongside the scene's, so the wait is short. On a failed
preparation the scene simply loads without vegetation.

## Cost

The forest is three merged world-space meshes, so three draws: wood, foliage cards and
undergrowth. The undergrowth sits on `UNDERGROWTH_LAYER`, which only the main camera enables,
so the water reflection, the environment probe and the shadow pass never draw it. Wood and
foliage cast shadows through the shadow layer, with the cards' cutout. On seed 9182 the desktop
forest is about 266k triangles: 37k of wood, 27k of foliage cards and 203k of undergrowth; the
phone forest is about 56k (18k, 10k and 28k). The voxel trees it replaces drew 21k of wood and
63k of cards on desktop, so trees and shrubs cost about the same, and preparation takes about as
long (within 5%, measured side by side). Preparation runs after the surfaces on the
same worker, off the first frame's critical path. Unit tests bound the triangle budget and check determinism.

## Wind

Sway follows Voxen's ADR 0110: a height-squared shear, a rest lean with the wind speed and three
buffeting sines (rates 0.53, 0.97, 1.61; weights 0.5, 0.3, 0.2) at 1.2/√H Hz. Cards, blades and
leaflets add a light flutter that moves each piece rigidly at no more than about 1.1 Hz; blades
sway at most about 1.3 Hz. A per-vertex flutter at the plants' natural rates made the vegetation
tremble, as Voxen's ADR 0110 found for a fixed 2 Hz flutter. The per-vertex `wind` attribute stores bend, phase, flutter and
angular frequency. Reduced motion freezes the time, keeping only the static lean.

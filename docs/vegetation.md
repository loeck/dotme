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
  15–45° and fork, and every limb and fork ends in a rounded, domed clump of needle brushes.
- Silver birch: a slender white trunk with black lenticel dashes and a dark, fissured foot.
  Thirteen to sixteen limbs rise steeply (40–60°) and only their outer part arches, longest
  mid-crown for an ovoid outline; twigs spread off both sides, about half hanging and half
  turned every way, so the crown is a mass rather than a willow's curtains.
- Shrubs: bilberry domes of leafy cards, common junipers (dark blue-green columns a metre or so
  tall, of two or three irregular stems of needle tufts) and spruce saplings (a spruce's habit at
  0.9–1.6 m, with shorter internodes and smaller sprays). Tree companions, in about a third of two
  slots per tree, are mostly bilberry and saplings; mid-ground cover (below) is about 55%
  bilberry, 30% juniper and 15% saplings.

Trees cluster into groves with clearings, up to 110 on desktop and 30 on phones, about 44% spruce, 34% pine and 22% birch, keep 1.8 m between trunks and grow up to 35% larger
toward the horizon. Birches stay in the mid-ground band. Each islet first gets a tree on its
crown (its highest open ground, nearest the centre on a tie) at three quarters of the usual
size, so no mound reads as a bare stone pyramid and the tree stays in proportion to it.

Past the foreground, grass blades would shrink below a pixel, so the mid-ground turf reads
through scattered bushes instead (Last Signal's islet and bank cover): one candidate per 3 × 3
columns between the undergrowth and the far shore, jittered, gathered into 5 m patches, off
tree trunks, other bushes and a step's last column. Up to 450 on desktop and 70 on phones.

## Wood and foliage

Wood is generalized cylinders: rings along each limb with parallel-transported frames, so tubes
never twist, with eight sides on a trunk and three or four on a limb (six and three on phones).
Only a mature spruce's main branches carry wood; the foliage hides its thin internodal ones and a sapling's branches. Bark colour
is per vertex: plates and furrows from the angle and height, the pine's orange upper trunk, the
birch's dashes and dark foot.

Foliage cards keep their place on their twig, in model space, rather than facing the camera. Each
card's normal leans 65% toward the outside of its crown (from an axis through the crown's centre),
so a crown shades as one mass, and cards deep inside, near the trunk, keep a third of their value and the lower crown, shaded by the upper, a little less.
Colour takes the species' palette, a per-tree hue and value jitter and a small per-card hash.
Needles stay olive rather than blue-grey: sunlit, the haze already adds the blue. A spruce's leader
is a dense spire of ten sprays, so its tip reads as needles against the sky rather than a few
cards the sky shows through. The material is matte (roughness 0.95, a 45% sky reflection).

The atlas has eight tiles: two Norway spruce sprays (a shoot across the top with combed,
needle-clothed branchlets hanging from it, each branchlet its own shade), two Scots pine tiles
(overlapping brushes of paired needles radiating round short shoot tips), two weeping birch tiles (slender hanging twigs
with small ovate leaves), shrub foliage and a lobed core disc. Desktop bakes 512-texel tiles
(2048 × 1024); phones bake 256-texel ones. The worker also bakes the mip chain, each level's
alpha scaled per tile so the same share of texels passes the cutout as at full resolution
(Castaño, "Computing Alpha Mipmaps"): plain averaging thinned distant sprays into blur, and a
shader boost had filled whole cards into squares. Each
texel stores a palette-relative tone, a rounded relief (each needle and leaf a dome a few
texels across) and cutout coverage. The relief's screen-space slope tilts each card's normal
(the surface-gradient method of the terrain's detail relief), so a near spray shades as rounded
shoots rather than a flat card; mip levels flatten it with distance. Cards use an alpha test over that chain. Lighting adds a sky-light rim and
back-light translucency, strongest at the crown rim and against a low sun.

## Undergrowth

The foreground bank is a sward of clumps (`grass.ts`), after Ghost of Tsushima's procedural
grass ([Wohllaib, GDC 2021](https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass)):
a clump, not a blade, sets height (each blade takes 80% of it), facing, lean, colour and dryness,
so the bank reads as tufts rather than combed hair. Clumps sit on a jittered 15 cm lattice, each
one of the shore's growth forms:

- short turf (bents, low fescues), 5–10 cm, about 40% of clumps, closing the ground between
  the others;
- wiry tufts (wavy hair-grass, sheep's fescue): needle-thin rolled leaves (1.6–2.8 mm before
  widening) in a fountain leaning outward from the clump's centre;
- flat-leaved tussocks (purple moor-grass, sedges) in 3 m patches: 4–7 mm blades, 24–52 cm, that
  arch, twist up to a turn and a half and droop at the tip;
- rushes, near the water: round, upright, dark stems 35–60 cm;
- seed stalks over a sixth of the wiry tufts and a tenth of the tussocks: a bare culm with a
  narrow purplish-brown or silvery panicle.

Dead material is what makes a real sward unkempt: 6–10% of the blades, plus up to 35% more in
dry patches, are straw (some with a broken, blunt tip) or litter lying almost flat at the base
([Molinia](https://bsbi.org/learn/resources/plant-crib/molinia); standing litter weighs heavily
in a canopy's reflectance, [HAPEX](https://www.sciencedirect.com/science/article/abs/pii/0034425795001980)).
Albedos follow field measurements, about 0.05 for green grass leaves in visible light
([Majasalmi & Bright 2019](https://gmd.copernicus.org/articles/12/3923/2019/)): blades darken
toward the root with h^1.5, the shade of their neighbours (as [AMD's mesh-shader
grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)), and
do not brighten at the tip, the glow that made the old blades read as fur. Each blade is a cubic
curve from its tilt, bend and droop, five rows near the camera and three far; its normals round
across the width by ±0.12π, as open Tsushima reimplementations do
([GodotGrass](https://github.com/2Retr0/GodotGrass)), and blend half way toward up, so it shades
as a curved strip. Detail falls off with distance: a clump keeps 4/d of its blades (at least a
fifth) and widens them by the inverse square root, with a floor of about 1.5 pixels, so coverage
holds without shimmering threads (Outerra and AMD halve the count and double the width per
level). Ferns (2% of lattice sites) and small flowers (1.5%) break the sward. A triangle budget
(260k on desktop, 44k on phones), visited in a seeded scatter order, thins the bank evenly.

Placement reads the smooth ground's neighbouring 12.5 cm columns (a slope only counts as a step
beyond 5 cm per column of distance): clumps near a step or a wall shrink, and their blades turn
away from it, so none hangs over a drop; blades root only clear of the water. The material is
matte (a 35% sky reflection: a sward hides most blades from the sky behind its neighbours), and
thin blades pass a little light only when the view faces a low sun.

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
forest is about 440k triangles: 112k of wood, 179k of foliage cards (about 2.6 times the previous
crowns' density) and 160k of undergrowth; the phone forest about 115k. The budget is set aside
for now and will be optimised last. The voxel trees it replaces drew 21k of wood and
63k of cards on desktop, so trees and shrubs cost a little less, and preparation takes about as
long (within 5%, measured side by side). Only a spruce's main branches carry wood, and a
sapling's none. Preparation runs after the surfaces on the
same worker, off the first frame's critical path. Unit tests bound the triangle budget and check determinism.

## Wind

Sway follows Voxen's ADR 0110: a height-squared shear, a rest lean with the wind speed and three
buffeting sines (rates 0.53, 0.97, 1.61; weights 0.5, 0.3, 0.2) at 1.2/√H Hz. Cards, blades and
leaflets add a light flutter that moves each piece rigidly at no more than about 1.1 Hz; blades
sway at most about 1.3 Hz. A per-vertex flutter at the plants' natural rates made the vegetation
tremble, as Voxen's ADR 0110 found for a fixed 2 Hz flutter. The per-vertex `wind` attribute stores bend, phase, flutter and
angular frequency. Reduced motion freezes the time, keeping only the static lean.

# Vegetation

The lake shore's wood is a temperate summer mix: broad, billowing oaks and taller beeches carry
the canopy, with silver birches as value breaks; leafy
shrubs and saplings fill its edge, and a lush meadow sward with drifts of buttercups covers the
foreground bank. Trees and shrubs are procedural
models: a branch skeleton grown by each species' habit, wood meshed as smooth tapered tubes and
twigs clothed in foliage cards from a procedural botanical atlas. Undergrowth is procedural
geometry (Voxen's ADR 0107 for grass blades, ADR 0112 for fern fronds). The world worker builds
everything (`vegetation-models.ts`, `vegetation-meshes.ts`, `foliage-atlas.ts`,
`vegetation-placement.ts`) and transfers typed arrays; the render thread only wraps them
(`vegetation.ts`).

## Models

Trees are 5 to 8.5 m tall before their placement scale:

- Oak and beech (`growBroadleaf`): a stout bole bare to 18–34% of the height, six to nine scaffold
  limbs that rise 28–70° (an oak's lower and wider, its crown about as broad as it is tall above
  the bole; a beech's steeper and ovoid) and fork two or three times. Every fork, every limb's end,
  a point part way along each limb and the leader carry a domed clump of leafy sprays on a
  shell, mostly on its upper and outer side, so the crown is a mass of rounded billows with deep
  shade between them; three lobed cores fill the gaps with shaded leaves. Cards tip back at most
  about 25°: cards facing the sky lit up as a pale lid. Oak bark is dark and furrowed, beech bark
  smooth and grey; oak leaves are darker and a little bluer than a beech's. Only the lowest
  limbs carry wood on a far tree, and forks none: their clumps hide them, and they cost a fifth
  of the forest's wood.

The Norway spruce and Scots pine models below are kept (spruce saplings still grow at the wood's
edge) but no longer planted as trees:

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
- Shrubs: leafy domes (hazel, hawthorn) up to a metre or so across, young oaks and beeches (a
  broadleaf's habit at 1.3–2.1 m), the odd common juniper (a dark blue-green column of needle
  tufts) and spruce sapling. Tree companions, in about a third of two slots per tree, are mostly
  leafy domes and young broadleaves; mid-ground cover (below) is about 55% domes, 30% young
  broadleaves, 8% spruce saplings and 7% junipers.

Trees cluster into groves with clearings, up to 170 on desktop and 38 on phones, about 55% oak,
36% beech and 9% birch (birches only in the mid-ground; conifers are no longer planted: their
layered cards read as bonsai among round crowns). On desktop the mid-ground islets and banks take at
most 38% of the cap, so glades stay open, and the highest ridges take the rest under the far level
of detail; the narrow portrait frame sees little past the mid-ground, so phones keep 70% there, keep 1.8 m between trunks and grow up to 35% larger
toward the horizon. Birches stay in the mid-ground band. Each islet first gets a round oak on its
crown (its highest open ground, nearest the centre on a tie) at three quarters of the usual
size, so no mound reads as a bare stone pyramid and the tree stays in proportion to it.

Past the foreground, grass blades would shrink below a pixel, so the mid-ground turf reads
through scattered bushes instead (Last Signal's islet and bank cover): one candidate per 3 × 3
columns between the undergrowth and the far shore, jittered, gathered into 5 m patches, off
tree trunks, other bushes and a step's last column. Up to 520 on desktop and 70 on phones.

## Wood and foliage

Wood is generalized cylinders: rings along each limb with parallel-transported frames, so tubes
never twist, with eight sides on a trunk and three or four on a limb (six and three on phones).
Only a mature spruce's main branches carry wood; the foliage hides its thin internodal ones and a sapling's branches. Bark colour
is per vertex: plates and furrows from the angle and height, the pine's orange upper trunk, and
the birch's pale skin and dark foot.
The local CC0 [Bark Brown 01](https://polyhaven.com/a/bark_brown_01) scan by Rob Tuytel adds
fine furrows, knots, roughness and shallow relief. The worker unwraps each tube around its
circumference and along its centreline, so grain follows bent trunks and inclined branches.
An integer number of wraps and duplicated seam vertices prevent a stretched stripe where
the texture closes. Length coordinates scale with tree placement, and each tube starts at a
different part of the scan. The coordinates remain attached during wind sway.
The scan modulates each species' palette: oak and conifers keep coarse furrows, while beech
and birch have shallower relief and a smoother finish. Species strength is explicit rather
than inferred from colour. Birch lenticels are fine, scattered horizontal dashes in the material
instead of broad, interpolated vertex bands; they repeat seamlessly and fade before they
become smaller than a pixel. A restrained, irregular
green patina darkens the first 90 cm above each root. Surface-gradient relief fades by 42 m
and uses the same mipmapped, anisotropic scan resources as the terrain. No additional scan
or draw is needed; duplicated seam vertices leave the triangle count unchanged.

Foliage cards keep their place on their twig, in model space, rather than facing the camera. Each
card's normal leans 65% toward the outside of its crown (from an axis through the crown's centre),
so a crown shades as one mass, and cards deep inside, near the trunk, keep a third of their value and the lower crown, shaded by the upper, a little less.
Colour takes the species' palette, a per-tree hue and value jitter and a small per-card hash.
Needle and leaf albedos keep little red and blue (about 0.03 and 0.02 against 0.06–0.09 green,
as measured on conifer needles), since the sky light and grade already desaturate them, and a
card's needle-to-needle tone stays within ±25%: a wider spread speckled sunlit tops pale.
A spruce's leader
is a dense spire of ten sprays, so its tip reads as needles against the sky rather than a few
cards the sky shows through. The material stays matte (roughness 0.84–0.98, a 45% sky reflection):
the atlas relief gives leaf centres a slightly softer sheen than their dry edges.

The atlas has twelve tiles (4 × 3): two oak sprays and two lime-and-beech sprays (twigs fanning up
from the card's foot, clothed in alternate, overlapping broad leaves: smaller and lobed for the
oak, broad and ovate for the others, so a card reads as a ragged, rounded mass of leaves), two Norway spruce sprays (a shoot across the top with combed,
needle-clothed branchlets hanging from it, each branchlet its own shade), two Scots pine tiles
(overlapping brushes of paired needles radiating round short shoot tips), two weeping birch tiles (slender hanging twigs
with small ovate leaves), shrub foliage and a lobed core disc. Desktop bakes 512-texel tiles
(2048 × 1536, about 0.37 s in the worker against 0.24 s for the eight tiles before); phones bake
256-texel ones (about 0.11 s). The worker also bakes the mip chain, each level's
alpha scaled per tile so the same share of texels passes the cutout as at full resolution
(Castaño, "Computing Alpha Mipmaps"): plain averaging thinned distant sprays into blur, and a
shader boost had filled whole cards into squares. Each
texel stores a palette-relative tone, a rounded relief (each needle and leaf a dome a few
texels across) and cutout coverage. Broad leaves also shade their fold and central vein into
the tone channel; this detail averages naturally through the existing mip chain. The relief's
screen-space slope tilts each card's normal
(the surface-gradient method of the terrain's detail relief), so a near spray shades as rounded
shoots rather than a flat card; mip levels flatten it with distance. Cards use an alpha test over that chain. Lighting adds a sky-light rim and
back-light translucency, strongest at the crown rim and against a low sun; transmitted light is
tinted yellow-green (chlorophyll passes green and some red and absorbs blue), so back-lit rims
glow rather than wash grey. Leaf-to-leaf tone stays within about ±35% of the palette (0.55–1.15):
a wider spread pushed sunlit leaves into the tone curve's shoulder. In a broadleaf clump the
palette follows the billow: fresh leaves on its sunlit top, deeper ones on its underside, and
inner cards a little darker, rather than a random patchwork of tones.

## Undergrowth

The foreground bank is a summer meadow sward of clumps (`grass.ts`), after Ghost of Tsushima's procedural
grass ([Wohllaib, GDC 2021](https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass)):
a clump, not a blade, sets height (each blade takes 80% of it), facing, lean, colour and dryness,
so the bank reads as tufts rather than combed hair. Clumps sit on a jittered 15 cm lattice, each
one of the shore's growth forms:

- short turf (bents, low fescues), 5–10 cm, about 22% of clumps, closing the ground between
  the others;
- wiry tufts (wavy hair-grass, sheep's fescue): needle-thin rolled leaves (1.6–2.8 mm before
  widening) in a fountain leaning outward from the clump's centre;
- flat-leaved tussocks (cocksfoot, meadow foxtail, sedges) in 3 m patches: 4–7 mm blades, 30–64 cm, that
  arch, twist up to a turn and a half and droop at the tip;
- rushes, near the water: round, upright, dark stems 35–60 cm;
- seed stalks over a sixth of the wiry tufts and a tenth of the tussocks: a bare culm with a
  narrow purplish-brown or silvery panicle.

Dead material keeps a real sward unkempt even in summer: 6–10% of the blades, plus a few percent
more in dry patches, are straw (some with a broken, blunt tip) or litter lying almost flat at the base
([Molinia](https://bsbi.org/learn/resources/plant-crib/molinia); standing litter weighs heavily
in a canopy's reflectance, [HAPEX](https://www.sciencedirect.com/science/article/abs/pii/0034425795001980)).
Albedos follow field measurements for fresh green leaves, about 0.06–0.08 green in visible light
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
level). Ferns (2% of lattice sites) break the sward, and meadow flowers gather in 2.5 m drifts (3–12% of
sites): mostly buttercups, with white ox-eye and campion, 20–42 cm tall. A triangle budget
(260k on desktop, 44k on phones), visited in a seeded scatter order, thins the bank evenly.

Placement reads the smooth ground's neighbouring 12.5 cm columns (a slope only counts as a step
beyond 5 cm per column of distance): clumps near a step or a wall shrink, and their blades turn
away from it, so none hangs over a drop; blades root only clear of the water. The material is
matte (a 35% sky reflection: a sward hides most blades from the sky behind its neighbours), and
thin blades pass a little light only when the view faces a low sun.

## Loading

The forest is part of the first frame, so trees never pop in after the loader. A world worker
of its own grows the forest (or reads it from the world cache) alongside the terrain and lake
surfaces and posts it as its own message; the engine waits for it after building the scene and
compiling the offscreen passes, adds the three meshes, gives their materials the scene's cloud
shadows, pointer light and fog hand-off, and compiles them for every view that draws them (main
view, mirror, environment probe and shadow maps) in the same sequence as the scene's shaders.
On a failed
preparation the scene simply loads without vegetation.

## Cost

The forest is three merged world-space meshes, so three draws: wood, foliage cards and
undergrowth. The undergrowth sits on `UNDERGROWTH_LAYER`, which only the main camera enables,
so the water reflection, the environment probe and the shadow pass never draw it. Wood and
foliage cast shadows through the shadow layer, with the cards' cutout. On seed 9182 the desktop
forest is about 341k triangles (wood, foliage cards and undergrowth about 72k, 148k and 121k) and
the phone forest about 89k; it prepares about a third slower than the boreal forest did (measured
side by side under load; about 1 s on desktop and 0.3 s on phones on the host). A broadleaf
clump draws about 17 cards per square metre of its radius: the cards cost fill, not triangles,
and 22 cost about a third more overdraw for no visible gain. With the meadow terrain, the larger cloud cube, the lens's
antialiasing and 170 trees, the host GPU (WebGL 2, 1280 × 720) measured the view pass at about
9.2 ms against 7.5–8.4 ms for the boreal shore. Raising the far banks into wooded hills (and two
tall domes behind the lake) cost about 2.7 ms more, for the forest it lifted above the mid-ground
crowns, so the relief stays as it was. Trees past 50 m from the camera use a far level of detail: half the
sprays drawn 30% larger, lighter wood, and no spruce branch wood under the foliage. Grass keeps
(4/d)^1.25 of a clump's blades. Spruce cores fill every third whorl and birches four inner cards:
with crowns this dense, large cards stacked deep inside cost more fill than they add. On the host
GPU (WebGL, 1600 × 900) the frame measures about 14.8 ms against 15.8 ms before these levels of
detail; the remaining cost of the forest is the fill of its alpha-tested cards, not triangles. The voxel trees it replaces drew 21k of wood and
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

## Roots and weathering

Wood rings have a shallow elliptical/lobed profile and gradual swellings, strongest on
fissured oak and conifer bark and subtler on beech and birch. Broadleaf and birch branch
collars widen through an extra shoulder ring. Nearby mature broadleaf models also carry
one or two short healed stubs with closed, lighter heartwood faces. The extra details retain
continuous bark coordinates and the existing species-specific relief.

Within 30 m of the resting camera (18 m on phones), exposed roots spread from the trunk's
flared foot and follow the sampled terrain, with their tips buried in the soil. Paths reject
water, steep/rocky ground and boulder footprints. Small grass tufts, folded brown leaves and
short twigs gather around these roots; nearby stones receive litter too. These additions use
the existing merged wood and undergrowth meshes rather than extra draws.

Vegetation shares the shore's retained rain moisture: bark darkens and becomes less rough,
while foliage darkens gently and gains a damp sheen. Patches follow the vegetation's rest
positions through wind deformation. Soaking takes seconds and drying takes minutes, using
the same clock and reduced-motion policy as the terrain.

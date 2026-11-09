# Terrain

The ground is a smooth heightfield with limestone boulders, shaded by a layered
material. It is what the scene renders and collides with, and the lake, the waterfall's pool,
the forest and the lanterns are all placed on it.

## Composition

`lake-world.ts` composes the lake as continuous fields and samples them straight onto the
corners of the terrain grid (25 cm on desktop, 28 cm on phones):

- a coast field, positive on land: two unequal left headlands around a deep inlet with a slim
  diagonal mouth, a recessed right bank under a high rear ridge, low distant islets and three
  detached mid-ground islets, with seeded coves. Phones squeeze it across, so both banks fit the
  portrait frame;
- a height field over the land: ridges, spurs, a rear slope and outcrops, broad and fine
  undulation, a bank lip at least 28 cm above the water, and a rounded dome on each islet (taller
  on phones, whose islets are under a metre wide) so its crown still carries a tree once smoothed;
- a rock share: a bare band along the shore and seeded outcrop patches;
- the low, broken shore that enters beneath the camera; on phones it reaches past the lens's
  axis, so the portrait frame has a grassy bank in its lower left rather than a sliver.

Stones set in the water (single blocks off the wet edge, broken fingers off the left headlands, a
few fixed rocks) are listed separately and become boulders; touching ones merge into one larger
block, and a stone touching the bank belongs to it. Lanterns pick ground with land on every corner
within a metre, well past their drift. The waterfall then picks a bank facing the camera with open water at its
landing (checked over the lake raster's own cells, so the coarse phone raster still sees water)
and carves its pool into the grid: a floor one cell under the pool's surface, a raised rim behind
the lip, terraces back into the bank, and a level sill just under the surface across the whole
sheet.

## Heightfield

`terrain-field.ts` shapes the composed corners into the final ground. Open water continues down
the lake bed's shelving profile, so smoothing shapes a beach instead of pulling the bank toward a
flat floor. Heights are then:

- blurred over about 0.5 m (three box passes), leaning back toward a 0.25 m blur where the source
  relief is over about a metre, so true cliffs stay steep;
- given gradient-damped relief (Quilez, [more noise](https://iquilezles.org/articles/morenoise/)):
  rounded granite knobs a few metres across, softer undulation and fine grain, strong on gentle
  ground, almost none on steep faces and none at the waterline, so the composed shore contour does
  not move.

Small, low specks of land the coast leaves in the water are lifted out of the field and become
boulders instead of soft bumps. Protected areas constrain the result: `exact`
keeps the waterfall's pool floor, sill and the face under it as composed, `raise` lets the pool's
rim never drop below its composed height (with a ragged crest) while its outer sides slope
naturally, and `water` keeps the plunge in front of the fall open.

## Mesh

`terrain-surface.ts` meshes every corner once (about 175k triangles on desktop, 45k on phones).
Each quad splits along its flatter diagonal, so ridges and gullies follow the relief, and quads
entirely under the water are dropped (the lake bed renders separately). A heightfield face is a
ruled plane, so steep faces are pushed in and out horizontally by 3D noise (about ±30 cm at a
couple of metres, plus finer octaves), except where the waterfall needs its face; normals are
then recomputed from the final triangles. A vertex attribute carries four bytes:

- rock share from the source materials, blurred;
- sky visibility: the heightfield's horizon in eight azimuths up to 7 m, times a soft disc of
  shade under each crown (darker and wider under the broadleaves' summer canopy and spruce),
  baked as ambient occlusion;
- curvature, positive in hollows;
- needle and leaf litter under each tree's drip line.

## Material

Local 1K CC0 scans from Poly Haven add grass blades, exposed earth and forest litter:
[Grass Ground](https://polyhaven.com/a/grass_ground) by Charlotte Baglioni and
[Forest Floor](https://polyhaven.com/a/forest_floor) by eye-candy.xyz. Their provenance and
processing are recorded in `src/assets/textures/terrain/sources.json`. Color uses sRGB WebP;
linear roughness and displacement share a 512px WebP's red and green channels. They load
before material compilation, with procedural shading as a fallback if an asset is unavailable.
World-space sampling blends two rotated scales to soften repetition. Scanned color,
roughness and relief follow the grass/litter masks; the distant canopy and wet banks retain
their own shading. Maps repeat with trilinear mipmaps and bounded anisotropy (8 on desktop, 4 on
phones) on both backends.

[Rock 01](https://polyhaven.com/a/rock_01) by Rob Tuytel adds weathered stone grain to the
cliffs, boulders and waterfall face. Three world-space projections blend by the fourth power
of the geometric normal, avoiding stretched cliff textures and visible projection seams.
The same scan drives color, roughness and near-surface relief, under the existing lichen,
joint, moss and wetness treatments. Moss caps pick up finer grass-scan texture. Grass uses
the scan's luminance contrast over the summer palette instead of inheriting the dry scan's
brown average, and forest litter is subdued to avoid bright orange islands under crowns.
Each scan can fall back independently when one of its files is unavailable.

`terrain-material.ts` builds the ground from what a temperate lake shows in summer at this scale,
with albedos in measured visible-light ranges (green grass 0.06–0.14, soil about 0.1, weathered
limestone 0.2–0.35):

- a fresh, yellow-green meadow sward, brighter where open sky reaches it, paler seeding grass in
  open, gentle patches, damp soil in hollows and leaf litter under the trees;
- rough, tussocky grassland in patches a few metres across on open, gentle ground: darker, bluer
  clumps over a clumpy grain, so slopes read as tall vegetation rather than a smooth carpet;
- drifts of buttercups over the open meadow: yellow heads a few centimetres across that blend to
  a faint golden cast once they fall below a pixel;
- past the mid-ground (48–95 m) a closed broadleaf canopy over the hills: dark billows a few metres
  across, sunlit on their tops, thinning into the meadow in slow patches and leaving outcrops bare
  (the modelled trees stop at the far shore);
- weathered limestone only on real outcrops (the sward holds on steeper ground than the old moss
  did), convex knobs and where the composition placed stone: a fine speckle, joint fissures a
  metre or two apart (in the albedo, so they read from afar after the relief has faded), pale
  lichen crusts, and dark rain streaks down the faces. Ivy, ferns and grass cling to the faces in
  ragged, mostly upright streaks, and thin vegetation creeps back over ledges;
- a narrow strip of gravel a hand's breadth above the water, then dark wet silt at the waterline,
  broken by noise; on a low, grassy bank the turf runs almost to the water;
- a slow tint across the hills hides repetition at 30–70 m.

Every Perlin octave is band-limited: it fades before a cell covers less than about two pixels
([Quilez, bandlimiting](https://iquilezles.org/articles/bandlimiting/)), so the grazing camera never
shimmers. Detail relief (grass tufts, rock grain, pebbles) is a world-space height turned into a
surface gradient, applied after differentiation so triangles never print through, as in three's
`TerrainGenerator`; it fades out by 42 m. The baked sky visibility is the material's ambient
occlusion and composes with the cloud shadows. Rain wetness (`shore-wetness.ts`), the sky fill on
steep faces, the pointer light and the reflection fog apply as to any scene material.

### Texture files

The scans are imported as content-hashed assets (`terrain-images.ts`, `new URL` literals), so
they are served `immutable` with the scripts and a new encoding never meets a stale cache. Their
download starts with world preparation, before the GPU device (`startSceneWorld`), at low fetch
priority so the landscape chunk and physics still arrive first; `createImageBitmap` decodes them
off the main thread, already flipped, and `terrain-textures.ts` only wraps the bitmaps once the
materials are built. Low-power devices (`isLowPowerDevice`) take half-resolution files.

| Set (8 files) | Color           | Surface                     | Transfer | GPU (RGBA8 + mips) |
| ------------- | --------------- | --------------------------- | -------- | ------------------ |
| Before        | 1024², WebP q84 | 512², lossless WebP         | 2.38 MB  | about 28 MB        |
| Desktop       | 1024², WebP q80 | 512², near-lossless 60 WebP | 1.76 MB  | about 28 MB        |
| Low power     | 512², WebP q80  | 256², near-lossless 60 WebP | 0.41 MB  | about 7 MB         |

Color is re-encoded from the 1K Poly Haven JPEGs (PSNR against the source 34.5–35.5 dB, against
36.0–37.1 dB at q84). The surface maps cannot use lossy WebP: its 4:2:0 chroma mixes the
roughness and height channels and its blocks print through the height gradient (35–41 dB);
near-lossless keeps them within 48–49 dB for 44% fewer bytes. Seed 42 at noon is
indistinguishable before and after on desktop (1280x720) and a Pixel 7 viewport, where the
phone's half-resolution set renders; the remaining pixel differences follow the animated water.

KTX2/Basis was evaluated and not adopted. ETC1S color (with mipmaps) is 0.70 MB against 1.19 MB
of WebP, but at 27.6–32.7 dB against the source (the rock scan loses the most); UASTC surface maps with RDO and
Zstandard are 0.98 MB against 0.57 MB. Three's self-hosted transcoder adds 245 KB of gzipped
WebAssembly plus 15 KB of script, compiled and run in a worker before any texture exists. The
net first-visit transfer would be about the same, for 21 MB less GPU memory on desktop (block
compression) and a quality loss; the low-power set already cuts GPU memory fourfold where it
matters most. Sampling is the same either way, so neither option changes the compiled programs.

## Boulders

`terrain-boulders.ts` places up to 320 boulders on desktop and 90 on phones: the composition's single
water stones (each its own size, shape and lean, from a hand or two out of the water to just
awash, and reaching below the wave trough), large
stones flanking the waterfall, waterline stones mostly on rocky banks, outcrops and scree on steep
or rocky ground, and rare glacial erratics on open ground. Placement is a seeded, ranked lattice, clear of
lanterns, trunks, the camera's own bank and the fall's corridor and landing, whose raster cells no
stone's waterline may reach. Each is one of eight
cleaved icospheres: low-frequency swelling, then seven to eleven joint planes that cut flat,
slightly rounded facets, a weathered fractal roughness, a flattened underside, partial burial and a lean toward the ground's
normal. Those big on screen (half-width over 1.3% of their distance, 2.2% on phones: 59 of 320 and 8 of
90 on seed 9182) use a four-times finer icosphere so joints show in their outline. They merge
into one static mesh (about 165k triangles on desktop, 44k on phones) with tone, moss bias and
height per vertex: grass and moss caps on upper faces (an outcrop in a meadow wears turf on every
ledge), a dark wet band at the waterline and soil at the foot.

## The waterfall's rock face

A heightfield has no vertices partway down a cliff, so the face under the fall's lip would be one
planar slope. `terrain-gorge.ts` lays a jointed limestone wall over the block the fall leaves from:
rays fan out in plan from a point behind the lip, round its front and both flanks, and each
column follows the heightfield's face down that ray. Blocky bulges, ledges a hand or two high and
vertical joints push it out; behind the water it stays 10 cm clear of the falling sheet, and it
tucks into the ground at the fan's ends and under the crest, so its edges never show. Spray wets
the face behind and beside the sheet (darker, glossier stone, no moss). It shares the boulders'
material and mesh: 3–7k triangles.

## Lake, physics and vegetation

The lake comes from the ground (`createLakeBedFromTerrain`): water wherever the ground lies below
the water line outside every boulder's waterline disc, and a signed shore distance seeded by the
linear crossing between samples, then propagated by chamfer sweeps. Each cell's obstacle is the
highest solid over it, ground or boulder top. The bed's depth, dunes and stones are unchanged, so
every water, fish and splash system reads the same rasters as before.

Rapier collides with a heightfield over the same corners and one convex hull per boulder; under
open water the heightfield drops away below the shore. A sub-millimetre offset keeps grid lines
off round coordinates: Rapier misses an exactly vertical ray lying on one. Cliffs are drawn
pushed in and out of the heightfield's faces, so the colliders replay the same displacement: the
displaced cells (about 1% of the corners on desktop, 4% on phones) collide as the drawn
triangles, a small triangle mesh, and the heightfield drops away under them. A horizontal ray at
a cliff lands on the drawn rock (it was off by 8 cm at the median and up to 59 cm before), and
building the colliders still takes about 50 ms on desktop and 15 ms on phones in Node.
The rain's broadphase is the highest solid per 2 m column. Trees grow on open ground above the
bank (not rock, not steeper than about 37°) and their trunks sit at the lowest ground under them;
lanterns keep their hover above the highest smoothed ground under their drift, and the undergrowth reads ground height
and softness (gentle, not rock, not under a boulder) per 12.5 cm column, treating a slope as a step only beyond 5 cm per
column of distance.

## Shadows and cost

The terrain and boulder meshes cast through the static shadow layer by sharing their geometry
with depth-only twins, so the moon map and lantern cubes still refresh only when lights move. On
seed 9182, the terrain and boulders total about 336k triangles on desktop (the voxel terrain with its
micro-voxels had 798k) and 87k on phones (146k), the waterfall face and the finer near boulders included. World preparation runs its two halves in parallel,
each composing the world again. Measured in Node (median of three runs), the terrain half takes
0.45 s on desktop and 0.07 s on phones, the surfaces half 0.44 s and 0.11 s; with the voxel
composition they took 1.25 s and 0.87 s on desktop, 0.27 s and 0.23 s on phones.

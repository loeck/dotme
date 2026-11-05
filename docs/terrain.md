# Terrain

The ground is a smooth heightfield with granite boulders, shaded by a texture-free layered
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
  shade under each crown (darker under spruce), baked as ambient occlusion;
- curvature, positive in hollows;
- needle and leaf litter under each tree's drip line.

## Material

`terrain-material.ts` builds the ground from what a Nordic lake shore shows at this scale, with
albedos in measured visible-light ranges (moss and conifer litter 0.04–0.12, soil about 0.1,
weathered granite 0.13–0.22):

- moss with brighter cushions where open sky reaches it, heath and straw-dry grass in open,
  gentle patches, damp peat in hollows and litter under the trees;
- dwarf-shrub heath in patches a few metres across on open, gentle ground: heather's purple-brown
  and bilberry's dark green over a clumpy grain, so slopes read as low vegetation rather than a
  smooth carpet;
- weathered granite on faces steeper than about 50°, convex knobs and where the composition placed stone:
  feldspar speckle, joint fissures a metre or two apart (in the albedo, so they read from afar
  after the relief has faded), muted lichen crusts and dark rain streaks down the faces. Thin
  vegetation creeps back over ledges;
- a narrow strip of gravel a hand's breadth above the water, then dark wet silt at the waterline,
  broken by noise; on a low, grassy bank the turf runs almost to the water;
- a slow tint across the hills hides repetition at 30–70 m.

Every Perlin octave is band-limited: it fades before a cell covers less than about two pixels
([Quilez, bandlimiting](https://iquilezles.org/articles/bandlimiting/)), so the grazing camera never
shimmers. Detail relief (moss tufts, rock grain, pebbles) is a world-space height turned into a
surface gradient, applied after differentiation so triangles never print through, as in three's
`TerrainGenerator`; it fades out by 42 m. The baked sky visibility is the material's ambient
occlusion and composes with the cloud shadows. Rain wetness (`shore-wetness.ts`), the sky fill on
steep faces, the pointer light and the reflection fog apply as to any scene material.

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
normal. They merge into one static mesh (about 100k triangles on desktop) with tone, moss bias and
height per vertex: moss caps on upper faces, a dark wet band at the waterline and soil at the foot.

## The waterfall's rock face

A heightfield has no vertices partway down a cliff, so the face under the fall's lip would be one
planar slope. `terrain-gorge.ts` lays a jointed granite wall over the block the fall leaves from:
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
seed 9182, the terrain and boulders total about 274k triangles on desktop (the voxel terrain with its
micro-voxels had 798k) and 72k on phones (146k). World preparation runs its two halves in parallel,
each composing the world again. Measured in Node (median of three runs), the terrain half takes
0.45 s on desktop and 0.07 s on phones, the surfaces half 0.44 s and 0.11 s; with the voxel
composition they took 1.25 s and 0.87 s on desktop, 0.27 s and 0.23 s on phones.

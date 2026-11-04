# Atmosphere

The artistic solar clock supplies sunlight, moonlight, sky color and local-light intensity.
Its orbit runs from the live weather's sunrise to its sunset (06:00–18:00 without live data),
starting at the weather location's local snapshot time unless `startTime` overrides it.
Clock speed affects the solar cycle only. Wind, rain, water and wildlife retain their own
physical time steps. Reduced motion freezes the initial atmosphere while allowing resize
and visibility refreshes.

## Sky and twilight

The daytime sky follows Hillaire, _A Scalable and Production Ready Sky and Atmosphere
Rendering Technique_ (EGSR 2020), with the paper's Earth parameters: Rayleigh and Mie
scattering, a tent-shaped ozone layer and a 0.3 ground albedo (`atmosphere-physics.ts`).
`SkyAtmosphere` renders three half-float LUTs with TSL fullscreen passes:

- transmittance (256×64) and multiple scattering (32×32), drawn once;
- a sun-relative sky view (192×108, 128×72 on low-power devices), redrawn whenever the
  sun moves. Its latitude mapping concentrates texels at the horizon.

Sunsets, the Earth's shadow, the Belt of Venus and the blue hour are therefore emergent
rather than painted. The sky material, distant ridges, horizon mist and the main view's
volumetric air all sample the same LUT, so the horizon behind terrain takes the sky's own
light in each direction. The solar disc uses Frostbite limb darkening, and Sæmundsson
refraction raises and flattens it near the horizon.

CPU lighting uses the same model. Direct sunlight is the atmospheric transmittance at the
viewer; cloud decks sample it at 2 km, keeping their afterglow once the ground is in
shadow. Sky irradiance and horizon radiance, which require multiple scattering, come from
`atmosphere-table.ts`. Regenerate it with `node scripts/atmosphere-table.ts && pnpm fmt`
after changing `EARTH`. A partial exposure adaptation (square root of the irradiance
ratio, capped at 48×) keeps twilight dim but readable; it applies to daylight sources,
never to moonlight or lamps.

## Weather and composition

A seeded shared wind field drives cloud displacement, water waves and environmental
motion. Cloud bodies and procedural noise derive from the world seed. Day/night lighting
and cloud transmission are expressed with TSL nodes rendered through WebGPU.
The cloud volume is captured at 15 Hz on desktop and 10 Hz on low-power devices. A
separate upper-sky texture records cursor passages while the left mouse button is held; the cloud
volume uses it to erode density with a noise-warped edge during capture. The texture is
anchored to world directions, so openings survive camera motion. Each texel heals on its own
clock, closing about three seconds after it was drawn, so older passages refill while new ones
stay open; releasing the button, leaving the sky or the canvas only ends the current stroke.
Reduced motion clears it.
Cloud transmission samples the opening at the actual cloud crossing of each light ray.
Direct shafts appear only when a passage also crosses the sun or moon direction.
Terrain shadow layers preserve independent visibility for shadow and main passes.

Profile contrast samples the rendered backdrop through the composition pipeline. The DOM
retains text, links, keyboard focus and screen-reader semantics. Cursor light is a subtle
nighttime effect; pointer interaction remains available in daylight.

## Cursor

With a fine hovering mouse the native cursor gives way, once the landscape is ready, to a
6 px light point with an ink edge (`scene-cursor.ts`); the same point is drawn by an inline
native cursor until then, and on blur, so the hand-off is invisible. Its position is applied on
every event and never eased. Only its shape moves: a trailing point follows the pointer with a
42 ms exponential lag (`cursor-motion.ts`), and their separation stretches the point into a
tail behind the motion, up to 2.1 times its length at area-preserving width, while its leading
edge stays on the hit point. The stretch grows with speed rather than snapping on at a crawl,
eases back by itself when the mouse stops and turns continuously when it reverses. Frames
advance the trail, taking the pointer to move linearly between them, so neither the event rate
nor the display rate changes the shape. Over links and buttons the point shrinks and opens into
a hollow 22 px ring that drifts at most 4 px behind it, so the label under the cursor stays
legible. A press tightens the point (and the ring), and a press on the landscape releases one
faint echo ring that widens and fades in 0.6 s, like the ripple the water answers with.
Reduced motion keeps the hit point and the ring state but drops the stretch, the drift and the
echo; touch and coarse pointers keep their native behaviour.

At night the cursor carries a lantern. The surface under it receives a soft pool of
irradiance (`pointer-light.ts`); when the cursor crosses a silhouette and the surface beneath
jumps in depth, the pool rekindles there instead of teleporting at full strength. Water is
almost purely specular and barely shows that diffuse pool, so the lake shader also reflects a
small lantern hanging 35 cm above the point: a glint just below it on screen that the waves
break into a short shimmering streak, the way the bank's lamps reflect. It is a few
instructions in the existing water material, with no extra pass.

Terrain follows Last Signal's ground. Tops and sides break into square micro-voxels about 6 cm
across (sides used to take horizontal strata, which drew every step as a line), each cell
shifting value by ±12% and hue slightly between moss and soil, fading out once a cell spans
under about two pixels (`terrain-detail.ts`). Mossy risers grade from a moss lip under the turf
to darker soil at the foot; past the foreground (over 8 m from z = 2) the moss climbs over the
whole riser, so distant hills read as continuous slopes rather than a staircase of dark stripes under green tops, and shore and rock risers toward wet stone,
from colours independent of the foreground framing dim. The probe lights tops from the bright
zenith, but a riser samples the dark horizon of islands and water, so a sky fill adds ambient-
tinted irradiance, through the diffuse BRDF and occlusion, peaking on vertical faces.

Step lips also carry real micro-voxels (`terrain-lips.ts`), so a step never ends on a ruled
edge. On a mossy ground voxel whose top is exposed, turf cells overhang each riser that drops
away by a third to three quarters of a cell, a third of them trailing a smaller cell one step
lower, and the odd stone rests against the foot of a riser that rises from its top. Cells are
about 6 cm near the camera; past z = -12 a 6 cm cell spans only a few pixels, so they take half a
voxel (12.5 cm) at about a third of the density, which notches the mid-ground hill crests and
breaks the lit lip lines. Their sides are earthier than their tops, like a clod's cut. Mobile
dresses only the foreground.

Every exposed top, whatever its material and distance, is also eroded into micro-columns
(`terrain-erosion.ts`). The top splits into a grid of 6 cm cells near the camera and in the
foreground, 12.5 cm on the mid-ground hills (two per 25 cm voxel) and 12.5 cm on the far 50 cm
voxels (four per side; two on phones). A column on the edge of a riser that drops away may sink
by a cell, near the camera sometimes two, so the step edge wears into notches and short
micro-steps; a column at the foot of a riser that rises from the top may carry a cell or two of
scree, so the inner corner fills in as the outer one wears away; and stone tops (shore, rock,
the wet stones in the lake) carry the odd loose block. Turf lip cells and stones skip columns
that sank or carry scree. Densities rise with distance (a third of the edge columns near the
camera, three fifths on the hills and far crests), because there a step is only one or two cells
high and dense micro-steps are what stop a slope reading as a staircase of whole voxels; phones
take about half. The mesher lowers the riser under each chip and closes the chip with a floor and
walls; pieces of an eroded top overlap by a millimetre inside the solid so their T-junctions
never open a crack. Chip floors keep 16 cm above the lake: lower chips on the shore steps showed
bright artifacts from the water at their floor. Two rules keep chips from reading as holes: neighbouring chips must open through a
common side (two chips opening through opposite sides of a thin voxel form a slot through the
hill), and below the camera's eye level a chip may not open through a side that faces away from
the camera, where it would only frame the bright lake beyond the crest; above eye level such a
chip frames the sky and notches the silhouette, which is the point. Scree likewise only leans on
risers that face the camera. All of it is render-only: collision, picking, the shadow-caster cubes
and the lake bed keep the whole voxels.

On seed 9182 the micro layers take the desktop terrain from 429k to 798k triangles (66k chips,
22.5k scree and loose blocks, 10k lip cells) and its mesh buffers from 25.7 to 47.9 MB, and the
mobile terrain from 98k to 146k triangles (5.9 to 8.8 MB); seeds 1 and 424242 land within 4%.
Measured in Node with interleaved runs, desktop terrain preparation went from 0.36-0.45 s to
0.58-0.73 s and mobile from 0.10 s to 0.12-0.16 s; the emission now writes typed arrays
directly, which pays for part of the extra geometry. See [performance](performance.md) for the
frame cost.

The fixed camera faces the low sun at both ends of the day, so the golden-hour look
(`scene-look.ts`) lifts saturation, contrast and warmth but keeps noon's exposure, haze
start and air density (5% thinner), with only a 10% lift of the forward glow. A thicker,
nearer haze there washed the islands and banks into one milky plane against the light.

Indirect terrain light, local reflections and weather remain artistic approximations.
Validate changes with seeded clear/cloudy captures at noon, sunrise (`startTime=06:00`),
civil twilight (`05:45`, `18:10`) and night, plus reduced motion and resize. See
[verification methodology](performance.md) for browser and GPU commands.

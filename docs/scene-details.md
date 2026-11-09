# Scene details

`SceneDetails` owns fish, caustics, fireflies, splashes and the optional waterfall. Its environment input is a bounded
rain intensity and daylight amount. The engine provides shared time, wind, pointer targets
and lighting. Detail materials use the common TSL rendering pipeline.

Fish follow seeded shoal paths over the lake bed. Pointer avoidance and dive behavior remain
CPU logic. Underwater appearance combines refraction, water clarity and wave-driven caustics.
Fireflies react to nearby input at night. Shore wetness retains moisture after rain stops.

A quick flick across the water throws a stone (`stone-skips.ts`). Its speed is read on the water
plane from the newest pointer sample at least 40 ms before the release, or from the press (moves
that arrive coalesced on a busy frame often sit on the release point and would read as no
motion); below 5 m/s a drag only stirs the surface. The stone is lobbed from a hand low and
right of the eye, lands where the flick ended and skips on in its direction: a first hop of 0.45
m per m/s of flick (2–11 m), each hop 70% of the last and a little quicker, until a hop falls
under half a metre or the next landing is not open water, where it sinks. Each touchdown is a
bounded local impulse in the wave field and a splash burst with its droplets and sound, plus a
tuned note (see [interaction sounds](living-landscape.md#interaction-sounds)) and, for a stone
thrown by touch, a vibration of 6–20 ms. Seven seconds after the first frame, a scene nobody has
pressed throws one stone by itself, with no text: the run across the lake is the invitation.
Reduced motion throws nothing, and switching to it drops a stone in flight.

A long, still press on the water charges a wave (`water-shockwave.ts`). After 0.45 s without
moving more than 12 px, a glowing ring gathers under the pointer, growing from 0.3 to 1.6 m over
1.6 s while faint ripples pulse under it every 0.3 s (the fish, drawn by the press, gather too).
Letting go releases one broad impulse in the wave field, 1.2–2.8 m wide and stronger for a fuller
charge, which rolls out to the banks and lifts what floats; six to ten splash bursts ring the
spot, the ring runs out to 7 m and fades in 0.7 s, the fish lose their bait, a low tuned note
sounds and, on touch, the hand gets a 20–50 ms buzz. A press that moves first stays a drag or a
flick, and a release under 15% charge is an ordinary tap. Reduced motion has no charge.

Moving the pointer produces a soft, local wind patch (`wind-gusts.ts`), 9 m in radius. Its push
follows screen velocity proportionally, up to full strength at 1600 CSS px/s, without a speed
threshold or an initial kick. Critically damped springs smooth both its position and its push,
preserving momentum through starts, stops and direction changes without oscillation. The stroke
is projected at one contact depth, so crossing a tree's silhouette cannot create a false velocity
along the view. A crown leans by at most 0.6 bend units (the sward takes 45%); the cursor adds no
rapid per-card vibration. The natural breeze and leaf flutter continue independently. Grass,
wood and foliage share the field with no extra draw. Reduced motion clears the push, and leaving
the scene lets it settle gradually.

Gusts tear leaves off the crowns (`falling-leaves.ts`): every crown band of the pick spheres
(radius 0.6 m or more) sheds at a rate set by the cursor gusts and, above a threshold, the ambient
gust patches over it, so a sweep strips a flurry and a squally spell drops a few leaves on its
own. Each leaf is a light plate integrated on the CPU (`leaf-physics.ts`): gravity, strong drag
across the blade and little along it (its flat terminal speed 0.75–1.35 m/s), a moment turning
the blade broadside to the airflow, vortex shedding that rocks it about its midrib and a little
Magnus side force, so it rocks, glides to and fro and spirals down; about three in ten are driven
past the broadside moment into autorotation and tumble end over end (spin capped at 16 rad/s).
The air it rides is the breeze, the gust patch and any cursor gust, which also lifts it a little.
The ground is cast against the Rapier statics (terrain heightfield and boulder hulls) when a leaf
starts and again after each 1.2 m of drift, or 0.3 m when low: a leaf lands on the slope it
meets, lying along it on the nearer face, and a strong cursor sweep lifts it off again. On the
lake it rides the live contact surface (waves, ripples, pointer and splash rings), lies on its
slope, slides down it and drifts with the wind and the cursor's gusts, rings a faint ripple as it
lands (at most one every 0.35 s), strands if washed onto a bank, and sinks a few centimetres as
it fades. Leaves rest 8–14 s, then shrink away over 1.6 s; when the pool is full the leaf
closest to fading is recycled. Leaves are mostly pale, yellowing greens with gold and a few
brown, larger with distance past 14 m so a far wood's flecks still read. One instanced draw of
up to 150 leaves (48 on phones and low-power devices, which also integrate at 30 Hz instead of
60 Hz), without per-frame allocation. Reduced motion sheds none and clears them.
The season scales the fall: in autumn a gust strips three and a half times as many leaves, and
every crown also lets a few go on its own (0.007 a second per metre of crown radius, more in a
breeze), coloured from yellows, coppers and russets with a few late greens; a winter gust finds
less than half as many, all dry browns ([seasons](vegetation.md#seasons)).

At night (daylight under 0.25) a double tap or double click on the water sets a paper lantern
afloat there (`lake-lanterns.ts`): a small drum that glows warm through the middle of its paper,
bright enough to bloom, and that the lake mirror reflects. Lanterns drift downwind at 3.5 cm/s
per m/s of wind, bob on the waves, turn slowly and stay put rather than ground on a bank. Six can
float at once, a seventh replacing the oldest; they kindle over about a second and are gone by
day. They light nothing around them, as a real light each would cost too much. A tap that throws
a stone or releases a wave does not count toward a double tap; reduced motion places none.

At night a mouse cursor held still for 1.2 s over the scene gathers the fireflies within 18 m
(`lake-fireflies.ts`): each fly blends from its flight path into its own small orbit about
0.9 m above what the cursor points at (radius 0.45–1 m, its own pace and height), joining at a
rate of 0.45/s and leaving at 1.2/s, so the swarm forms slowly and turns as a loose ball. While
gathered they no longer shy from the cursor. A click scatters them: each gathered fly gets an
outward kick and drifts home along its path. Reduced motion never gathers them.

By day a small flock of birds (`bird-flock.ts`) crosses the sky: the first about 22 s into the
visit, then every 55–95 s while daylight is above 0.35 and rain below 0.3. Its species
(`bird-species.ts`) is drawn by the season, the hour and the sky: crows and jackdaws (more in
winter and under overcast), black-headed gulls (white, pale grey mantle, black wingtips; hooded in
spring and summer), mallards (more within two hours of sunrise and sunset) and, in spring and
summer, swifts, most in the last hours before sunset. Crows leave a tall crown that projects
inside the frame, and a press on a crown (the pointer ray meeting a crown's pick sphere before
any ground) startles crows out of that tree. The crow leader climbs away from the viewer, first
above the tallest crown within 60 m by 4 m, turns wide over the lake and leaves over the far
hills, the birds keeping jittered slots of a loose wedge. Gulls drift in from one side, circle a
thermal 20–32 m out (all one way round, rising 0.25 m/s) and slide off over the hills after
23 s; mallards cross the view 22–40 m out, 2.4–4 m over the water (lifting over ground), in a V
or an echelon about a span apart, beating in step with the bird ahead a little later down the
line; swifts sweep in from high up and hawk over the near water, dashing between points for
20 s before climbing away.

Every bird steers like a boid: its goal (slot, thermal, or the next dash), separation from
flockmates within 1.8 spans (more for fast swifts), a little alignment and cohesion in the loose
gull and swift flocks, out and up from any crown within 1.5 m, and never below the water's 1.4–3
m floor; it cannot fly slower than half its cruise, and banks by its sideways acceleration
(tan φ = a/g). Wings beat in bursts with glides between (crows 3.6 beats/s with short glides,
gulls 2.8 with long glides on crooked wings, swifts 7 with sickle glides; mallards beat 5.2 times
a second and never glide); the downstroke takes 45–50% of the beat, and on the upstroke the hand
folds back and trails. Each bird has its own size (±10%), beat rate (±8%) and shade, and drakes,
hens and jackdaws their own heads. Birds are drawn 1.15–1.45 times life size (the swift most) so
a silhouette still reads at 20–40 m.

All birds are one instanced draw of a 49-triangle bird (`bird-geometry.ts`): a four-ring body
with a bill, a forked, square or rounded tail, and wings of an arm and a hand that the vertex
shader hinges at the shoulder and the wrist from per-bird pose attributes. The species rewrites
the vertex buffer and the plumage uniforms, never the program. The material (`bird-material.ts`)
is lit by the sun and the sky like the leaves, two-sided with a paler underwing, painted by region
(mantle, belly, head, bill, tail, dark wingtips); feathers are matte (grazing reflectance capped
at 0.12, so an edge-on black wing never reads as a pale streak, with a faint blue-purple gloss
on crows); thin wing feathers glow a little against the sun, a faint rim and a sky and water
fill keep a white underside pale in shade. Wings are cambered (the leading edge a tenth of the
chord up), so a wing seen edge-on stays a sliver. Birds take the scene's haze at 40% of its
density (the fog is tuned for kilometre-distant hills; at full strength it lifted a crow at 50 m
a third of the way to the sky's colour), so crows read near-black at noon and under overcast.
Flocks fade in (from the crown for crows) and out at the end. Reduced motion shows no birds.
`window.sceneFlock(species?, nearer?)` sends a flock at once for captures, like the benchmark
hooks.

### Seasonal wildlife

The season ([seasons](vegetation.md#seasons)) decides who is about. Winter halves the flock and
the rate flocks cross the sky (autumn takes 15% off). Fireflies glow on summer nights and at half
strength in late spring, and not at all in autumn or winter.

Bats hunt over the lake from about 20 minutes after sunset for the next hour (fading in from 14
to 28 minutes and out from 60 to 80), and again from 80 to 35 minutes
before sunrise (`dusk-bats.ts`). Six (four on low power) come out of the tree line one at a
time as activity rises and go back the same way; each patrols its own seeded beat over the near
water, 7.5–11 m up so it shows against the sky from the bank, turning for a new point every
0.22–0.75 s at 4.5–7 m/s, stooping now and then at prey and gliding briefly on spread wings. They
are noctule-sized (40 cm) dark silhouettes in one instanced draw; the wing beat (9 a second,
each bat its own rate) hinges the wings in the vertex shader. They keep to the warm half of the
year (hibernating in winter), stay in on rain, fog, snow, storms, strong wind or below about
6 °C.

On warm, dry, calm days (from 13 to 20 °C, wind under 3.5–6.5 m/s, daylight over 0.3; the
season's typical temperature stands in when the weather reports none) a couple of dragonflies
(one on low power) patrol the water just off the viewer's bank and a few midge swarms dance
over the shallows (`lake-insects.ts`). A dragonfly holds a point, trembling a centimetre or two,
for 0.7–2.6 s, then darts 1.2–3.6 m in a quarter to half a second and hovers again, never more
than 3.5 m from its patch; seen level from the bank it would be a line under a pixel, so it is
drawn tipped toward the viewer, a dark body with glassy wings a few pixels across. Midges loop
and bob in columns 1.4–2.6 m up, entirely in the vertex shader; they are nearly invisible until
the sun stands low ahead (forward scattering by their wings), when each catches the light as a
faint warm fleck against the shaded banks. Insects keep to the warm season (fully in summer,
60% in spring, 30% in autumn). Bats and insects are main-view only (no mirror, probe or shadow
draws), add three draws in all, compile with the scene before the first frame, and reduced motion
shows none.

Floating leaves slow down in sheltered shore pockets derived from the actual shoreline.
Only nearby pockets with a clear water path can influence them; a bank-parallel current
keeps a small gap from solid banks. Splash impulses can still disturb the leaves. The pool
holds four leaves on phones and seven on desktop, plus the buoy, within the water material's
eight contact slots. Shed leaves live for 100–130 seconds before fading and recycling, so
several can collect between falls. Airborne flutter stops when a leaf rests on land.

The world seed can select a supported left-bank waterfall with a clear landing in the lake.
An upstream rock basin contains a shallow pool and narrows into an open spillway at the lip.
The basin floor and banks belong to the generated terrain; its water feeds a volume of seeded
particles following ballistic trajectories with fresh seeded variation at each return. A shallow
animated lip overlaps their sources. The particles stretch along their velocity.
Local GPU passes reconstruct their surface depth and integrate the optical thickness of the
ellipsoids. A bounded bilateral filter smooths the surface while retaining gaps between streams.
The reconstructed surface is a blended standard material lit by the scene's lights and
environment; it does not use transmission, which would copy and mip the whole framebuffer
every frame for a fall a few dozen pixels wide. Its look follows Last Signal's water and real
falls rather than a uniform sheet. A procedural pattern carried by the water (each feature
leaves the lip at one time and reaches a given drop after free-fall time, so it accelerates and
stretches) keeps a smooth, dark, sky-mirroring tongue at the lip, breaks it into streaks within
half a metre and widens them into aerated columns towards the plunge, with darker turbid gaps
and frayed thin edges. Aerated water takes a smoothed, skyward-tilted sheet normal because
foam scatters the whole sky; the glassy core keeps fine vertical ridges that stretch sky
highlights into glints. The key directional light (sun by day, moon at night) also scatters
forward through foam, spray and mist with a Henyey-Greenstein phase, so a low sun behind the
fall lights its spray; lamps light all of it through the standard lighting. Procedural
patterns read the parcels' smooth grid position, not per-texel depth, and the thickness
capture is linearly filtered, so neither shows the capture's texels.
The cursor obstacle is narrow and moves without imparting its own velocity to the water, so quick
gestures cannot launch individual parcels across the scene.
Capture textures stay fixed at 192 × 192 pixels on desktop and 128 × 128 on mobile; their crop
follows the current parcel extents, including those displaced by the cursor. Only the main view
renders the fluid volume. Environment probes omit it to avoid self-refraction, and the lake mirror
sees a low-poly instanced curtain instead: one draw sharing the live parcel positions,
velocities and blocker foam, with the same streaks and core colour without the fine grain,
lit by the scene's lights with the same forward scatter. The reflected curtain parts and
closes around the cursor along with the main view. This avoids a second fluid capture and
filter sequence. Mist and spray stay out of the mirror; plunge foam and the basin still reflect.
This is an analytic flow representation, not a separate three-dimensional fluid solver.
Grouped parcel arrivals feed the existing water-normal buffer, wave solver and recycled splash
droplets. Cursor contact parts the curved flow and releases a few local fragments;
they do not create another simulation. Reduced motion freezes the particles and stops impacts.
Foam and spray at the foot sample the lake's shared wave field so the impact follows its surface.
The plunge pool has a churning boil the width of the fall, foam lines that fan out downstream,
tear into lace where two-scale clump and grain noise is low and decay with distance (after
Last Signal's foam breakup and half-life), and a faint pale plume of entrained bubbles under
them. Mist puffs born in the plunge roll outward and upward while growing and thinning, and a
thinner veil hangs on the lower fall. Spray droplets use Last Signal's pale spray tone and
gloss with a normal half towards the eye and half towards the sky, so they stay drops at night.
From the default low camera the pool is seen almost edge-on, so the boil and mist carry the
plunge; foam lines read as a bright band drifting downstream. Up close, two finer octaves
(about 3.5 and 1.5 cm cells, drifting with the foam and stirred by the boil) tear the lace edges
into fingers, pit the boil and shade bubble crests. Each octave fades out once its cells shrink
below about five pixels (`fwidth` of the pool coordinates), so at the default distance the foam
is unchanged and cannot shimmer; the detail is zero-mean, so fading it leaves the coverage alone.
It uses a lattice-periodic value noise (`tiledNoise`) so the fast-scrolling fine coordinates keep
the hash's arguments small.

The fall's pattern clock wraps every 600 s for the same reason. Each scrolled pattern repeats
after exactly the distance it travels in one period (`loopNoise` wraps the time axis of the
lattice, and `loopCells` rejects a scroll rate that would not loop), so the foam, streaks and
mist continue across the wrap instead of jumping.

Reduced motion keeps a quiet static composition. Disposal is idempotent and releases owned
resources. Tests consume public behavior and narrow interfaces rather than casting into
engine implementation fields. Deterministic motion, anatomy, collision and environment
mapping have unit tests; browser and GPU checks validate integration.

References: [GPU Gems' water caustics](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-2-rendering-water-caustics),
[GPU Gems' refraction](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-19-generic-refraction-simulation).
The waterfall rendering follows the depth/thickness approach described in
[Screen Space Fluid Rendering for Games](https://developer.download.nvidia.com/presentations/2010/gdc/Direct3D_Effects.pdf).
[Splash](https://github.com/matsuoka-601/Splash) provides a WebGPU reference implementation;
this scene uses its own TSL passes and a bounded bilateral filter.

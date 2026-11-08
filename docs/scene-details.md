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
own. Each leaf flutters down at 0.75–1.35 m/s, swinging side to side and sinking fastest through
the bottom of each swing (about a third tumble end over end instead), drifts with the breeze, the
gust patch and any cursor gust it meets, then lies on the ground, or floats and rings a faint
ripple on the lake (at most one every 0.35 s), for 5–9 s and shrinks away. Leaves are mostly pale,
yellowing greens with gold and a few brown, larger with distance past 14 m so a far wood's flecks
still read. One instanced draw of up to 160 leaves (48 on phones), simulated on the CPU; the ground
is cast once and again only after a 1.5 m drift. Reduced motion sheds none and clears them.

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

By day a small flock of birds (`bird-flock.ts`, nine, six on low power) crosses the sky: the
first about 22 s into the visit, then every 55–95 s while daylight is above 0.35 and rain below
0.3, each leaving a tall crown that projects inside the frame. A press on a crown (the pointer
ray meeting a crown's pick sphere before any ground) startles a flock out of that tree instead.
The leader climbs away from the viewer, first above the tallest crown within 60 m by 4 m, turns
wide over the lake and leaves over the far hills; each bird steers toward a jittered slot of a
loose wedge with its own response, so the flock stretches and bunches in turns, and any bird
within 1.5 m of a crown is pushed out and up, so the flock clears the woods rather than flying
through them. Birds are unlit dark silhouettes made of two hinged wings, beating 3.2 times a
second (a little faster climbing), as a crow or jackdaw does, and gliding for 1.4 s in every
2.8 s, each bird on its own rhythm; they bank into turns, fade in at the crown and out after
24 s. Reduced motion shows no birds.

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

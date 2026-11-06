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

By day a small flock of birds (`bird-flock.ts`, nine, six on low power) crosses the sky: the
first about 22 s into the visit, then every 55–95 s while daylight is above 0.35 and rain below
0.3, each leaving a tall crown that projects inside the frame. A press on a crown (the pointer
ray meeting a crown's pick sphere before any ground) startles a flock out of that tree instead.
The leader climbs away from the viewer, turns wide over the lake and leaves over the far hills;
each bird steers toward a jittered slot of a loose wedge with its own response, so the flock
stretches and bunches in turns. Birds are unlit dark silhouettes made of two hinged wings,
beating faster while climbing and gliding in between, banking into turns; a flock fades in at
the crown and out after 24 s. Reduced motion shows no birds.

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
sees a reflection-only ribbon instead: one small blended draw that follows the sheet's mean
trajectory (`waterfallDrift`) and widening and carries the same streaks and core colour without
the fine grain, lit by the scene's lights with the same forward scatter. Running the capture and
filters again for a view the waves distort beyond recognition would roughly double the
waterfall's cost. The ribbon does not part around the cursor. Mist and spray stay out of the
mirror as well; the plunge foam and the basin still reflect.
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

# Scene details

`SceneDetails` owns fish, caustics, fireflies, splashes and the optional waterfall. Its environment input is a bounded
rain intensity and daylight amount. The engine provides shared time, wind, pointer targets
and lighting. Detail materials use the common TSL rendering pipeline.

Fish follow seeded shoal paths over the lake bed. Pointer avoidance and dive behavior remain
CPU logic. Underwater appearance combines refraction, water clarity and wave-driven caustics.
Fireflies react to nearby input at night. Shore wetness retains moisture after rain stops.

The world seed can select a supported left-bank waterfall with a clear landing in the lake.
An upstream rock basin contains a shallow pool and narrows into an open spillway at the lip.
The basin floor and banks belong to the generated terrain; its water feeds a volume of seeded
particles following ballistic trajectories with fresh seeded variation at each return. A shallow
animated lip overlaps their sources. The particles stretch along their velocity.
Local GPU passes reconstruct their surface depth and integrate the optical thickness of the
ellipsoids. A bounded bilateral filter smooths the surface while retaining gaps between streams.
The reconstructed physical material uses the scene's lighting, refraction and environment.
The cursor obstacle is narrow and moves without imparting its own velocity to the water, so quick
gestures cannot launch individual parcels across the scene.
Capture textures stay fixed at 192 × 192 pixels on desktop and 128 × 128 on mobile. Main and
reflected views reuse those allocations; their crop follows the current parcel extents, including
those displaced by the cursor. Environment probes omit the fluid to avoid self-refraction.
This is an analytic flow representation, not a separate three-dimensional fluid solver.
Grouped parcel arrivals feed the existing water-normal buffer, wave solver and recycled splash
droplets. Cursor contact parts the curved flow and releases a few local fragments;
they do not create another simulation. Reduced motion freezes the particles and stops impacts.
Foam and spray at the foot sample the lake's shared wave field so the impact follows its surface.

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

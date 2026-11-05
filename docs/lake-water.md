# Lake water

Water uses a damped linear surface-wave approximation and a shared analytic wind field.
The persistent height/velocity state advances at a fixed time step through TSL passes on
two alternating WebGPU render targets.
Pointer impulses have bounded strength and a volume-balanced pressure profile.

The terrain mask reflects waves at banks and the outer border absorbs outgoing waves.
The transferred depth atlas slows propagation and increases damping in the shallows,
so an approaching crest loses energy before it reaches the shore.
The surface combines simulated gradients and directional wind waves with reflections,
refraction, caustics and direct light. Textures retain explicit color-space, depth and
orientation handling across passes. Rain and pointer interactions remain independent inputs.

Wind waves use crossing directions and shorter transverse packets at small wavelengths. Below the
reference wind every band scales with the filtered wind, so calm air leaves a nearly still lake;
above it long waves grow more slowly than short ones. Capillary ripples follow the wind alone:
rain adds rings and roughness, not travelling waves.
Shading-only capillary ripples are 32 seeded downwind components with cos⁸ spreading and a
near-saturated spectrum, so no crossing pair dominates the slope and draws a lattice; they fade with
the pixel footprint, sharpen glints and break up reflections without changing the shared height field.
Rain adds a jittered field of expanding rings whose density follows rain intensity, roughens the
whole surface so reflections dull, and turns rings below a pixel into roughness and brief impact
specks instead of aliasing. Sun glitter, subsurface glow and shafts are direct sun
and follow the cloud shadow. The water is a humic
boreal lake's, not a tropical one: dissolved organic matter absorbs blue strongly, so clear water
absorbs about (0.40, 0.29, 1.05) per metre in red, green and blue (a440 about 1.2 /m with a
0.015 /nm spectral slope, plus pure water's red absorption), and rain-murky water more
(0.85, 0.7, 1.5). Light through it turns tea-amber over the pale sand of the shallows, and the
scatter body, dim and olive-brown, darkens toward near black with depth: brown-water lakes in
Finland and Estonia have Secchi depths of about 2 m ([Arst et al. 2008](https://www.borenv.net/BER/archive/pdfs/ber13/ber13-133.pdf);
[Thrane et al. 2014](https://link.springer.com/article/10.1007/s10021-014-9776-2)). Near the
camera the reflection is held below Fresnel so the shallow bed shows through, but only down to
0.4: at 20–30 m from a 2.5 m eye Fresnel is already 0.3–0.5, and the dark water hides its bed
past a couple of metres anyway. Light reaching the bed is attenuated by depth on the way down
as well as up. Daylight glitter and an amber-olive subsurface glow sit on top of the reflected
and transmitted light. At night the glitter and short capillary glints fade, leaving a softer
moon reflection; the bed takes a dim tint that fades with depth, so only the shallows stay
visible over near-black water. Shoreline
foam is a bright animated band whose width follows wave arrival. Calm water leaves only a trace
of it in patches; far away, where the band is held at a pixel and a half so it does not alias,
its strength falls in proportion, so the foam keeps its true amount instead of outlining every
shore in white.

The bed capture carries a simple seabed: dune relief in the depth field, wave-ripple
stripes on the sand albedo, dark meadow patches aligned with instanced seagrass tufts that
sway in the vertex shader between 0.8 and 2.6 m deep, instanced rocks from the lake-bed
stones plus larger separated hero rocks, and a spotted ray gliding a deep-water circuit
with damped vertical follow and a blob shadow on the sand. Bed props share the capture layer, lighting, cloud shadows
and caustics with the floor; the ray rides the fish layer so it refracts like the shoals, towing a Kelvin V wake with transverse arcs and foam.
Daylight god-ray shafts drift in the water column where the view looks down into mid depths. Refraction bends with depth-gated wave slopes and a chromatic offset on desktop, reflection distortion calms with distance, and sun glitter fires thresholded HDR sparkles over its lobe.
The analytic wind field drives CPU motion, surface normals and caustics; the GPU field adds
recent impulses to the visible surface. Reflection filtering follows
the water roughness without an additional blur floor; the environment probe uses 256-pixel
faces on desktop and 128-pixel faces on mobile.

The solver does not model nonlinear breaking waves or volumetric fluid flow. Its
depth response is a bounded shallow-water approximation rather than a full dispersion
model. Catch-up is bounded to prevent an unresponsive frame from creating an unstable burst.
World generation and interaction sampling remain on the CPU; scene composition and water
passes use node materials.

Rapier couples rigid bodies to the surface without stepping the wave field itself. A
bounded CPU contact sampler combines the wind field with recent GPU-bound impulses; it
provides the height for rain, pointer hits, droplets, curtain landings and buoyancy without
reading the GPU field each frame. Pointer bursts start a local surface wave immediately and
shove a floater only when the impact footprint touches its hull. Propagating waves move
floaters through buoyancy as they arrive. Floaters
join the fish capture, so their submerged half refracts through the surface, and each reports its
waterline circle so the lake draws a thin meniscus ring where it crosses the moving surface.
Shore splashes and pointer bursts fly droplets as dynamic
bodies whose water landings return impulses to the field. Terrain collision events supply
near-shore impacts. The buoy and drifting leaves receive buoyancy and drag at several body
points, allowing torque from uneven waves. Continuous collision detection is enabled only
for curtain parcels near the moving blocker. Foam flecks advect on the CPU with wind and
slope currents and collapse against the shore distance field.

Unit tests cover equations, fixed-step behavior, impulse bounds, shore handling and wind.
`pnpm e2e:gpu` requires a genuine WebGPU adapter. Use the production benchmark to
inspect seeded water at rest, during interaction and in rain; compare like-for-like captures.

References: [Evan Wallace's water](https://madebyevan.com/webgl-water/),
[GPU Gems' 2D wave equation](https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-44-gpu-framework-solving),
[fixed time steps](https://gafferongames.com/post/fix_your_timestep/).

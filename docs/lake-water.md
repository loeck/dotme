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

Wind waves use crossing directions and shorter transverse packets at small wavelengths.
Shading-only capillary ripples follow the wind and fade with the pixel footprint; they sharpen
glints and break up reflections without changing the shared height field. Clear water keeps
strong red absorption over pale sand for a turquoise tint, the scatter body darkens toward
deep teal with depth, reflectance near the camera is capped lower so the bed stays visible,
and light reaching the bed is attenuated by depth on the way down as well as up. Daylight glitter
and a turquoise subsurface glow sit on top of the reflected and transmitted light. At night the
glitter and short capillary glints fade, leaving a softer moon reflection. The bed takes a dim
blue tint that fades with depth, so only the shallows stay visible over navy water. Shoreline
foam is a bright animated band whose width follows wave arrival.

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
reading the GPU field each frame. Shore splashes and pointer bursts fly droplets as dynamic
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

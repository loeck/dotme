# Lake water

Water uses a damped linear surface-wave approximation and a shared analytic wind field.
The persistent height/velocity state advances at a fixed time step through TSL passes on
two alternating WebGPU render targets.
Pointer impulses have bounded strength and a volume-balanced pressure profile.

The terrain mask reflects waves at banks and the outer border absorbs outgoing waves.
The surface combines simulated gradients and directional wind waves with reflections,
refraction, caustics and direct light. Textures retain explicit color-space, depth and
orientation handling across passes. Rain and pointer interactions remain independent inputs.

Wind waves use crossing directions and shorter transverse packets at small wavelengths.
The same field drives CPU motion, surface normals and caustics. Reflection filtering follows
the water roughness without an additional blur floor; the environment probe uses 256-pixel
faces on desktop and 128-pixel faces on mobile.

The solver does not model breaking waves, depth-dependent dispersion or volumetric fluid
flow. Catch-up is bounded to prevent an unresponsive frame from creating an unstable burst.
World generation and interaction sampling remain on the CPU; scene composition and water
passes use node materials.

Unit tests cover equations, fixed-step behavior, impulse bounds, shore handling and wind.
`pnpm e2e:gpu` requires a genuine WebGPU adapter. Use the production benchmark to
inspect seeded water at rest, during interaction and in rain; compare like-for-like captures.

References: [Evan Wallace's water](https://madebyevan.com/webgl-water/),
[GPU Gems' 2D wave equation](https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-44-gpu-framework-solving),
[fixed time steps](https://gafferongames.com/post/fix_your_timestep/).

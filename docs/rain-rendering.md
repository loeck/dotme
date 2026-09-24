# Rain

`RainSimulation` advances world-space droplets at a fixed 120 Hz. One world unit represents
one metre. Segment/voxel collisions retire drops and create pooled impacts; catch-up and
pool capacities are bounded. Horizontal wind, drop size and emission respond to the weather
state. Reduced motion suppresses rain; hidden pages pause updates.

`RainEffect` translates simulation state into node materials for streaks and surface impacts.
TSL composition handles depth occlusion and the appearance of impact waves on WebGPU. Water collision uses the mean lake plane while visible
surface effects follow the shared wave fields. This is an artistic rain approximation, not
volumetric optical scattering or a fluid solver.

The public rain state accepts intensity in 0–1 and horizontal wind bounded to ±20 m/s.
Non-finite inputs fall back to defaults. Zero intensity clears pending events and avoids
unnecessary simulation work. Disposal releases all owned geometry, materials and targets.

Unit tests cover wind response, deterministic stepping, segment collisions, shelters,
impacts and bounded pools. Browser verification covers rainy scenes and reduced motion; explicit GPU tests validate the node pipeline. Prolonged sampling belongs in
`pnpm benchmark:scene`.

References: [Garg and Nayar's rain streaks](https://cave.cs.columbia.edu/Statics/publications/pdfs/Garg_TOG06.pdf),
[dynamic rain effects](https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/),
[capillary rings](https://doi.org/10.1017/S0022112088003301).

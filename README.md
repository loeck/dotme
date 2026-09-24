# loeck.me

Static personal site built with Vite, HTML, TypeScript, Tailwind and Three.js. The profile, social
icons and SEO metadata are in the HTML and work without JavaScript. The procedural voxel lake
loads through a dynamic import. Each visit gets a fresh landscape seed.
Add `?seed=42` to the URL to reproduce one composition.

## Requirements

- Node.js 24.21.0
- pnpm 12.5.1

## Development

```sh
pnpm install
pnpm dev
```

For parallel visual work, start each preview with `pnpm dev --port 0`. Vite prints the free port it
selected, so agents can capture separate previews without a shared fixed port.

## Live lighting

Moonlight and lamps cast shadows on the voxel scenery and water. Each animation
frame updates the light state, shadow maps, a six-face environment capture, and the lake's planar
reflection before the final lens pass. Floating light cubes, halos and water highlights share the
same light intensity. Voxel materials store base colors without baked lamp illumination.

Wet banks, dry ground and stone have different roughness. The water evaluates live lights
and their shadows with a GGX specular response; waves and pointer ripples distort the reflected scene.
The lake combines a directional wind spectrum with a persistent GPU height/velocity field
(1024² desktop, 512² mobile), stepped at 60 Hz independently of the display rate. Twelve wave
components form curved, localized packets; their analytic gradients preserve fine ripples at
mobile resolution. A volume-balanced pressure profile is sampled along pointer strokes, with
bounded input strength. A nine-point stencil propagates and combines waves; the terrain mask
reflects them at banks and an absorbing border prevents waves returning from the outer domain.
Hover subtly reveals the shallow, refracted lake bed. Dragging strengthens the wake and preserves
the general camera parallax. See the rendering notes below for physical parameters and limitations.

The solver is a damped linear surface-wave approximation with constant propagation speed. It does
not model depth-dependent dispersion, breaking waves or volumetric fluid flow.

References: [Evan Wallace's WebGL Water](https://madebyevan.com/webgl-water/),
[GPU Gems: the 2D wave equation](https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-44-gpu-framework-solving),
[Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/).

Solid surfaces use one shared, filtered environment probe, so their reflections approximate local
parallax. The probe excludes the lake to avoid recursive reflections; the lake uses its own reflected
camera. This is a rasterized rendering pipeline with approximate indirect illumination.

Voxels are instanced in spatial batches so shadow cameras can cull distant terrain. Mobile uses
smaller shadow maps and reflection targets; every rendered frame still refreshes lighting and
reflections. Reduced motion freezes the simulation while allowing pointer lighting and refreshes
on resize or visibility changes. A luminous cursor softly lights the terrain and water; its smoke
and tilt pause when hidden or reduced motion is enabled.

## Verification

```sh
pnpm check
pnpm exec playwright install chromium webkit
pnpm e2e
```

See [lake rendering notes](docs/lake-water.md) for physical parameters, input behavior,
GPU validation, performance methodology and approximations.

## Vercel

Import the repository in Vercel with the repository root as the project root. `vercel.json` selects
Vite and publishes the static `dist` directory. No server functions or SPA rewrites are needed.
Vercel serves `404.html` for unknown paths; development and preview use the same page with HTTP 404.
Other static hosts should also be configured to serve that page with a 404 status.

See [bundle measurements](docs/bundle-size.md) for the initial and total JavaScript comparison, and
[Paris weather access](docs/paris-weather.md) for the optional, on-demand Open-Meteo module. Weather
is not called or displayed by the site.

See [atmosphere notes](docs/atmosphere.md) for the shared wind, volumetric cloud rendering,
quality profiles and before/after performance measurements.

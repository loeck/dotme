# JavaScript budget

Run `pnpm build && pnpm bundle:size`. The report follows the emitted manifest's static
imports, includes inline bootstrap JavaScript, and reports deferred resources separately.
Every resource required before the first loader image counts toward the
**260,000-byte gzip first-render budget** (`firstRender`): the entry's JavaScript and its
static imports, including every bundled part of the Three.js runtime, the inline bootstrap
script and the render-blocking stylesheets linked from `index.html`. Stylesheets were added
to this figure without changing the budget; they add about 5 kB gzip. Each figure also
reports brotli (quality 11), the encoding most CDNs serve; the budget stays on gzip.

A second, informational figure (`readyPath`) sums everything the scene needs before it is
ready: the first-render set, the landscape chunk and its static imports, the weather
modules, the world worker and Rapier (its JavaScript and its WebAssembly file, matched by
name). It has a generous **2,000,000-byte gzip ceiling** that only catches accidental
multi-megabyte regressions; Rapier's WebAssembly is most of it. Terrain textures are images
and are not counted.

The loader entry must not statically import landscape materials, weather, world generation
or audio. It does start world preparation (`scene-world.ts`, `prepare-world.ts` and the
world cache helpers, a few kilobytes) before the GPU device: three instances of the same
deferred, content-hashed worker chunk; its size counts once in the report, but each instance
parses it. World preparation also starts the terrain texture downloads
(`src/scene/terrain-images.ts`, hashed images fetched at low priority and decoded with
`createImageBitmap`), so they overlap device creation too. The weather request starts at the
same moment through a dynamic import of `src/weather/scene.ts`, a separate chunk of a few
kilobytes, so the entry never carries the weather code while the request no longer waits for
the landscape chunk. The synchronous fallback for browsers without workers imports the
generator dynamically. Landscape code is dynamically imported after the first loader frame,
and shared Three.js/TSL modules must resolve to one runtime instance. Inspect both the
manifest graph and HTML module preloads when changing chunk configuration.

Compression size is a transfer estimate, not a startup-time measurement. Use the browser
suite to verify that a delayed landscape request cannot delay the loader's first frame,
and the benchmark for observed startup timing. Record fresh measurements with the build
instead of preserving outdated comparison numbers in documentation.

The Vite manifest (`dist/.vite/manifest.json`) exists for this report only. Vercel's build
command deletes it after the build, so it is never deployed.

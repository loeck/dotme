# JavaScript budget

Run `pnpm build && pnpm bundle:size`. The report follows the emitted manifest's static
imports, includes inline bootstrap JavaScript, and reports deferred resources separately.
Every JavaScript resource required before the first loader image counts toward the
**260,000-byte gzip initial budget**, including every bundled part of the Three.js runtime.

The loader entry must not statically import landscape materials, weather, world workers
or audio. Landscape code is dynamically imported after the first loader frame, and
shared Three.js/TSL modules must resolve to one runtime instance. Inspect both the
manifest graph and HTML module preloads when changing chunk configuration.

Compression size is a transfer estimate, not a startup-time measurement. Use the browser
suite to verify that a delayed landscape request cannot delay the loader's first frame,
and the benchmark for observed startup timing. Record fresh measurements with the build
instead of preserving outdated comparison numbers in documentation.

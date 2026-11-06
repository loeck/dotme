# JavaScript budget

Run `pnpm build && pnpm bundle:size`. The report follows the emitted manifest's static
imports, includes inline bootstrap JavaScript, and reports deferred resources separately.
Every JavaScript resource required before the first loader image counts toward the
**260,000-byte gzip initial budget**, including every bundled part of the Three.js runtime.

The loader entry must not statically import landscape materials, weather, world generation
or audio. It does start world preparation (`scene-world.ts`, `prepare-world.ts` and the
world cache helpers, a few kilobytes) before the GPU device: three instances of the same
deferred, content-hashed worker chunk; its size counts once in the report, but each instance
parses it. The synchronous fallback for browsers without workers imports the generator
dynamically. Landscape code is dynamically imported after the first loader frame, and
shared Three.js/TSL modules must resolve to one runtime instance. Inspect both the
manifest graph and HTML module preloads when changing chunk configuration.

Compression size is a transfer estimate, not a startup-time measurement. Use the browser
suite to verify that a delayed landscape request cannot delay the loader's first frame,
and the benchmark for observed startup timing. Record fresh measurements with the build
instead of preserving outdated comparison numbers in documentation.

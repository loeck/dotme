# Static migration: JavaScript size

Measured on 2026-09-24 with Node 24.21.0, pnpm 12.5.1 and Vite 8.3.0. The baseline is
`aa86158` (`feat/procedural-microvoxel-lake`), built before the migration with its frozen lockfile.
The comparison uses production client assets only; server bundles, CSS, HTML and source maps are
excluded. Gzip uses Node's `gzipSync` default compression, separately per file, then sums the sizes.
These numbers can differ slightly from Vite's own compressed-size reporter.

| JavaScript scope | Before, bytes | After, bytes | Reduction |
| ---------------- | ------------: | -----------: | --------: |
| Initial, raw     |       348,275 |        6,000 |     98.3% |
| Initial, gzip    |       111,242 |        2,573 |     97.7% |
| Total, raw       |       971,924 |      629,649 |     35.2% |
| Total, gzip      |       273,007 |      164,338 |     39.8% |

“Initial” means module scripts and modulepreload links in the document, including their static
imports. It excludes dynamically imported chunks. The landscape import still starts automatically
when the entry runs: this is **not** a claim that the entire initial visit transfers only 6.0 kB.
“Total” counts every emitted client JavaScript chunk once, including the mouse-only cursor smoke.
There is no weather chunk or weather call: that module is not imported by the application.

| Chunk            | Before, raw / gzip bytes | After, raw / gzip bytes |
| ---------------- | -----------------------: | ----------------------: |
| Entry            |        339,942 / 107,926 |           6,000 / 2,573 |
| React route      |            8,333 / 3,316 |                 Removed |
| Landscape engine |          85,394 / 28,025 |         85,394 / 28,025 |
| Three.js         |        534,750 / 132,232 |       534,750 / 132,232 |
| Cursor smoke     |            3,505 / 1,508 |           3,505 / 1,508 |

The three dynamic chunks retain their exact content hashes. The CSS also retains its original hash.
The remaining >500 kB chunk warning comes from Three.js; it remains dynamically imported.

Reproduce the current measurement:

```sh
pnpm build
pnpm bundle:size
```

The script accepts another asset directory and an optional HTML file. To reproduce the old build,
check out `aa86158` separately, install with the frozen lockfile, build, start its preview server,
and save the rendered home page as `before.html`. Run the current measurement script against it:

```sh
node scripts/bundle-size.mjs /path/to/baseline/.output/public /path/to/before.html
```

## Integration with performance, solar lighting and rain

The original tables above describe `feat/bundle-size` alone. After merging all three
feature branches into `feat/perf-1`, the initial JavaScript is 6,529 bytes raw /
2,790 bytes gzip. Total emitted JavaScript, including the world-generation Worker,
is 802,860 bytes raw / 217,582 bytes gzip. React remains removed; Worker preparation,
adaptive profile contrast, the night cursor and rain URL controls are preserved.
The solar and rain effects change the engine chunks, so the unchanged hashes noted
above apply only to the original standalone migration.

## Verification

`pnpm check` passes: TypeScript, lint, formatting, 92 unit tests and production build.
The complete Playwright run passes 37 tests across desktop Chromium and mobile WebKit;
the mouse-only smoke test is intentionally skipped on mobile. After review, 19 home tests pass
on both browsers (plus that mobile skip), including preserved random seeds on page restoration
and disposal while the landscape module is still loading.

Coverage includes the profile without JavaScript, document metadata, 404 status/navigation,
missing WebGL, reduced motion and preference changes, pointer and touch interaction,
page cleanup/restoration, and the existing GPU water/cloud tests. The weather suite uses
simulated responses for conditions, unknown codes, mixed precipitation, invalid data/units,
HTTP/network/JSON errors, timeout during fetch/body reads, and cancellation. Browser tests
also check that the page makes no Open-Meteo request. Development URLs were checked separately:
`/` returns 200 and unknown nested paths return the custom page with 404.

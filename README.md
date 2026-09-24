# loeck.me

A static personal site with a procedural voxel lake, live weather and ambient sound.
The profile, links and metadata are HTML and remain available without JavaScript.

## Development

Use Node.js 24 and pnpm 12.5.1. The exact runtime is pinned in `package.json`.

```sh
pnpm install
pnpm dev
```

`pnpm build` produces `dist/`; `pnpm preview` serves that build locally. Deploy `dist/`
to a static host. `vercel.json` provides the Vercel configuration; other hosts should
serve `404.html` with HTTP status 404 for unknown paths.

## Commands

| Command                | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `pnpm check`           | Strict types, typed lint, formatting, unit tests, build and loader budget  |
| `pnpm bundle:size`     | Measure compressed JavaScript and enforce the initial loader budget        |
| `pnpm e2e`             | Essential Chromium and mobile WebKit journeys against the existing build   |
| `pnpm e2e:extended`    | Additional weather, cursor, audio and accessibility regressions            |
| `pnpm e2e:gpu`         | Explicit GPU validation; WebGPU scenarios require an actual WebGPU backend |
| `pnpm benchmark:scene` | Separate prolonged scene sampling and screenshots                          |

Install browser binaries once with `pnpm exec playwright install chromium webkit`.
Build before browser tests and benchmarks. Failure traces and screenshots are retained
in `test-results/`. Browser test time limits exclude dependency installation.

## Architecture

The initial entry loads a minimal TSL loader and Three.js runtime. Its first presented
frame starts the dynamic landscape import. The loader and landscape share one canvas,
one initialized `WebGPURenderer` and the same runtime. Browsers without a working WebGPU
adapter render the same scene through the renderer’s WebGL 2 backend; only browsers
without either display the static profile. Graphics failures also release the profile.
World generation runs in its own worker; weather and audio remain independent resources.

`src/components/` owns page lifecycle and accessible controls. `src/scene/` contains
world preparation, CPU simulation, TSL materials and composition. `src/weather/`
validates the remote weather response; `src/audio/` handles decoded clips and scheduling.
Initialization has a 20-second deadline; the HTML bootstrap releases the profile even
when the main module cannot load.

The scene accepts four URL parameters:

| Parameter     | Example          | Meaning                                              |
| ------------- | ---------------- | ---------------------------------------------------- |
| `seed`        | `42`             | Reproduce a landscape composition                    |
| `coordinates` | `48.8566,2.3522` | Weather location; defaults to Paris                  |
| `startTime`   | `08:30`          | Initial artistic solar clock; defaults to local time |
| `timeScale`   | `20`             | Solar cycle multiplier, clamped to 1–100             |

Weather is live and independent of the artistic solar clock. Reduced motion renders a
static TSL loader and freezes scene motion. Audio follows browser autoplay rules and
can be controlled by the speaker button.

## Contributing

Keep changes scoped and include relevant behavioral validation. Use explicit types and
validated `unknown` values at boundaries; casts, `any`, non-null assertions and TypeScript
error suppressions are prohibited. Prefer minimal public interfaces for test doubles.
Run `pnpm check`, `pnpm bundle:size` and the relevant browser suite before proposing a change.

See [rendering architecture](docs/architecture.md), [verification](docs/performance.md),
[weather integration](docs/paris-weather.md) and [audio provenance](docs/living-landscape.md).

## License and attribution

Project code is [MIT licensed](LICENSE). Preserve the [Three.js notice](public/licenses/three.txt),
the recording provenance in [audio sources](public/audio/sources.json), and the visible
[Open-Meteo attribution](docs/paris-weather.md). Those external assets and data retain
their own license terms.

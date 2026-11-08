# loeck.me

A static personal site with a procedural lake landscape, live weather and ambient sound.
The profile, links and metadata are HTML and remain available without JavaScript.

## Development

Use Node.js 26.13.0 and pnpm 12.5.1, pinned in `mise.toml` and `package.json`. With
[mise](https://mise.jdx.dev), `mise install` provides both and `mise run setup` installs
dependencies and Playwright's Chromium.

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
| `pnpm e2e`             | Essential desktop and mobile-emulated Chromium journeys on the build       |
| `pnpm e2e:extended`    | Additional weather, cursor, audio and accessibility regressions            |
| `pnpm e2e:gpu`         | Explicit GPU validation; WebGPU scenarios require an actual WebGPU backend |
| `pnpm benchmark:scene` | Separate prolonged scene sampling and screenshots                          |

Install the browser once with `pnpm exec playwright install chromium` (or `mise run setup`).
The suites run on Chromium only; the mobile project emulates a Pixel 7 in Chromium.
Build before browser tests and benchmarks. Failure traces and screenshots are retained
in `test-results/`. Browser test time limits exclude dependency installation.

Playwright's bundled headless Chromium has no GPU on Linux, so the scene cannot start
there. `scripts/with-gpu-chromium.sh <command>` runs a command with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pointing at nixpkgs' Chromium, which renders
WebGL 2 on the real GPU (`mise run e2e:local-gpu` runs `pnpm e2e` that way). Headless
WebGPU has no adapter on those hosts, so WebGPU-only checks in `pnpm e2e:gpu` still need
a machine with a real WebGPU backend. Append `?backend=webgl` to a URL to skip WebGPU
and render with WebGL 2 in any browser.

## Architecture

The initial entry loads a minimal TSL loader and Three.js runtime. Its first presented
frame starts the dynamic landscape import. The loader and landscape share one canvas,
one initialized `WebGPURenderer` and the same runtime. Browsers without a working WebGPU
adapter render the same scene through the renderer’s WebGL 2 backend; only browsers
without either display the static profile. Graphics failures also release the profile.
World generation runs on two seeded workers; weather and audio remain independent resources.

`src/components/` owns page lifecycle and accessible controls. `src/scene/` contains
world preparation, CPU simulation, TSL materials and composition. `src/weather/`
validates the remote weather response; `src/audio/` handles decoded clips and scheduling.
Initialization has a 20-second deadline; the HTML bootstrap releases the profile even
when the main module cannot load.

The scene accepts five URL parameters:

| Parameter     | Example          | Meaning                                                                                                |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `seed`        | `42`             | Reproduce a landscape composition                                                                      |
| `coordinates` | `48.8566,2.3522` | Weather location; defaults to Paris                                                                    |
| `startTime`   | `08:30`          | Initial artistic solar clock; defaults to a golden-hour intro that time-lapses to local time           |
| `timeScale`   | `20`             | Solar cycle multiplier, clamped to 1–100                                                               |
| `weather`     | `rain`           | Force `clear`, `partly-cloudy`, `cloudy`, `overcast`, `rain` or `thunderstorm` instead of live weather |

Weather defaults to live conditions and remains independent of the artistic solar clock.
For example, `/?weather=rain&startTime=12:00` shows a rainy midday scene without requesting the
weather API. Omit `weather` to return to live conditions; unknown values also use live weather.
Reduced motion renders a static TSL loader and freezes scene motion. Audio follows browser autoplay rules and
can be controlled by the speaker button.

## Contributing

Keep changes scoped and include relevant behavioral validation. Use explicit types and
validated `unknown` values at boundaries; casts, `any`, non-null assertions and TypeScript
error suppressions are prohibited. Prefer minimal public interfaces for test doubles.
Run `pnpm check`, `pnpm bundle:size` and the relevant browser suite before proposing a change.

See [rendering architecture](docs/architecture.md), [terrain](docs/terrain.md), [vegetation](docs/vegetation.md), [verification](docs/performance.md),
[weather integration](docs/paris-weather.md) and [audio provenance](docs/living-landscape.md).

## License and attribution

Project code is [MIT licensed](LICENSE). Preserve the [Three.js notice](public/licenses/three.txt),
the recording provenance in [audio sources](public/audio/sources.json), and the visible
[Open-Meteo attribution](docs/paris-weather.md). Those external assets and data retain
their own license terms.
The terrain uses [CC0 Poly Haven textures](public/textures/terrain/sources.json).

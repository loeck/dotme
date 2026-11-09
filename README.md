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

`pnpm build` produces `dist/`; `pnpm preview` serves that build locally with the production
headers from `vercel.json`. Deploy `dist/` to a static host. `vercel.json` provides the Vercel
configuration; other hosts should serve `404.html` with HTTP status 404 for unknown paths and
send the same headers.

### Security headers

Every response carries a Content-Security-Policy (`'self'` only, plus
`https://api.open-meteo.com` for weather and `'wasm-unsafe-eval'` for Rapier's WebAssembly),
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (camera, microphone,
geolocation, payment and USB disabled; motion sensors stay available for device tilt) and
`Cross-Origin-Opener-Policy`. The inline bootstrap script and `<style>` are allowed by their
SHA-256 hashes: after changing either, rebuild and run `node scripts/csp.ts --write`.
`pnpm csp` (part of `pnpm check`) fails when the hashes no longer match the build, and the
browser suite runs under the real policy and fails on any violation. Use classes rather than
inline `style` attributes or event-handler attributes; setting styles from script is fine.

### Metadata

`index.html` carries Open Graph and Twitter card tags with a 1200x630 `public/og-image.jpg`
(a WebGL capture of seed 2024 at 18:00 in clear weather) and a JSON-LD `Person`.
`public/` also holds `robots.txt`, `sitemap.xml`, `site.webmanifest`, an SVG favicon with
an ICO fallback, a 180x180 `apple-touch-icon.png` and a 512x512 manifest icon.

## Commands

| Command                | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `pnpm check`           | Strict types, typed lint, formatting, unit tests, build, budget and CSP  |
| `pnpm bundle:size`     | Measure gzip/brotli sizes and enforce the first-render and ready budgets |
| `pnpm csp`             | Check that `vercel.json`'s CSP hashes match the built inline code        |
| `pnpm e2e`             | A short desktop Chromium smoke suite on the production build             |
| `pnpm benchmark:scene` | Separate prolonged scene sampling and screenshots                        |

Install the browser once with `pnpm exec playwright install chromium` (or
`mise run setup`). The browser suite is deliberately small: page shell, SEO, 404, CSP and
the no-graphics fallback (`home.spec.ts`), plus a day scene and a reduced-motion rainy night
(`functional.spec.ts`). Detailed behaviour (audio, weather, cursor, rendering logic) is
covered by the unit tests.
Build before browser tests and benchmarks. Failure traces and screenshots are retained
in `test-results/`. Browser test time limits exclude dependency installation.

Playwright's bundled headless Chromium has no GPU on Linux, so the scene cannot start
there. `scripts/with-gpu-chromium.sh <command>` runs a command with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pointing at nixpkgs' Chromium, which renders
WebGL 2 or WebGPU on the real GPU (`mise run e2e:local-gpu` runs `pnpm e2e` that way). Append `?backend=webgl` to a URL to skip WebGPU
and render with WebGL 2 in any browser.

## Architecture

The initial entry loads a minimal TSL loader and Three.js runtime. Its first presented
frame starts the dynamic landscape import. The loader and landscape share one canvas,
one initialized `WebGPURenderer` and the same runtime. Browsers without a working WebGPU
adapter render the same scene through the renderer’s WebGL 2 backend; only browsers
without either display the static profile. Graphics failures also release the profile.
World generation runs on three seeded workers; weather and audio remain independent resources.

`src/components/` owns page lifecycle and accessible controls. `src/scene/` contains
world preparation, CPU simulation, TSL materials and composition. `src/weather/`
validates the remote weather response; `src/audio/` handles decoded clips and scheduling.
Initialization has a single 45-second deadline in the HTML bootstrap, which releases the
profile even when the main module cannot load. The profile text is present from the start but
stays invisible while the loader runs, then fades in with the scene.

The scene accepts six URL parameters:

| Parameter     | Example          | Meaning                                                                                                               |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `seed`        | `42`             | Reproduce a landscape composition                                                                                     |
| `coordinates` | `48.8566,2.3522` | Weather location and hemisphere of the season; defaults to Paris                                                      |
| `startTime`   | `08:30`          | Initial artistic solar clock; defaults to a golden-hour intro that time-lapses to local time                          |
| `timeScale`   | `20`             | Solar cycle multiplier, clamped to 1–100                                                                              |
| `weather`     | `rain`           | Force `clear`, `partly-cloudy`, `cloudy`, `overcast`, `fog`, `snow`, `rain` or `thunderstorm` instead of live weather |
| `season`      | `autumn`         | Force `spring`, `summer`, `autumn` or `winter`; defaults to the visitor's date at the coordinates                     |

Weather defaults to live conditions and remains independent of the artistic solar clock.
For example, `/?weather=rain&startTime=12:00` shows a rainy midday scene without requesting the
weather API. Omit `weather` to return to live conditions; unknown values also use live weather.
The season colours the wood and the meadow and decides which wildlife is about (see
[seasons](docs/vegetation.md#seasons)); `/?season=winter&startTime=12:00` shows a bare midwinter wood.
Reduced motion renders a static TSL loader and freezes scene motion. Audio follows browser autoplay rules and
can be controlled by the speaker button.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm check`, then an `e2e` job that installs Chromium
(cached per Playwright version), builds and runs `pnpm e2e` with
`WEBGPU_ADAPTER=swiftshader`; failed runs upload `test-results/`. Actions are pinned by commit
digest. Renovate (`.github/renovate.json`) proposes weekly, pinned dependency updates, grouping
Three.js with its types and the lint tooling, and keeps the action digests current.

## Contributing

Keep changes scoped and include relevant behavioral validation. Use explicit types and
validated `unknown` values at boundaries; casts, `any`, non-null assertions and TypeScript
error suppressions are prohibited. Prefer minimal public interfaces for test doubles.
Lint warnings fail the build (`oxlint --deny-warnings`, also in the pre-commit hook), and
`pnpm knip` rejects unused files, exports and dependencies: export only what another module
uses. Run `pnpm check` (typecheck, lint, format, knip, tests, build, bundle size, CSP) and the
relevant browser suite before proposing a change.

See [rendering architecture](docs/architecture.md), [terrain](docs/terrain.md), [vegetation](docs/vegetation.md), [verification](docs/performance.md),
[weather integration](docs/paris-weather.md) and [audio provenance](docs/living-landscape.md).

## License and attribution

Project code is [MIT licensed](LICENSE). Preserve the [Three.js notice](public/licenses/three.txt),
the recording provenance in [audio sources](public/audio/sources.json), and the visible
[Open-Meteo attribution](docs/paris-weather.md). Those external assets and data retain
their own license terms.
The terrain uses [CC0 Poly Haven textures](src/assets/textures/terrain/sources.json).

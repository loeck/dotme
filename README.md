# loeck.me

Personal site built with TanStack Start, React and Three.js. The profile is server-rendered; the
procedural voxel lake loads in the browser after hydration. Each visit gets a fresh landscape seed.
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

## Verification

```sh
pnpm check
pnpm exec playwright install chromium webkit
pnpm e2e
```

See [lake rendering notes](docs/lake-water.md) for physical parameters, input behavior,
GPU validation, performance methodology and approximations.

## Vercel

The project uses TanStack Start with Nitro. Import the repository in Vercel with the repository root
as the project root; framework detection and SSR functions are configured by `vercel.json` and
`vite.config.ts`.

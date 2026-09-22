# loeck.me

Personal site built with TanStack Start, React and Three.js. The profile is server-rendered and the
interactive field is progressively loaded in the browser.

## Requirements

- Node.js 24.21.0
- pnpm 12.5.1

## Development

```sh
pnpm install
pnpm dev
```

## Verification

```sh
pnpm check
pnpm exec playwright install chromium
pnpm e2e
```

## Vercel

The project uses TanStack Start with Nitro. Import the repository in Vercel with the repository root
as the project root; framework detection and SSR functions are configured by `vercel.json` and
`vite.config.ts`.

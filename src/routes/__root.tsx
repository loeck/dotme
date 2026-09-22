import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import styles from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: 'stylesheet', href: styles },
      { rel: 'canonical', href: 'https://loeck.me/' },
      { rel: 'icon', href: '/favicon.ico' },
    ],
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'Loëck | Building some stuff in Paris' },
      {
        name: 'description',
        content: 'Loëck builds some stuff in Paris.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: 'Loëck | Building some stuff in Paris' },
      {
        property: 'og:description',
        content: 'Loëck builds some stuff in Paris.',
      },
      { property: 'og:url', content: 'https://loeck.me/' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'theme-color', content: '#080a0d' },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
})

function RootComponent() {
  return <Outlet />
}

function NotFound() {
  return (
    <main className="grid min-h-svh place-content-center bg-[#080a0d] p-8 text-center font-mono text-[#e4e8ed]">
      <p className="mb-4 text-[#8a919a]">{'//404'}</p>
      <h1 className="mb-4 text-xl font-normal">Nothing here.</h1>
      <a className="text-[#8a919a] underline-offset-4 hover:underline" href="/">
        Return home
      </a>
    </main>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="min-h-full min-w-[280px] bg-[#080a0d]">
      <head>
        <HeadContent />
      </head>
      <body className="m-0 min-h-full min-w-[280px] overflow-x-hidden bg-[#080a0d] font-mono text-sm font-normal leading-6 text-[#e4e8ed] antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

import type { MetaFunction, LinksFunction } from '@remix-run/node'
import * as React from 'react'
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from '@remix-run/react'
import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import styles from './tailwind.css'

export const links: LinksFunction = () => [
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    crossOrigin: 'anonymous',
    href: 'https://fonts.gstatic.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300&display=swap',
  },
  {
    rel: 'stylesheet',
    href: styles,
  },
]

export const meta: MetaFunction = () => ({
  charset: 'utf-8',
  title: 'loeck.me',
  viewport: 'width=device-width,initial-scale=1',
})

export default function App() {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: {
            retry: 0,
          },
          queries: {
            refetchInterval: false,
            refetchOnMount: false,
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
            retry: 0,
          },
        },
      })
  )

  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
      </head>
      <body className="antialiased overflow-hidden bg-black font-light text-base">
        <QueryClientProvider client={queryClient}>
          <LazyMotion features={domAnimation} strict>
            <MotionConfig
              transition={{
                type: 'spring',
                mass: 1,
                damping: 35,
                stiffness: 300,
              }}
            >
              <Outlet />
            </MotionConfig>
          </LazyMotion>
        </QueryClientProvider>

        <ScrollRestoration />
        <Scripts />
        <LiveReload />
      </body>
    </html>
  )
}

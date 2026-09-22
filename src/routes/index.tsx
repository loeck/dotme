import { createFileRoute } from '@tanstack/react-router'

import { FlowField } from '../components/FlowField'
import { Profile } from '../components/Profile'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <main className="relative isolate min-h-svh overflow-hidden bg-[#080a0d]">
      <FlowField />
      <Profile />
    </main>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { FlowField } from '../components/FlowField'
import { Profile } from '../components/Profile'
import { SceneControls } from '../components/SceneControls'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const [paused, setPaused] = useState(false)
  const [sceneAvailable, setSceneAvailable] = useState(false)

  return (
    <main className="isolate min-h-svh overflow-hidden bg-[#080a0d]">
      <FlowField paused={paused} onAvailabilityChange={setSceneAvailable} />
      <Profile />
      <SceneControls
        available={sceneAvailable}
        paused={paused}
        onToggle={() => setPaused((value) => !value)}
      />
    </main>
  )
}

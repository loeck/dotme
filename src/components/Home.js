import React, { useContext, useCallback } from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring'
import loadable from '@loadable/component'

import { AppContext } from 'contexts/App'

import AboutMe from 'components/AboutMe'

const ListTracks = loadable(() => import('components/ListTracks'))
const PlayerAudio = loadable(() => import('components/PlayerAudio'))

const Wrapper = styled(animated.div)`
  bottom: 0;
  left: 0;
  overflow: hidden;
  position: absolute;
  right: 0;
  top: 0;
`

const Home = React.memo(() => {
  const {
    dispatch,
    state: {
      canPlaying,
      currentColor,
      currentLoading,
      currentPlaying,
      currentTrack,
      indexTrack,
      progressTrack,
    },
  } = useContext(AppContext)

  const { bg } = useSpring({
    bg: currentColor.value,
  })

  const handleLoadingTrack = useCallback(id => dispatch({ type: 'loading-track', payload: id }), [
    dispatch,
  ])
  const handlePlayingTrack = useCallback(id => dispatch({ type: 'playing-track', payload: id }), [
    dispatch,
  ])
  const handleNextTrack = useCallback(() => dispatch({ type: 'next-track' }), [dispatch])
  const handleProgressTrack = useCallback(
    progress => dispatch({ type: 'progress-track', payload: progress }),
    [dispatch],
  )

  return (
    <Wrapper
      style={{
        backgroundColor: bg,
      }}
    >
      <AboutMe />
      <ListTracks />
      <PlayerAudio
        bg={bg}
        canPlaying={canPlaying}
        currentLoading={currentLoading}
        currentPlaying={currentPlaying}
        currentTrack={currentTrack}
        indexTrack={indexTrack}
        onLoadingTrack={handleLoadingTrack}
        onNextTrack={handleNextTrack}
        onPlayingTrack={handlePlayingTrack}
        onProgressTrack={handleProgressTrack}
        progressTrack={progressTrack}
      />
    </Wrapper>
  )
})

export default Home

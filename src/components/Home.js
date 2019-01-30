import React, { useContext } from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring/hooks.cjs'

import { AppContext } from 'contexts/App'

import AboutMe from 'components/AboutMe'
import ListTracks from 'components/ListTracks'
import PlayerAudio from 'components/PlayerAudio'

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
      progressTrack,
      canPlaying,
      currentLoading,
      currentPlaying,
      currentColor,
      indexTrack,
      currentTrack,
    },
  } = useContext(AppContext)
  const { bg } = useSpring({
    bg: currentColor.value,
  })
  const onLoadingTrack = id => dispatch({ type: 'loading-track', payload: id })
  const onPlayingTrack = id => dispatch({ type: 'playing-track', payload: id })
  const onNextTrack = () => dispatch({ type: 'next-track' })
  const onProgressTrack = progress => dispatch({ type: 'progress-track', payload: progress })
  return (
    <Wrapper
      style={{
        backgroundColor: bg,
      }}
    >
      <AboutMe />
      <ListTracks />
      <PlayerAudio
        canPlaying={canPlaying}
        currentLoading={currentLoading}
        currentPlaying={currentPlaying}
        currentTrack={currentTrack}
        indexTrack={indexTrack}
        onLoadingTrack={onLoadingTrack}
        onNextTrack={onNextTrack}
        onPlayingTrack={onPlayingTrack}
        onProgressTrack={onProgressTrack}
        progressTrack={progressTrack}
      />
    </Wrapper>
  )
})

export default Home

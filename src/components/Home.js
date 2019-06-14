import React, { useContext } from 'react'
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
      visualisation,
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
        bg={bg}
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
        visualisation={visualisation}
      />
    </Wrapper>
  )
})

export default Home

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
  overflow: auto;
  position: absolute;
  right: 0;
  top: 0;
`

const Home = () => {
  const {
    dispatch,
    state: { canPlaying, currentLoading, currentPlaying, currentColor, indexTrack, currentTrack },
  } = useContext(AppContext)
  const { scrollTop, bg } = useSpring({
    bg: currentColor.value,
    scrollTop: 110 * indexTrack,
    from: { scrollTop: 0 },
  })
  const onLoadingTrack = id => dispatch({ type: 'loading-track', payload: id })
  const onPlayingTrack = id => dispatch({ type: 'playing-track', payload: id })
  const onNextTrack = () => dispatch({ type: 'next-track' })
  return (
    <Wrapper
      style={{
        backgroundColor: bg,
      }}
      scrollTop={scrollTop}
    >
      <AboutMe />
      <ListTracks />
      <PlayerAudio
        canPlaying={canPlaying}
        currentLoading={currentLoading}
        currentPlaying={currentPlaying}
        currentTrack={currentTrack}
        onLoadingTrack={onLoadingTrack}
        onNextTrack={onNextTrack}
        onPlayingTrack={onPlayingTrack}
      />
    </Wrapper>
  )
}

export default Home

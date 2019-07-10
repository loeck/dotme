import React, { useEffect, useContext, useCallback } from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring'
import loadable from '@loadable/component'

import { AppContext } from 'contexts/App'

import useMobile from 'hooks/useMobile'

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
const WrapperAnimated = styled(animated.div)`
  position: relative;
  z-index: 10;
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

  const mobile = useMobile()

  const { bg } = useSpring({
    bg: currentColor.value,
  })

  const [springPositionLeft, setSpringPositionLeft] = useSpring(() => ({
    xy: [0, 0],
  }))
  const [springPositionRight, setSpringPositionRight] = useSpring(() => ({
    xy: [0, 0],
  }))

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

  const handleDocumentMouseMove = useCallback(
    e => {
      setSpringPositionLeft({
        xy: [e.clientX / 50, e.clientY / 50],
      })
      setSpringPositionRight({
        xy: [e.clientX / 50, 0],
      })
    },
    [setSpringPositionLeft, setSpringPositionRight],
  )
  const handleDocumentMouseOut = useCallback(() => {
    setSpringPositionLeft({
      xy: [0, 0],
    })
    setSpringPositionRight({
      xy: [0, 0],
    })
  }, [setSpringPositionLeft, setSpringPositionRight])

  useEffect(() => {
    if (!mobile) {
      document.addEventListener('mousemove', handleDocumentMouseMove)
      document.addEventListener('mouseout', handleDocumentMouseOut)

      return () => {
        document.removeEventListener('mousemove', handleDocumentMouseMove)
        document.removeEventListener('mouseout', handleDocumentMouseOut)
      }
    }
  }, [mobile])

  return (
    <Wrapper
      style={{
        backgroundColor: bg,
      }}
    >
      <WrapperAnimated
        style={{
          transform: springPositionLeft.xy.interpolate((x, y) => `translate3d(${x}px, ${y}px, 0)`),
          zIndex: 11,
        }}
      >
        <AboutMe />
      </WrapperAnimated>
      <WrapperAnimated
        style={{
          transform: springPositionRight.xy.interpolate(
            (x, y) => `translate3d(-${x}px, ${y}px, 0)`,
          ),
        }}
      >
        <ListTracks />
      </WrapperAnimated>
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

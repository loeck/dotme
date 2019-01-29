import React, { useContext } from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring/hooks.cjs'
import Box from 'meh-components/Box'

import { AppContext } from 'contexts/App'
import useIsLight from 'hooks/useIsLight'

import IconNext from 'icons/Next'
import IconPlay from 'icons/Play'
import IconStop from 'icons/Stop'

const Wrapper = styled(Box).attrs({
  flow: 10,
  horizontal: true,
})`
  padding-left: 20px;
  padding-top: 20px;

  @media only screen and (max-width: 875px) {
    background-color: ${p => p.color};
    height: 90px;
  }
`
const IconWrapper = styled.div`
  cursor: pointer;
  user-select: none;
  position: relative;
  z-index: 10;
`

const MediaControls = () => {
  const {
    dispatch,
    state: { currentTrack, currentPlaying, currentLoading },
  } = useContext(AppContext)
  const isLight = useIsLight()
  const { color } = useSpring({
    color: isLight ? 'black' : 'white',
  })
  const onStartPlaying = () => dispatch({ type: 'start-playing' })
  const onStopPlaying = () => dispatch({ type: 'stop-playing' })
  const onNextTrack = () => dispatch({ type: 'next-track' })
  return (
    <animated.div
      style={{
        color,
      }}
    >
      <Wrapper color={currentTrack.color.value}>
        {currentPlaying === null && currentLoading === null ? (
          <IconWrapper onClick={onStartPlaying}>
            <IconPlay height={24} width={24} />
          </IconWrapper>
        ) : (
          <>
            <IconWrapper onClick={onStopPlaying}>
              <IconStop height={24} width={24} />
            </IconWrapper>
            <IconWrapper onClick={onNextTrack}>
              <IconNext height={24} width={24} />
            </IconWrapper>
          </>
        )}
      </Wrapper>
    </animated.div>
  )
}

export default MediaControls

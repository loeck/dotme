import React, { useContext, useCallback } from 'react'
import styled from 'styled-components'
import { useSpring, useTransition, animated } from 'react-spring'

import { AppContext } from 'contexts/App'
import useIsLight from 'hooks/useIsLight'
import { mobile } from 'helpers/styles'

import IconNext from 'icons/Next'
import IconPlay from 'icons/Play'
import IconStop from 'icons/Stop'

import Box from 'components/Box'

const Wrapper = styled(Box).attrs({
  flow: 10,
  horizontal: true,
})`
  align-items: center;
  padding: 20px;

  ${mobile`
    align-items: center;
    height: 90px;
    padding-top: 0;
    padding-bottom: 0;
  `}
`
const IconWrapper = styled(({ front, ...p }) => (
  <animated.div
    {...p} // eslint-disable-line react/jsx-props-no-spreading
  />
))`
  border-radius: 50%;
  cursor: pointer;
  height: 24px;
  position: relative;
  user-select: none;
  pointer-events: auto;
  width: 24px;
  z-index: ${p => (p.front ? 11 : 10)};
`

const MediaControls = React.memo(() => {
  const {
    dispatch,
    state: { canPlaying, tracks },
  } = useContext(AppContext)

  const isLight = useIsLight()

  const { bg, color } = useSpring({
    bg: isLight ? 'white' : 'black',
    color: isLight ? 'black' : 'white',
  })

  const transitionWrapper = useTransition(tracks.length > 0, null, {
    from: {
      opacity: 0,
      x: -100,
    },
    enter: {
      opacity: 1,
      x: 0,
    },
    leave: {
      opacity: 0,
      x: -100,
    },
  })
  const transitionPlaying = useTransition(canPlaying, null, {
    from: {
      x: -34,
      opacity: 0,
      pointerEvents: 'none',
    },
    enter: {
      x: 0,
      opacity: 1,
      pointerEvents: 'all',
    },
    leave: {
      x: -34,
      opacity: 0,
      pointerEvents: 'none',
    },
  })

  const handleStartPlaying = useCallback(() => dispatch({ type: 'start-playing' }), [dispatch])
  const handleStopPlaying = useCallback(() => dispatch({ type: 'stop-playing' }), [dispatch])
  const handleNextTrack = useCallback(() => dispatch({ type: 'next-track' }), [dispatch])

  return transitionWrapper.map(
    ({ item, props, key }) =>
      item && (
        <animated.div
          key={key}
          style={{
            color,
            opacity: props.o,
            transform: props.x.interpolate(v => `translate3d(0, ${v}px, 0)`),
          }}
        >
          <Wrapper>
            {!canPlaying ? (
              <IconWrapper
                onClick={handleStartPlaying}
                front
                style={{
                  backgroundColor: bg,
                }}
              >
                <IconPlay height={24} width={24} />
              </IconWrapper>
            ) : (
              <IconWrapper
                onClick={handleStopPlaying}
                front
                style={{
                  backgroundColor: bg,
                }}
              >
                <IconStop height={24} width={24} />
              </IconWrapper>
            )}
            {transitionPlaying.map(
              ({ item, key, props }) =>
                item && (
                  <React.Fragment key={key}>
                    <IconWrapper
                      onClick={handleNextTrack}
                      style={{
                        backgroundColor: bg,
                        pointerEvents: props.pointerEvents,
                        opacity: props.opacity,
                        transform: props.x.interpolate(v => `translate3d(${v}px, 0, 0)`),
                      }}
                    >
                      <IconNext height={24} width={24} />
                    </IconWrapper>
                  </React.Fragment>
                ),
            )}
          </Wrapper>
        </animated.div>
      ),
  )
})

export default MediaControls

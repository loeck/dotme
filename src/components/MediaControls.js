import React, { useContext } from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring/hooks.cjs'
import Box from 'meh-components/Box'

import { AppContext } from 'contexts/App'
import useIsLight from 'hooks/useIsLight'

import IconNext from 'icons/Next'
import IconPlay from 'icons/Play'
import IconStop from 'icons/Stop'
import IconWave1 from 'icons/Wave1'
import IconWave2 from 'icons/Wave2'

const Wrapper = styled(Box).attrs({
  flow: 10,
  horizontal: true,
})`
  align-items: center;
  padding: 20px;

  @media only screen and (max-width: 875px) {
    align-items: center;
    height: 90px;
    padding-top: 0;
    padding-bottom: 0;
  }
`
const IconWrapper = styled(({ front, ...props }) => <animated.div {...props} />)`
  border-radius: 50%;
  cursor: pointer;
  height: 24px;
  position: relative;
  user-select: none;
  width: 24px;
  z-index: ${p => (p.front ? 11 : 10)};
`

const MediaControls = React.memo(() => {
  const {
    dispatch,
    state: { currentTrack, visualisation, canPlaying },
  } = useContext(AppContext)
  const isLight = useIsLight()
  const { pointerEvents, opacity, bg, x, color } = useSpring({
    bg: currentTrack.color.value,
    color: isLight ? 'black' : 'white',
    x: canPlaying ? 0 : -34,
    opacity: canPlaying ? 1 : 0,
    pointerEvents: canPlaying ? 'all' : 'none',
  })
  const onStartPlaying = () => dispatch({ type: 'start-playing' })
  const onStopPlaying = () => dispatch({ type: 'stop-playing' })
  const onNextTrack = () => dispatch({ type: 'next-track' })
  const onToggleVisualisation = () =>
    dispatch({
      type: 'set-visualisation',
      payload: visualisation === 'waveform' ? 'bar' : 'waveform',
    })
  return (
    <animated.div
      style={{
        color,
      }}
    >
      <Wrapper>
        {!canPlaying ? (
          <IconWrapper
            onClick={onStartPlaying}
            front
            style={{
              backgroundColor: bg,
            }}
          >
            <IconPlay height={24} width={24} />
          </IconWrapper>
        ) : (
          <IconWrapper
            onClick={onStopPlaying}
            front
            style={{
              backgroundColor: bg,
            }}
          >
            <IconStop height={24} width={24} />
          </IconWrapper>
        )}
        <IconWrapper
          onClick={onNextTrack}
          style={{
            backgroundColor: bg,
            pointerEvents,
            opacity,
            transform: x.interpolate(v => `translate3d(${v}px, 0, 0)`),
          }}
        >
          <IconNext height={24} width={24} />
        </IconWrapper>
        <Box
          grow
          style={{
            alignItems: 'flex-end',
          }}
        >
          <IconWrapper
            onClick={onToggleVisualisation}
            style={{
              backgroundColor: bg,
              pointerEvents,
              opacity,
            }}
          >
            {visualisation === 'waveform' ? (
              <IconWave2 height={24} width={24} />
            ) : (
              <IconWave1 height={24} width={24} />
            )}
          </IconWrapper>
        </Box>
      </Wrapper>
    </animated.div>
  )
})

export default MediaControls

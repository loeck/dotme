import React, { useRef, useContext, useCallback } from 'react'
import styled from 'styled-components'
import { useSpring, useTransition, animated } from 'react-spring'

import { AppContext } from 'contexts/App'
import useIsLight from 'hooks/useIsLight'
import { mobile } from 'helpers/styles'

import IconNext from 'icons/Next'
import IconPlay from 'icons/Play'
import IconStop from 'icons/Stop'

import Box from 'components/Box'

const MediaControls = React.memo(() => {
  const {
    dispatch,
    state: { canPlaying, tracks, gain },
  } = useContext(AppContext)

  const refSoundTickWrapper = useRef()
  const refSoundTick = useRef()
  const refSoundTickValues = useRef({
    barWidth: 0,
    wrapperX: 0,
  })

  const isLight = useIsLight()

  const { bg, color } = useSpring({
    bg: isLight ? 'white' : 'black',
    color: isLight ? 'black' : 'white',
  })

  const [springSound, setSpringSound] = useSpring(() => ({
    x: gain,
  }))

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
  const handleSetGain = useCallback((v) => dispatch({ type: 'set-gain', payload: v }), [dispatch])

  const handleMouseMove = useCallback(
    (e) =>
      window.requestAnimationFrame(() => {
        const { clientX } = e

        const { wrapperX, barWidth } = refSoundTickValues.current

        const newClientX = clientX - wrapperX

        let position = gain + (newClientX * 100) / barWidth
        position = position < 0 ? 0 : position > 100 ? 100 : position

        setSpringSound({
          x: position,
        })

        handleSetGain(parseInt(position, 10))
      }),
    [handleSetGain, setSpringSound, gain],
  )

  const handleMouseDown = useCallback(() => {
    const { x: wrapperX } = refSoundTick.current.getBoundingClientRect()
    const { width: barWidth } = refSoundTickWrapper.current.getBoundingClientRect()

    refSoundTickValues.current = {
      barWidth,
      wrapperX,
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [handleMouseMove])

  return transitionWrapper.map(
    ({ item, props, key }) =>
      item && (
        <animated.div
          key={key}
          style={{
            color,
            opacity: props.o,
            transform: props.x.interpolate((v) => `translate3d(0, ${v}px, 0)`),
          }}
        >
          <Wrapper>
            <Box grow horizontal flow={10}>
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
                          transform: props.x.interpolate((v) => `translate3d(${v}px, 0, 0)`),
                        }}
                      >
                        <IconNext height={24} width={24} />
                      </IconWrapper>
                    </React.Fragment>
                  ),
              )}
            </Box>

            <Box justify="flex-end">
              <WrapperLvlSound
                ref={refSoundTickWrapper}
                style={{
                  backgroundColor: color,
                }}
              >
                <WrapperSoundTick
                  ref={refSoundTick}
                  onMouseDown={handleMouseDown}
                  style={{
                    transform: springSound.x.interpolate((v) => `translate3d(${v}px, 0, 0)`),
                  }}
                >
                  <SoundTick
                    style={{
                      backgroundColor: color,
                    }}
                  ></SoundTick>
                </WrapperSoundTick>
              </WrapperLvlSound>
            </Box>
          </Wrapper>
        </animated.div>
      ),
  )
})

export default MediaControls

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
  z-index: ${(p) => (p.front ? 11 : 10)};
`

const WrapperLvlSound = styled(animated.div)`
  height: 2px;
  margin-left: 10px;
  position: relative;
  width: 113px;
  pointer-events: all;
  user-select: none;
`
const WrapperSoundTick = styled(animated.div)`
  cursor: pointer;
  height: 12px;
  left: 0;
  pointer-events: all;
  position: absolute;
  top: -5px;
  width: 13px;
  z-index: 1;
`
const SoundTick = styled(animated.div)`
  bottom: 0;
  left: 0;
  margin: 0 5px;
  pointer-events: none;
  position: absolute;
  right: 0;
  top: 0;
  width: 3px;
`

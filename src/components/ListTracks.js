/* eslint-disable react/no-multi-comp */

import React, { useMemo, useState, useContext } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { useSpring, animated } from 'react-spring/hooks.cjs'
import Box from 'meh-components/Box'

import { AppContext } from 'contexts/App'

import IconPlay from 'icons/Play'
import IconDisk from 'icons/Disk'
import IconLoading from 'icons/Loading'
import IconSpotify from 'icons/Spotify'

import HighlightLink from 'components/HighlightLink'

const rotate360 = keyframes`
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(-360deg);
  }
`

const Wrapper = styled(Box)`
  align-items: flex-end;
  margin: 100px 100px 0 0;
  position: relative;
  z-index: 9;

  @media only screen and (max-width: 875px) {
    margin-right: 0;
    margin-top: 200px;
  }
`

const ListTracks = React.memo(() => {
  const {
    dispatch,
    state: {
      canPlaying,
      tracks,
      indexTrack,
      currentTrack,
      currentLoading,
      currentPlaying,
      progressTrack,
    },
  } = useContext(AppContext)
  const { y } = useSpring({
    y: 110 * indexTrack,
  })
  const onSetTrack = id => {
    dispatch({ type: 'set-track', payload: id })
    dispatch({ type: 'start-playing' })
  }
  return (
    <Wrapper>
      <animated.div
        style={{
          transform: y.interpolate(v => `translate3d(0, -${v}px, 0)`),
        }}
      >
        {tracks.map(t => {
          const playing = canPlaying && currentPlaying === t.id
          const active = currentTrack.id === t.id
          const loading = currentLoading === t.id
          const progress = playing && progressTrack
          const track = useMemo(
            () => (
              <Track
                key={t.id}
                active={active}
                loading={loading}
                playing={playing}
                progress={progress}
                onSetTrack={onSetTrack}
                {...t}
              />
            ),
            [active, loading, playing, progress],
          )
          return track
        })}
      </animated.div>
    </Wrapper>
  )
})

const WrapperTrack = styled(Box).attrs(p => ({
  style: {
    color: p.isLight ? 'black' : 'white',
    backgroundColor: p.color,
  },
  horizontal: true,
}))`
  padding: 20px;
  height: 110px;
  position: relative;
  overflow: hidden;
  width: 410px;

  @media only screen and (max-width: 875px) {
    width: 100%;
  }
`
const WrapperTrackImg = styled(Box)`
  align-items: center;
  justify-content: center;
  position: relative;
  width: 70px;

  img {
    max-height: 70px;
    max-width: 70px;
  }
`
const WrapperInfos = styled(Box).attrs({
  flow: 10,
})`
  margin-left: 20px;
  justify-content: center;
`
const WrapperIcon = styled(({ animate, ...props }) => <animated.div {...props} />)`
  align-items: center;
  bottom: 0;
  display: flex;
  position: absolute;
  right: 20px;
  top: 0;

  svg {
    animation: ${p =>
      p.animate
        ? css`
            ${rotate360} 2s linear infinite;
          `
        : null};
  }
`
const ProgressTrack = styled(({ isLight, ...props }) => <animated.div {...props} />)`
  background-color: rgba(${p => (p.isLight ? '0, 0, 0' : '255, 255, 255')}, 0.5);
  bottom: 0;
  height: 2px;
  left: 0;
  position: absolute;
`
const WrapperSpotify = styled(animated.a)`
  align-items: center;
  background-color: rgba(0, 0, 0, 0.75);
  bottom: 0;
  display: flex;
  justify-content: center;
  left: 0;
  position: absolute;
  right: 0;
  top: 0;
`

const Track = React.memo(
  ({ onSetTrack, artists, image, color, name, playing, loading, active, progress, id }) => {
    const [hoverSpotify, setHoverSpotify] = useState(false)
    const [hoverTrack, setHoverTrack] = useState(false)
    const { x, w, opacity, scale } = useSpring({
      x: hoverTrack || playing || loading ? 0 : 48,
      w: progress || 0,
      opacity: hoverSpotify ? 1 : 0,
      scale: hoverSpotify ? 1 : 0,
    })
    const Icon = hoverTrack && !playing ? IconPlay : loading ? IconLoading : IconDisk
    const onMouseEnterSpotify = () => setHoverSpotify(true)
    const onMouseLeaveSpotify = () => setHoverSpotify(false)
    const onMouseEnterTrack = () => setHoverTrack(true)
    const onMouseLeaveTrack = () => setHoverTrack(false)
    return (
      <WrapperTrack
        color={color.value}
        isLight={color.isLight}
        onMouseEnter={onMouseEnterTrack}
        onMouseLeave={onMouseLeaveTrack}
      >
        <WrapperTrackImg onMouseEnter={onMouseEnterSpotify} onMouseLeave={onMouseLeaveSpotify}>
          <img src={image.big} alt={name} />
          <WrapperSpotify
            href={`https://open.spotify.com/track/${id}`}
            target="_blank"
            style={{
              opacity,
            }}
          >
            <animated.div
              style={{
                transform: scale.interpolate(v => `scale3d(${v}, ${v}, 1)`),
              }}
            >
              <IconSpotify height={24} width={24} />
            </animated.div>
          </WrapperSpotify>
        </WrapperTrackImg>
        <WrapperInfos>
          <Box>{name}</Box>
          <Box horizontal flow={10}>
            {artists.map(artist => (
              <HighlightLink key={artist} isLight={!color.isLight}>
                {artist}
              </HighlightLink>
            ))}
          </Box>
        </WrapperInfos>
        {active && (
          <ProgressTrack
            isLight={color.isLight}
            style={{
              width: w.interpolate(v => `${v}%`),
            }}
          />
        )}
        <WrapperIcon
          animate={playing || loading}
          style={{
            transform: x.interpolate(v => `translate3d(${v}px, 0, 0)`),
          }}
        >
          <Box
            onClick={() => {
              if (hoverTrack && !playing) {
                setHoverTrack(false)
                onSetTrack(id)
              }
            }}
            style={{
              cursor: hoverTrack && !playing ? 'pointer' : 'default',
            }}
          >
            <Icon height={24} width={24} />
          </Box>
        </WrapperIcon>
      </WrapperTrack>
    )
  },
)

export default ListTracks

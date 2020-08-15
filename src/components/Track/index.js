import React, { useCallback, useState } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { useSpring, useTransition, animated } from 'react-spring'

import { mobile } from 'helpers/styles'
import useMobile from 'hooks/useMobile'

import IconPlay from 'icons/Play'
import IconDisk from 'icons/Disk'
import IconLoading from 'icons/Loading'
import IconSpotify from 'icons/Spotify'

import Box from 'components/Box'
import HighlightLink from 'components/HighlightLink'
import LazyImg from 'components/LazyImg'

const Track = React.memo((props) => {
  const { empty, style, ...otherProps } = props

  const mobile = useMobile()

  const s = {
    ...style,
    left: 'auto',
    right: mobile ? 0 : 110,
    width: mobile ? '100%' : 410,
  }

  if (empty) {
    return <div style={s} />
  }

  return <InnerTrack {...otherProps} style={s} />
})

Track.defaultProps = {
  prefixImage: '/image?',
}

export const InnerTrack = (props) => {
  const {
    active,
    artists,
    color,
    id,
    image,
    loading,
    name,
    onSetTrack,
    playing,
    prefixImage,
    progress,
    style,
  } = props

  const [hoverSpotify, setHoverSpotify] = useState(false)
  const [hoverTrack, setHoverTrack] = useState(false)

  const animate = hoverTrack || playing || loading

  const { w, opacity } = useSpring({
    w: progress || 0,
    opacity: hoverSpotify ? 1 : 0,
  })

  const transitionSpotify = useTransition(hoverSpotify, null, {
    from: {
      scale: 0,
    },
    enter: {
      scale: 1,
    },
    leave: {
      scale: 0,
    },
  })
  const transitionIcon = useTransition(animate, null, {
    from: {
      x: 48,
      opacity: 0,
    },
    enter: {
      x: 0,
      opacity: 1,
    },
    leave: {
      x: 48,
      opacity: 0,
    },
  })

  const Icon = hoverTrack && !playing ? IconPlay : loading ? IconLoading : IconDisk

  const handleMouseEnterSpotify = useCallback(() => setHoverSpotify(true), [])
  const handleMouseLeaveSpotify = useCallback(() => setHoverSpotify(false), [])
  const handleMouseEnterTrack = useCallback(() => setHoverTrack(true), [])
  const handleMouseLeaveTrack = useCallback(() => setHoverTrack(false), [])

  return (
    <WrapperTrack
      color={color.value}
      isLight={color.isLight}
      onMouseEnter={handleMouseEnterTrack}
      onMouseLeave={handleMouseLeaveTrack}
      style={style}
    >
      <WrapperTrackImg
        onMouseEnter={handleMouseEnterSpotify}
        onMouseLeave={handleMouseLeaveSpotify}
      >
        <LazyImg alt={name} src={`${prefixImage || ''}${image.big}`} />
        <WrapperSpotify
          href={`https://open.spotify.com/track/${id}`}
          target="_blank"
          rel="noopener"
          style={{
            opacity,
          }}
        >
          {transitionSpotify.map(
            ({ item, key, props }) =>
              item && (
                <WrapperInnerSpotify
                  key={key}
                  style={{
                    transform: props.scale.interpolate((v) => `scale3d(${v}, ${v}, 1)`),
                  }}
                >
                  <IconSpotify height={24} width={24} />
                </WrapperInnerSpotify>
              ),
          )}
        </WrapperSpotify>
      </WrapperTrackImg>
      <WrapperInfos>
        <TrackName>{name}</TrackName>
        <Box horizontal flow={10}>
          {artists.map((artist) => (
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
            width: w.interpolate((v) => `${v}%`),
          }}
        />
      )}
      {transitionIcon.map(
        ({ item, key, props }) =>
          item && (
            <WrapperIcon
              key={key}
              animate={playing || loading}
              style={{
                opacity: props.opacity,
                transform: props.x.interpolate((v) => `translate3d(${v}px, 0, 0)`),
              }}
            >
              <Box
                css="user-selecgt: none;"
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
          ),
      )}
    </WrapperTrack>
  )
}

export default Track

const rotate360 = keyframes`
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(-360deg);
  }
`

const WrapperTrack = styled(({ color, ...p }) => (
  <Box
    {...p} // eslint-disable-line react/jsx-props-no-spreading
  />
)).attrs((p) => ({
  style: {
    color: p.isLight ? 'black' : 'white',
    backgroundColor: p.color,
  },
  horizontal: true,
}))`
  height: 110px;
  overflow: hidden;
  padding: 20px;
  position: relative;

  ${mobile`
    width: 100%;
  `}
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
  flex: 1;
  justify-content: center;
  margin-left: 20px;
  overflow: hidden;
  padding-right: 40px;
  white-space: nowrap;
`
const WrapperIcon = styled(({ animate, ...p }) => (
  <animated.div
    {...p} // eslint-disable-line react/jsx-props-no-spreading
  />
))`
  align-items: center;
  bottom: 0;
  display: flex;
  position: absolute;
  right: 20px;
  top: 0;

  svg {
    animation: ${(p) =>
      p.animate
        ? css`
            ${rotate360} 2s linear infinite;
          `
        : null};
  }
`
const ProgressTrack = styled(({ isLight, ...p }) => (
  <animated.div
    {...p} // eslint-disable-line react/jsx-props-no-spreading
  />
))`
  background-color: rgba(${(p) => (p.isLight ? '0, 0, 0' : '255, 255, 255')}, 0.5);
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
const WrapperInnerSpotify = styled(animated.div)`
  bottom: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  left: 0;
  position: absolute;
  right: 0;
  top: 0;
`
const TrackName = styled.div`
  overflow: hidden;
  text-overflow: ellipsis;
`

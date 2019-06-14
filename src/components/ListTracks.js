/* eslint-disable react/no-multi-comp */

import React, { useRef, useEffect, useState, useContext, useCallback } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { useSpring, useTransition, animated } from 'react-spring'
import { FixedSizeList as List } from 'react-window'

import { AppContext } from 'contexts/App'
import { mobile } from 'helpers/styles'

import IconPlay from 'icons/Play'
import IconDisk from 'icons/Disk'
import IconLoading from 'icons/Loading'
import IconSpotify from 'icons/Spotify'

import Box from 'components/Box'
import HighlightLink from 'components/HighlightLink'

const rotate360 = keyframes`
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(-360deg);
  }
`

const Wrapper = styled(animated.div)`
  align-items: flex-end;
  display: flex;
  flex-direction: column;
  margin: 0 110px 0 0;
  position: fixed;
  right: 0;
  width: 410px;
  z-index: 9;

  ${mobile`
    margin-right: 0;
    margin-top: 90px;
    width: 100%;
  `}
`

const ListTracks = React.memo(() => {
  const {
    state: { tracks, indexTrack },
  } = useContext(AppContext)

  const listRef = useRef()

  const [winHeight, setWinHeight] = useState(0)

  useSpring({
    y: 110 * (indexTrack - 1),
    onFrame: s => {
      if (listRef.current) {
        listRef.current.scrollTo(Math.round(s.y))
      }
    },
  })

  useEffect(() => {
    window.addEventListener('resize', handleWindowResize)

    handleWindowResize()

    return () => {
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [])

  const handleWindowResize = useCallback(() => {
    setWinHeight(window.innerHeight)
  }, [])

  return (
    <Wrapper>
      <List
        ref={listRef}
        height={winHeight}
        itemCount={tracks.length}
        itemData={tracks}
        itemSize={110}
        width="100%"
        style={{
          overflow: 'hidden',
        }}
      >
        {ListTracksItem}
      </List>
    </Wrapper>
  )
})

const ListTracksItem = React.memo(props => {
  const { index, style, data } = props

  const {
    dispatch,
    state: { canPlaying, currentTrack, currentLoading, currentPlaying, progressTrack },
  } = useContext(AppContext)

  const onSetTrack = useCallback(id => {
    dispatch({ type: 'set-track', payload: id })
    dispatch({ type: 'start-playing' })
  }, [])

  const track = data[index]

  const playing = canPlaying && currentPlaying === track.id
  const active = currentTrack.id === track.id
  const loading = currentLoading === track.id
  const progress = playing && progressTrack

  return (
    <Track
      key={track.id}
      style={style}
      active={active}
      loading={loading}
      playing={playing}
      progress={progress}
      onSetTrack={onSetTrack}
      {...track}
    />
  )
})

const WrapperTrack = styled(({ color, ...p }) => <Box {...p} />).attrs(p => ({
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
  width: 410px;

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
const WrapperIcon = styled(({ animate, ...p }) => <animated.div {...p} />)`
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
const ProgressTrack = styled(({ isLight, ...p }) => <animated.div {...p} />)`
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
const TrackName = styled.div`
  overflow: hidden;
  text-overflow: ellipsis;
`

const Track = React.memo(props => {
  const {
    active,
    artists,
    color,
    empty,
    id,
    image,
    loading,
    name,
    onSetTrack,
    playing,
    progress,
    style,
  } = props

  if (empty) {
    return <div style={style} />
  }

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

  const onMouseEnterSpotify = useCallback(() => setHoverSpotify(true), [])
  const onMouseLeaveSpotify = useCallback(() => setHoverSpotify(false), [])
  const onMouseEnterTrack = useCallback(() => setHoverTrack(true), [])
  const onMouseLeaveTrack = useCallback(() => setHoverTrack(false), [])

  return (
    <WrapperTrack
      style={style}
      color={color.value}
      isLight={color.isLight}
      onMouseEnter={onMouseEnterTrack}
      onMouseLeave={onMouseLeaveTrack}
    >
      <WrapperTrackImg onMouseEnter={onMouseEnterSpotify} onMouseLeave={onMouseLeaveSpotify}>
        <img
          data-sizes="auto"
          data-src={image.big}
          src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
          alt={name}
          className="lazyload"
        />
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
                <animated.div
                  key={key}
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    transform: props.scale.interpolate(v => `scale3d(${v}, ${v}, 1)`),
                  }}
                >
                  <IconSpotify height={24} width={24} />
                </animated.div>
              ),
          )}
        </WrapperSpotify>
      </WrapperTrackImg>
      <WrapperInfos>
        <TrackName>{name}</TrackName>
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
      {transitionIcon.map(
        ({ item, key, props }) =>
          item && (
            <WrapperIcon
              key={key}
              animate={playing || loading}
              style={{
                opacity: props.opacity,
                transform: props.x.interpolate(v => `translate3d(${v}px, 0, 0)`),
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
                  userSelect: 'none',
                }}
              >
                <Icon height={24} width={24} />
              </Box>
            </WrapperIcon>
          ),
      )}
    </WrapperTrack>
  )
})

export default ListTracks

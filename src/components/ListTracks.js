import React, { useContext } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { useSpring, animated } from 'react-spring/hooks.cjs'
import Box from 'meh-components/Box'

import { AppContext } from 'contexts/App'

import IconDisk from 'icons/Disk'
import IconLoading from 'icons/Loading'

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
  margin: 100px 100px calc(100vh - 210px) 0;
  position: relative;
  z-index: 9;

  @media only screen and (max-width: 875px) {
    margin-right: 0;
    margin-top: 200px;
    margin-bottom: calc(100vh - 310px);
  }
`

const ListTracks = () => {
  const {
    state: { tracks, currentTrack, currentLoading, currentPlaying },
  } = useContext(AppContext)
  return (
    <Wrapper>
      {tracks.map(t => (
        <Track
          key={t.id}
          active={currentTrack.id === t.id}
          loading={currentLoading === t.id}
          playing={currentPlaying === t.id}
          {...t}
        />
      ))}
    </Wrapper>
  )
}

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

  svg {
    animation: ${p =>
      p.active
        ? css`
            ${rotate360} 2s linear infinite;
          `
        : null};
  }
`
const WrapperTrackImg = styled(Box)`
  align-items: center;
  justify-content: center;
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
const WrapperIcon = styled(animated.div)`
  display: flex;
  align-items: center;
  position: absolute;
  top: 0;
  bottom: 0;
  right: 20px;
`

const Track = ({ artists, image, color, name, playing, loading, active }) => {
  const { x } = useSpring({ x: playing || loading ? 0 : 48 })
  const Icon = loading ? IconLoading : IconDisk
  return (
    <WrapperTrack active={active} color={color.value} isLight={color.isLight}>
      <WrapperTrackImg>
        <img src={image.big} alt={name} />
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
      <WrapperIcon
        style={{
          transform: x.interpolate(v => `translate3d(${v}px, 0, 0)`),
        }}
      >
        <Icon height={24} width={24} />
      </WrapperIcon>
    </WrapperTrack>
  )
}

export default ListTracks

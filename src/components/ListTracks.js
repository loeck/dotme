import React, { useRef, useEffect, useState, useCallback } from 'react'
import axios from 'axios'
import styled from 'styled-components'
import { useSpring, useTransition, animated } from 'react-spring'
import { FixedSizeList as List } from 'react-window'

import { useAppContext } from 'contexts/App'
import { mobile } from 'helpers/styles'

import Track from 'components/Track'

const ListTracks = React.memo(() => {
  const {
    dispatch,
    state: { canPlaying, tracks, indexTrack },
  } = useAppContext()

  const manualScroll = useRef(true)
  const listRef = useRef()
  const listOuterRef = useRef()

  const [winHeight, setWinHeight] = useState(0)

  const [, setScroll] = useSpring(() => ({
    immediate: false,
    from: {
      y: listOuterRef.current ? listOuterRef.current.scrollTop : 0,
    },
    onFrame: (s) => {
      if (listRef.current && !manualScroll.current) {
        window.requestAnimationFrame(() => listRef.current.scrollTo(Math.round(s.y)))
      }
    },
  }))

  const handleWindowResize = useCallback(() => {
    setWinHeight(window.innerHeight)
  }, [])
  const itemKey = useCallback((index, data) => {
    const item = data[index]
    return item.id
  }, [])
  const handleScroll = useCallback(({ scrollUpdateWasRequested }) => {
    if (!scrollUpdateWasRequested) {
      manualScroll.current = true
    }
  }, [])

  useEffect(() => {
    if (listOuterRef.current && canPlaying && tracks.length > 0) {
      manualScroll.current = false
      setScroll({
        y: 110 * (indexTrack - 1),
      })
    }
  }, [canPlaying, indexTrack, tracks, setScroll])

  useEffect(() => {
    axios.get('/api/spotify').then(({ data: tracks }) => {
      if (Array.isArray(tracks) && tracks.length > 0) {
        dispatch({ type: 'set-tracks', payload: tracks })
      }
    })

    window.addEventListener('resize', handleWindowResize)

    handleWindowResize()

    return () => {
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [dispatch, handleWindowResize])

  const transitionWrapper = useTransition(tracks.length > 0, null, {
    from: {
      o: 0,
      x: -55,
    },
    enter: {
      o: 1,
      x: 0,
    },
    leave: {
      o: 0,
      x: -55,
    },
  })

  return transitionWrapper.map(
    ({ item, props, key }) =>
      item && (
        <Wrapper
          key={key}
          style={{
            opacity: props.o,
            transform: props.x.interpolate((v) => `translate3d(0, ${v}px, 0)`),
          }}
        >
          <List
            className="v-list"
            height={winHeight}
            itemCount={tracks.length}
            itemData={tracks}
            itemKey={itemKey}
            itemSize={110}
            onScroll={handleScroll}
            outerRef={listOuterRef}
            overscanCount={5}
            ref={listRef}
            width="100%"
          >
            {ListTracksItem}
          </List>
        </Wrapper>
      ),
  )
})

const ListTracksItem = React.memo((props) => {
  const { index, style, data } = props

  const {
    dispatch,
    state: { canPlaying, currentTrack, currentLoading, currentPlaying, progressTrack },
  } = useAppContext()

  const onSetTrack = useCallback(
    (id) => {
      dispatch({ type: 'set-track', payload: id })
      dispatch({ type: 'start-playing' })
    },
    [dispatch],
  )

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
      {...track} // eslint-disable-line react/jsx-props-no-spreading
    />
  )
})

export default ListTracks

const Wrapper = styled(animated.div)`
  align-items: flex-end;
  display: flex;
  flex-direction: column;
  position: fixed;
  right: 0;
  left: 0;
  z-index: 9;

  .v-list {
    -ms-overflow-style: none;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  ${mobile`
    margin-right: 0;
    margin-top: 90px;
    width: 100%;
  `}
`

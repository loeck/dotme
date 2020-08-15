/* eslint-disable default-case */

import React, { useReducer, useContext } from 'react'
import shuffle from 'lodash/shuffle'

export const AppContext = React.createContext()

const reducer = (state, action) => {
  switch (action.type) {
    case 'start-playing': {
      if (state.currentTrack) {
        return {
          ...state,
          canPlaying: true,
          currentPlaying: state.currentTrack.id,
          currentTrack: { ...state.currentTrack },
          progressTrack: 0,
        }
      }
      return state
    }

    case 'stop-playing':
      return {
        ...state,
        canPlaying: false,
        currentLoading: null,
        currentPlaying: null,
        progressTrack: 0,
      }

    case 'next-track': {
      if (state.currentTrack) {
        let nextIndexTrack = state.indexTrack + 1
        let nextTrack = state.tracks[nextIndexTrack]

        if (!nextTrack) {
          nextIndexTrack = 1
          nextTrack = state.tracks[1] // eslint-disable-line prefer-destructuring
        }

        return {
          ...state,
          currentColor: nextTrack.color,
          currentTrack: nextTrack,
          indexTrack: nextIndexTrack,
          progressTrack: 0,
        }
      }
      return state
    }

    case 'set-tracks': {
      const tracks = shuffle(action.payload)

      const [firstTrack] = tracks

      return {
        ...state,
        indexTrack: 1,
        currentColor: firstTrack.color,
        currentTrack: firstTrack,
        tracks: [
          {
            id: 'empty',
            empty: true,
          },
          ...tracks,
        ],
      }
    }

    case 'set-track': {
      const indexTrack = state.tracks.findIndex((t) => t.id === action.payload) || 0
      const currentTrack = state.tracks[indexTrack]
      return { ...state, currentTrack, indexTrack, currentColor: currentTrack.color }
    }

    case 'loading-track':
      return { ...state, currentLoading: action.payload }

    case 'playing-track':
      return { ...state, currentPlaying: action.payload }

    case 'progress-track':
      return { ...state, progressTrack: action.payload }

    case 'set-gain':
      return { ...state, gain: action.payload }
  }
}

export const INITIAL_STATE = {
  canPlaying: false,
  currentColor: {
    isLight: false,
    value: '#000000',
  },
  currentLoading: null,
  currentPlaying: null,
  currentTrack: null,
  gain: 50,
  indexTrack: 0,
  progressTrack: 0,
  tracks: [],
}

export const AppProvider = ({ children, initialState = INITIAL_STATE, forceInitialState }) => {
  const [state, dispatch] = useReducer(reducer, initialState)
  const value = { state, dispatch }

  if (forceInitialState) {
    value.state = initialState
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export const useAppContext = () => useContext(AppContext)

const { Consumer } = AppContext

export { Consumer as AppConsumer }

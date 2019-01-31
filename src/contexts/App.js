import React, { useReducer } from 'react'

export const AppContext = React.createContext()

const reducer = (state, action) => {
  switch (action.type) {
    case 'start-playing':
      return {
        ...state,
        canPlaying: true,
        currentPlaying: state.currentTrack.id,
        currentTrack: { ...state.currentTrack },
        progressTrack: 0,
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
      let nextIndexTrack = state.indexTrack + 1
      let nextTrack = state.tracks[nextIndexTrack]

      if (!nextTrack) {
        nextIndexTrack = 0
        nextTrack = state.tracks[0] // eslint-disable-line prefer-destructuring
      }

      return {
        ...state,
        currentColor: nextTrack.color,
        currentTrack: nextTrack,
        indexTrack: nextIndexTrack,
        progressTrack: 0,
      }
    }

    case 'set-track': {
      const indexTrack = state.tracks.findIndex(t => t.id === action.payload) || 0
      const currentTrack = state.tracks[indexTrack]
      return { ...state, currentTrack, indexTrack, currentColor: currentTrack.color }
    }

    case 'loading-track':
      return { ...state, currentLoading: action.payload }

    case 'playing-track':
      return { ...state, currentPlaying: action.payload }

    case 'progress-track':
      return { ...state, progressTrack: action.payload }

    case 'set-visualisation':
      return { ...state, visualisation: action.payload }
  }
}

const INITIAL_STATE = {
  canPlaying: false,
  currentColor: 'black',
  currentLoading: null,
  currentPlaying: null,
  currentTrack: null,
  indexTrack: 0,
  progressTrack: 0,
  tracks: [],
  visualisation: 'bar',
}

export const AppProvider = ({ initialState, children }) => {
  const [state, dispatch] = useReducer(reducer, { ...INITIAL_STATE, ...initialState })
  const value = { state, dispatch }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

const { Consumer } = AppContext

export { Consumer as AppConsumer }

import React, { useReducer } from 'react'

export const AppContext = React.createContext()

const reducer = (state, action) => {
  switch (action.type) {
    case 'start-playing':
      return {
        ...state,
        canPlaying: true,
        currentTrack: { ...state.currentTrack },
        currentPlaying: state.currentTrack.id,
      }

    case 'stop-playing':
      return {
        ...state,
        canPlaying: false,
        currentPlaying: null,
        currentLoading: null,
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
      }
    }

    case 'loading-track':
      return { ...state, currentLoading: action.payload }

    case 'playing-track':
      return { ...state, currentPlaying: action.payload }
  }
}

export const AppProvider = ({ initialState, children }) => {
  const [state, dispatch] = useReducer(reducer, initialState)
  const value = { state, dispatch }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

const { Consumer } = AppContext

export { Consumer as AppConsumer }

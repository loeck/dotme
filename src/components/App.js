import React from 'react'
import { hot } from 'react-hot-loader'
import { createGlobalStyle } from 'styled-components'

import { AppProvider } from 'contexts/App'
import Home from 'components/Home'

const GlobalStyle = createGlobalStyle`
* {
  -webkit-font-smoothing: antialiased;
  background: transparent;
  border: none;
  box-sizing: border-box;
  color: inherit;
  flex-shrink: 0;
  font: inherit;
  margin: 0;
  padding: 0;
}

body {
  background: black;
  font-family: 'Fira Sans', Helvetica, Arial, sans-serif;
  font-weight: 300;
  font-size: 13px;
  overflow: hidden;
}
`

const App = props => {
  const { tracks } = props
  const firstTrack = tracks[0]

  const initialState = {
    canPlaying: false,
    currentColor: firstTrack.color,
    currentLoading: null,
    currentPlaying: null,
    currentTrack: firstTrack,
    indexTrack: 0,
    progressTrack: 0,
    tracks,
  }

  return (
    <>
      <GlobalStyle />

      <AppProvider initialState={initialState}>
        <Home />
      </AppProvider>
    </>
  )
}

export default hot(module)(App)

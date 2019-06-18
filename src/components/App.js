import React from 'react'
import { hot } from 'react-hot-loader'
import { createGlobalStyle } from 'styled-components'

import { AppProvider } from 'contexts/App'
import Home from 'components/Home'

const GlobalStyle = createGlobalStyle`
  @import url('https://fonts.googleapis.com/css?family=Fira+Sans:300&display=optional');

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
    background: #000;
    font-family: 'Fira Sans', Helvetica, Arial, sans-serif;
    font-weight: 300;
    font-size: 13px;
    overflow: hidden;
  }

  .lazyload,
  .lazyloading {
  	opacity: 0;
  }
  .lazyloaded {
  	opacity: 1;
  	transition: opacity 300ms;
  }
`

const App = props => {
  const { tracks } = props
  const firstTrack = tracks[0]

  const initialState = {
    currentColor: firstTrack.color,
    currentTrack: firstTrack,
    indexTrack: 1,
    tracks: [
      {
        id: 'empty',
        empty: true,
      },
      ...tracks,
    ],
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

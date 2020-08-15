import React from 'react'
import { addDecorator } from '@storybook/react'
import { createGlobalStyle } from 'styled-components'
import 'lazysizes'

import mockTracks from '__mocks__/tracks'

import { style } from 'pages'
import { AppProvider, INITIAL_STATE } from 'contexts/App'

export const parameters = {
  actions: { argTypesRegex: '^on[A-Z].*' },
}

const GlobalStyle = createGlobalStyle`
  ${style}

  body {
    background: transparent;
  }
`

addDecorator((story, { args, ...p }) => (
  <>
    <GlobalStyle />
    <AppProvider
      forceInitialState
      initialState={{
        ...INITIAL_STATE,
        tracks: mockTracks,
        currentColor: {
          ...INITIAL_STATE.currentColor,
          isLight: args.isLight,
        },
      }}
    >
      {story()}
    </AppProvider>
  </>
))

/* eslint-disable */

import React from 'react'
import { hydrate } from 'react-dom'

import 'lazysizes'

import { AppContainer } from 'react-hot-loader'

import App from 'components/App'

const state = window.__INITIAL_STATE__
const rootNode = document.getElementById('root')

hydrate(
  <AppContainer>
    <App {...state} />
  </AppContainer>,
  rootNode,
)

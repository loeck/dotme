import React from 'react'
import { hydrate } from 'react-dom'
import { AppContainer } from 'react-hot-loader'
import 'lazysizes'

import App from 'components/App'

const rootNode = document.getElementById('root')

hydrate(
  <AppContainer>
    <App />
  </AppContainer>,
  rootNode,
)

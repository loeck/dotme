import React from 'react'
import { hydrate } from 'react-dom'

import { AppContainer } from 'react-hot-loader'

import App from 'components/App'

const state = window.__INITIAL_STATE__

const render = Component => {
  hydrate(<AppContainer>{Component(state)}</AppContainer>, document.getElementById('root'))
}

render(App)

if (module.hot) {
  module.hot.accept('components/App', () => {
    const nextApp = require('components/App')
    render(nextApp)
  })
}

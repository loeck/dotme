import React from 'react'

import { injectGlobal } from 'styled-components'

import Home from 'components/Home'

// eslint-disable-next-line no-unused-expressions
injectGlobal`
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

export default state => <Home {...state} />

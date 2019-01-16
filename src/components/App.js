import React from 'react'

import { createGlobalStyle } from 'styled-components'

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
}
`

export default state => (
  <>
    <GlobalStyle />

    <Home {...state} />
  </>
)

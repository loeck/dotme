import { css } from 'styled-components'

export const mobile = (...args) => css`
  @media only screen and (max-width: 1100px) {
    ${css(...args)};
  }
`

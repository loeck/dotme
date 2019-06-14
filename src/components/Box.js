import styled from 'styled-components'

const Box = styled.div`
  align-items: ${p => p.align};
  display: flex;
  flex-direction: ${p => (!p.horizontal ? 'column' : null)};
  flex-grow: ${p => (p.grow ? 1 : null)};
  justify-content: ${p => p.justify};
  ${p =>
    p.sticky &&
    `
    bottom: 0;
    left: 0;
    right: 0;
    top: 0;
  `} overflow: ${p => (p.scrollable ? 'auto' : null)};
  padding: ${p => (p.padding ? `${p.padding}px` : null)};
  position: ${p => (p.relative ? 'relative' : p.sticky ? 'absolute' : null)};

  > * + * {
    margin-left: ${p => (p.horizontal && p.flow ? `${p.flow}px` : null)};
    margin-top: ${p => (!p.horizontal && p.flow ? `${p.flow}px` : null)};
  }
`

export default Box

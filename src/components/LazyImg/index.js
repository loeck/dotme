import React from 'react'
import styled from 'styled-components'

const LazyImg = ({ alt, src, className }) => (
  <Img alt={alt} className={`lazyload ${className}`} data-src={src} />
)

export default LazyImg

const Img = styled.img``

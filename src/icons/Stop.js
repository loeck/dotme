import React from 'react'

const SvgComponent = props => (
  <svg
    viewBox="0 0 24 24"
    {...props} // eslint-disable-line react/jsx-props-no-spreading
  >
    <path
      fill="currentColor"
      d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5 17H7V7h10v10z"
    />
  </svg>
)

export default SvgComponent

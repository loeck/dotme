import React from 'react'

const SvgComponent = props => (
  <svg
    viewBox="0 0 24 24"
    {...props} // eslint-disable-line react/jsx-props-no-spreading
  >
    <path
      fill="currentColor"
      d="M23 12a10.96 10.96 0 0 1-.425 3h-2.101c.335-.94.526-1.947.526-3 0-4.962-4.037-9-9-9a8.898 8.898 0 0 0-4.655 1.314L9.203 7H2.209l2.152-7L6.21 2.673A10.906 10.906 0 0 1 12 1c6.074 0 11 4.925 11 11zm-6.354 7.692A8.903 8.903 0 0 1 12 21c-4.962 0-9-4.038-9-9 0-1.053.191-2.06.525-3h-2.1A10.96 10.96 0 0 0 1 12c0 6.075 4.925 11 11 11 2.127 0 4.099-.621 5.78-1.667L19.633 24l2.152-6.989h-6.994l1.855 2.681z"
    />
  </svg>
)

export default SvgComponent

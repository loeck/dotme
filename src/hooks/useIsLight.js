import { useContext } from 'react'

import { AppContext } from 'contexts/App'

export default function useIsLight() {
  const {
    state: {
      currentColor: { isLight },
    },
  } = useContext(AppContext)
  return isLight
}

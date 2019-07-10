import useWindowSize from './useWindowSize'

const DEFAULT_BREAKPOINT = 1100

function useMobile() {
  const windowSize = useWindowSize()

  return windowSize.width < DEFAULT_BREAKPOINT
}

export default useMobile

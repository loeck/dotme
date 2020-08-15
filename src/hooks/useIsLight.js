import { useAppContext } from 'contexts/App'

const useIsLight = () => {
  const {
    state: {
      currentColor: { isLight },
    },
  } = useAppContext()

  return isLight
}

export default useIsLight

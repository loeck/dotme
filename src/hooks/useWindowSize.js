import { useState, useEffect } from 'react'

function getSize() {
  if (typeof window !== 'undefined') {
    return {
      height: window.innerHeight,
      width: window.innerWidth,
    }
  }

  return {
    height: 0,
    width: 0,
  }
}

function useWindowSize() {
  const [windowSize, setWindowSize] = useState(getSize())

  function handleResize() {
    setWindowSize(getSize())
  }

  useEffect(() => {
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return windowSize
}

export default useWindowSize

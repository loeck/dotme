import * as React from 'react'

export const ImageAlbum = ({ image, onLoadColor }) => {
  const imgRef = React.useRef(null)

  React.useEffect(() => {
    if (imgRef.current) {
      imgRef.current.src = image
    }
  }, [image])

  const handleLoad = (e) => {
    const rgb = getAverageRGB(e.target)

    onLoadColor(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`)
  }

  return (
    <img
      ref={imgRef}
      alt=""
      loading="lazy"
      width={88}
      src={onLoadColor ? undefined : image}
      onLoad={onLoadColor ? handleLoad : undefined}
      referrerPolicy="no-referrer"
      crossOrigin="anonymous"
    />
  )
}

const getAverageRGB = (imgEl) => {
  const blockSize = 5

  const rgb = {
    r: 0,
    g: 0,
    b: 0,
  }

  const canvas = document.createElement('canvas')
  canvas.height = imgEl.naturalHeight
  canvas.width = imgEl.naturalWidth

  const context = canvas.getContext('2d')
  context.drawImage(imgEl, 0, 0)

  let data

  try {
    data = context.getImageData(0, 0, canvas.width, canvas.height)
  } catch (e) {
    return {
      r: 0,
      g: 0,
      b: 0,
    }
  }

  const length = data.data.length

  let count = 0
  let i = -4

  while ((i += blockSize * 4) < length) {
    ++count
    rgb.r += data.data[i]
    rgb.g += data.data[i + 1]
    rgb.b += data.data[i + 2]
  }

  rgb.r = ~~(rgb.r / count)
  rgb.g = ~~(rgb.g / count)
  rgb.b = ~~(rgb.b / count)

  return rgb
}

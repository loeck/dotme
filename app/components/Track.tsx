import { m, AnimatePresence } from 'framer-motion'
import * as React from 'react'

import { Highlight } from '~/components/Highlight'
import { ImageAlbum } from '~/components/ImageAlbum'

export const Track = ({ currentTrack, scrollContainer, track, onChange }) => {
  const [trackColor, setTrackColor] = React.useState<string | null>(null)
  const [colorVariant, setColorVariant] = React.useState<
    'light' | 'dark' | null
  >(null)

  const nodeRef = React.useRef(null)

  React.useEffect(() => {
    let timeoutID

    if (nodeRef.current && scrollContainer.current) {
      const handleScroll = (delay) => () => {
        clearTimeout(timeoutID)

        timeoutID = setTimeout(async () => {
          if (
            nodeRef.current.getBoundingClientRect().top ===
            (window.innerWidth >= 1280 ? 100 : 184)
          ) {
            onChange({
              track,
              trackColor: trackColor.rgb,
              colorVariant,
            })
          }
        }, delay)
      }

      scrollContainer.current.addEventListener('scroll', handleScroll(250))

      handleScroll(0)()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollContainer.current])

  const activeTrack = currentTrack?.track?.id === track.id

  return (
    <>
      <div className="invisible absolute">
        <ImageAlbum
          image={track.album.image.url}
          onLoadColor={(color: string) => {
            setTrackColor(color)
            setColorVariant(getColorVariant(color.rgb))
          }}
        />
      </div>

      <AnimatePresence>
        {colorVariant && trackColor && (
          <m.div
            ref={nodeRef}
            className={
              'select-none relative flex p-6 gap-4 items-center h-[136px] xl:w-[500px] overflow-hidden z-20'
            }
            initial={{
              opacity: 0,
            }}
            animate={{
              opacity: 1,
              zIndex: activeTrack ? 'auto' : 20,
            }}
            style={{
              color: colorVariant === 'light' ? '#000' : '#fff',
            }}
          >
            <div className="relative z-20 shrink-0">
              <ImageAlbum image={track.album.image.url} />
            </div>

            <div className="relative z-20 flex flex-1 flex-col gap-2 overflow-hidden">
              <div>{track.name}</div>
              <div className="flex gap-2 overflow-auto">
                {track.artists.map((artist) => (
                  <Highlight key={artist.id} variant={colorVariant}>
                    {artist.name}
                  </Highlight>
                ))}
              </div>
            </div>

            {!activeTrack && (
              <m.div
                className="absolute inset-0 z-10 pointer-events-none"
                initial={{
                  opacity: 0,
                }}
                animate={{
                  opacity: 1,
                }}
                exit={{
                  opacity: 0,
                }}
                style={{
                  backgroundColor: trackColor.rgba(1),
                }}
              />
            )}
          </m.div>
        )}
      </AnimatePresence>
    </>
  )
}

const getColorVariant = (color) => {
  const colorValues = color.match(
    /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)$/
  )

  const r = colorValues[1]
  const g = colorValues[2]
  const b = colorValues[3]

  const hsp = Math.sqrt(0.299 * (r * r) + 0.587 * (g * g) + 0.114 * (b * b))

  if (hsp > 127.5) {
    return 'light'
  }

  return 'dark'
}

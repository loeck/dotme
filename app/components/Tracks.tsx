import * as React from 'react'

import { Track } from '~/components/Track'

export const Tracks = React.forwardRef(
  ({ currentTrack, tracks, onChange }, forwardedRef) => {
    const scrollContainerRef = React.useRef(null)

    React.useImperativeHandle(forwardedRef, () => ({
      nextTrack: () => {
        const lastTrack = currentTrack?.track?.id === tracks.at(-1).id

        if (!lastTrack) {
          scrollContainerRef.current.scrollTop = `${
            scrollContainerRef.current.scrollTop + 136
          }`

          return true
        }

        return false
      },
      previousTrack: () => {
        const firstTrack = currentTrack?.track?.id === tracks.at(0).id

        if (!firstTrack) {
          scrollContainerRef.current.scrollTop = `${
            scrollContainerRef.current.scrollTop + 136
          }`

          return true
        }

        return false
      },
    }))

    return (
      <div
        className="scroll-smooth overflow-auto snap-y absolute inset-0 flex flex-col xl:items-end xl:pr-[100px] xl:pt-[100px] pb-[calc(100vh-136px)] xl:pb-[calc(100vh-236px)] xl:scroll-pt-[100px] pt-[184px] scroll-pt-[184px]"
        ref={scrollContainerRef}
      >
        {tracks.map((track) => (
          <div className="snap-start" key={track.id}>
            <Track
              scrollContainer={scrollContainerRef}
              track={track}
              currentTrack={currentTrack}
              onChange={onChange}
            />
          </div>
        ))}
      </div>
    )
  }
)

Tracks.displayName = 'Tracks'

import * as React from 'react'

import { Track } from '~/components/Track'

export const Tracks = ({ currentTrack, tracks, onChange }) => {
  const scrollContainerRef = React.useRef(null)

  return (
    <div
      className="overflow-auto snap-y absolute inset-0 flex flex-col items-end pr-[100px] pt-[100px] pb-[calc(100vh-236px)] scroll-pt-[100px]"
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

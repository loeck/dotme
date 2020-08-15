import React from 'react'

import mockTracks from '__mocks__/tracks'

import { InnerTrack } from './'

export default {
  title: 'Track',
  component: InnerTrack,
  args: {
    isLight: false,
  },
}

const Template = (args) => {
  const [track] = mockTracks
  track.color.value = args.isLight ? '#d3d3d3' : '#000000'
  track.color.isLight = args.isLight

  return <InnerTrack {...args} {...track} />
}

export const defaultStory = Template.bind({})

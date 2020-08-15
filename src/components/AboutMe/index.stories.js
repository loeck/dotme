import React from 'react'

import { InnerAboutMe } from './'

export default {
  title: 'AboutMe',
  component: InnerAboutMe,
  args: {
    isLight: false,
    withMediaControls: false,
  },
}

const Template = (args) => <InnerAboutMe {...args} />

export const defaultStory = Template.bind({})

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Profile } from './Profile'

describe('Profile', () => {
  it('renders the public profile and social links', () => {
    render(<Profile />)

    expect(screen.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
    expect(screen.getByText('Based in Paris, France.')).toBeVisible()
    expect(screen.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/loeck',
    )
    expect(screen.queryByText(/Spotify|Last.fm|Piana/i)).not.toBeInTheDocument()
  })
})

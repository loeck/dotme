import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Profile } from './Profile'

describe('Profile', () => {
  it('renders the public profile and social links', () => {
    render(<Profile />)

    expect(screen.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
    expect(
      screen.getByText('Building some stuff in Paris, still figuring out the rest.'),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/loeck',
    )
    expect(screen.queryByRole('link', { name: /Last.fm/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Spotify|Piana/i)).not.toBeInTheDocument()
  })
})

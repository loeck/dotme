import { describe, expect, it } from 'vitest'

import { ResourceScope } from './resource-scope'

describe('partial GPU resource ownership', () => {
  it('releases allocations in reverse order even when one destructor fails', () => {
    const scope = new ResourceScope()
    const freed: number[] = []
    scope.own({
      dispose() {
        freed.push(1)
      },
    })
    scope.own({
      dispose() {
        freed.push(2)
        throw new Error('Lost device')
      },
    })
    scope.own({
      dispose() {
        freed.push(3)
      },
    })
    scope.dispose()
    scope.dispose()
    expect(freed).toEqual([3, 2, 1])
  })
  it('releases a late allocation after cancellation', () => {
    const scope = new ResourceScope()
    scope.dispose()
    let released = false
    scope.own({
      dispose() {
        released = true
      },
    })
    expect(released).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import { parseWorldPart, serializeWorldPart } from './world-cache'

const part = () => {
  const shared = new Uint8Array([1, 2, 3])
  return {
    terrain: { positions: new Float32Array([0.5, -1.25, 3]), indices: new Uint32Array([0, 1, 2]) },
    atlas: {
      data: shared,
      mipmaps: [
        { width: 1, data: shared },
        { width: 0, data: new Int8Array([-4]) },
      ],
    },
    labels: ['a', null, 7],
    view: new Uint16Array(new Uint16Array([9, 8, 7, 6]).buffer, 2, 2),
  }
}

const contents = async (blob: Blob) => blob.arrayBuffer()
const at = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (node, key) =>
      node !== null && typeof node === 'object'
        ? Object.entries(node).find(([name]) => name === String(key))?.[1]
        : undefined,
    value,
  )

describe('world cache files', () => {
  it('round-trips typed arrays, nested values and shared views', async () => {
    const stored = await contents(serializeWorldPart('v1', 42, part()))
    const restored = parseWorldPart(stored, 'v1', 42)
    expect(restored).toEqual(part())
    // One copy of a view referenced twice, each array on its own transferable buffer.
    const data = at(restored, 'atlas', 'data')
    expect(at(restored, 'atlas', 'mipmaps', 0, 'data')).toBe(data)
    expect(data).toBeInstanceOf(Uint8Array)
    expect(data).toHaveProperty('byteOffset', 0)
    expect(data).toHaveProperty('buffer.byteLength', 3)
  })
  it('ignores another generator, another seed or a truncated file', async () => {
    const stored = await contents(serializeWorldPart('v1', 42, part()))
    expect(parseWorldPart(stored, 'v2', 42)).toBeUndefined()
    expect(parseWorldPart(stored, 'v1', 43)).toBeUndefined()
    expect(parseWorldPart(stored.slice(0, stored.byteLength - 1), 'v1', 42)).toBeUndefined()
  })
})

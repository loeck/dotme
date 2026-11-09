import { describe, expect, it } from 'vitest'

import { parseWorldPart, serializeWorldPart } from './world-cache'
import { worldTransfers } from './world-data'

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
    tops: new Float64Array([Math.PI, -0]),
    labels: ['a', null, 7],
    view: new Uint16Array(new Uint16Array([9, 8, 7, 6]).buffer, 2, 2),
  }
}

/** Empty arrays take no bytes, so each shares its offset with the array stored after it. */
const withEmpties = () => ({
  empty: new Float32Array(0),
  indices: new Uint32Array([1, 2, 3]),
  none: new Uint32Array(0),
  bytes: new Uint8Array(0),
  after: new Float32Array([4.5]),
  mixed: [new Int16Array(0), new Int16Array([-7, 8]), new Float64Array([2.25])],
})

const at = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (node, key) =>
      node !== null && typeof node === 'object'
        ? Object.entries(node).find(([name]) => name === String(key))?.[1]
        : undefined,
    value,
  )

/** A large, compressible part: the deflated file must be much smaller than its arrays. */
const mesh = () => {
  const positions = new Float32Array(30_000)
  for (let i = 0; i < positions.length; i++) positions[i] = Math.round(Math.sin(i / 50) * 400) / 8
  return { positions, indices: Uint32Array.from({ length: 60_000 }, (_, i) => i >> 1) }
}

describe('world cache files', () => {
  for (const compress of [true, false])
    it(`round-trips typed arrays, nested values and shared views (${compress ? 'deflate' : 'raw'})`, async () => {
      const stored = await serializeWorldPart('v1', 42, part(), compress)
      const restored = await parseWorldPart(stored, 'v1', 42)
      expect(restored).toEqual(part())
      expect(Object.is(at(restored, 'tops', 1), -0)).toBe(true)
      // One view for an array referenced twice, all views over one transferable buffer.
      const data = at(restored, 'atlas', 'data')
      expect(at(restored, 'atlas', 'mipmaps', 0, 'data')).toBe(data)
      expect(data).toBeInstanceOf(Uint8Array)
      const buffers = worldTransfers(restored)
      expect(buffers).toHaveLength(1)
      for (const path of [['terrain', 'positions'], ['tops'], ['view']] as const) {
        const view = at(restored, ...path)
        if (!ArrayBuffer.isView(view)) throw new Error('Missing view')
        expect(view.buffer).toBe(buffers[0])
        expect(view.byteOffset % 8).toBe(0)
      }
    })
  for (const compress of [true, false])
    it(`keeps empty arrays apart from the array stored after them (${compress ? 'deflate' : 'raw'})`, async () => {
      const restored = await parseWorldPart(
        await serializeWorldPart('v1', 42, withEmpties(), compress),
        'v1',
        42,
      )
      expect(restored).toEqual(withEmpties())
      expect(at(restored, 'indices')).toBeInstanceOf(Uint32Array)
      expect(at(restored, 'after')).toBeInstanceOf(Float32Array)
      expect(at(restored, 'mixed', 1)).toBeInstanceOf(Int16Array)
    })
  it('deflates the arrays', async () => {
    const raw = await serializeWorldPart('v1', 42, mesh(), false)
    const deflated = await serializeWorldPart('v1', 42, mesh(), true)
    expect(deflated.size).toBeLessThan(raw.size / 4)
    expect(await parseWorldPart(deflated, 'v1', 42)).toEqual(mesh())
  })
  it('ignores another generator, another seed or a truncated file', async () => {
    for (const compress of [true, false]) {
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      const stored = await serializeWorldPart('v1', 42, part(), compress)
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await expect(parseWorldPart(stored, 'v2', 42)).resolves.toBeUndefined()
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await expect(parseWorldPart(stored, 'v1', 43)).resolves.toBeUndefined()
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await expect(
        parseWorldPart(stored.slice(0, stored.size - 1), 'v1', 42),
      ).resolves.toBeUndefined()
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await expect(parseWorldPart(stored.slice(0, 2), 'v1', 42)).resolves.toBeUndefined()
    }
  })
  it('ignores files of the previous format', async () => {
    const header = new TextEncoder().encode(
      JSON.stringify({ version: 'v1', seed: 42, bytes: 0, value: {} }),
    )
    const prefix = new Uint8Array(Math.ceil((4 + header.byteLength) / 8) * 8)
    new DataView(prefix.buffer).setUint32(0, header.byteLength, true)
    prefix.set(header, 4)
    await expect(parseWorldPart(new Blob([prefix]), 'v1', 42)).resolves.toBeUndefined()
  })
  it('rejects a corrupt deflated payload', async () => {
    const stored = new Uint8Array(
      await (await serializeWorldPart('v1', 42, mesh(), true)).arrayBuffer(),
    )
    // Flip bytes inside the deflate stream, past the header.
    for (let i = stored.length - 64; i < stored.length - 32; i++)
      stored[i] = (stored[i] ?? 0) ^ 0xff
    await expect(
      parseWorldPart(new Blob([stored]), 'v1', 42).then(
        (value) => value === undefined,
        () => true,
      ),
    ).resolves.toBe(true)
  })
})

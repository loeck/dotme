import { storage } from '../env'
/**
 * Prepared world parts kept between visits in the origin private file system. Reads and writes
 * happen inside the world worker, so neither the copies of tens of megabytes nor the file
 * round trips reach the render thread; a hit is transferred to the page like a freshly
 * generated part. Each part is one file: a JSON header describing the value, with every typed
 * array replaced by a reference into the bytes that follow, deflated as one stream. Plain files
 * keep the write cheap; an IndexedDB store of the same data kept the browser busy long enough
 * to stall the GPU compiles of a reload.
 *
 * Each header carries the file format, the generator's version (the content-hashed worker URL)
 * and its seed, so a new build or a different world is never served. One file per part and
 * profile is kept: storing the next world replaces the previous one. Files are written with
 * `createWritable`, which commits atomically on close; a browser without it never stores one.
 */
const DIRECTORY = 'dotme-world'

export type CachedWorldPart = 'terrain' | 'surfaces' | 'vegetation'

const VIEWS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
} as const
type ViewName = keyof typeof VIEWS
type View = InstanceType<(typeof VIEWS)[ViewName]>

const isViewName = (name: unknown): name is ViewName =>
  typeof name === 'string' && Object.hasOwn(VIEWS, name)

/** A typed array in the header: its constructor, byte offset and element count. */
type ViewRef = Readonly<{ $view: ViewName; offset: number; length: number }>

const fileName = (mobile: boolean, part: CachedWorldPart) =>
  `${mobile ? 'mobile' : 'desktop'}-${part}.bin`

const ALIGN = 8
const align = (offset: number) => Math.ceil(offset / ALIGN) * ALIGN

function viewName(view: ArrayBufferView): ViewName | undefined {
  for (const name of Object.keys(VIEWS))
    if (isViewName(name) && view instanceof VIEWS[name]) return name
  return undefined
}

/** The header value and the views to append, in order, after the header. */
function encode(value: unknown) {
  const views: ArrayBufferView[] = []
  const refs = new Map<ArrayBufferView, ViewRef>()
  let offset = 0
  const visit = (child: unknown): unknown => {
    if (ArrayBuffer.isView(child)) {
      const known = refs.get(child)
      if (known) return known
      const name = viewName(child)
      if (!name) throw new TypeError('Unsupported view in prepared world')
      const ref: ViewRef = {
        $view: name,
        offset,
        length: child.byteLength / VIEWS[name].BYTES_PER_ELEMENT,
      }
      refs.set(child, ref)
      views.push(child)
      offset = align(offset + child.byteLength)
      return ref
    }
    if (Array.isArray(child)) return child.map(visit)
    if (child !== null && typeof child === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(child)) result[key] = visit(item)
      return result
    }
    return child
  }
  return { value: visit(value), views, bytes: offset }
}

function isViewRef(value: object): value is ViewRef {
  return (
    '$view' in value &&
    isViewName(value.$view) &&
    'offset' in value &&
    typeof value.offset === 'number' &&
    'length' in value &&
    typeof value.length === 'number'
  )
}

/**
 * Rebuilds the value over `data`: every typed array is a view at its aligned offset in the one
 * buffer, so a hit costs no second copy. Transferring the part moves that whole buffer, which
 * holds nothing but this part's arrays.
 */
function decode(value: unknown, data: ArrayBuffer): unknown {
  // A shared array is one reference, encoded identically wherever it appears. The offset alone
  // is not a key: an empty array takes no bytes, so the next array starts at its offset.
  const views = new Map<string, View>()
  const visit = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(visit)
    if (child === null || typeof child !== 'object') return child
    if (isViewRef(child)) {
      const key = `${child.$view}:${child.offset}:${child.length}`
      const known = views.get(key)
      if (known) return known
      const View = VIEWS[child.$view]
      const end = child.offset + child.length * View.BYTES_PER_ELEMENT
      if (
        !Number.isInteger(child.offset) ||
        !Number.isInteger(child.length) ||
        child.offset < 0 ||
        child.offset % View.BYTES_PER_ELEMENT !== 0 ||
        end > data.byteLength
      )
        throw new RangeError('Prepared world reference out of bounds')
      const view = new View(data, child.offset, child.length)
      views.set(key, view)
      return view
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(child)) result[key] = visit(item)
    return result
  }
  return visit(value)
}

/**
 * Bump when the file layout changes. The worker URL changes with any build of this module too;
 * the constant also guards a layout change that a hash collision or a manual deploy would miss.
 */
const FORMAT = 3

/**
 * `deflate-raw` shrinks a part about threefold (mostly float meshes, indices and the foliage
 * atlas) and inflates in tens of milliseconds; `raw` is for browsers without compression streams.
 */
type Encoding = 'deflate-raw' | 'raw'

type Header = Readonly<{
  format: number
  version: string
  seed: number
  encoding: Encoding
  /** Decoded payload size. */
  bytes: number
  /** Stored payload size. */
  stored: number
  value: unknown
}>

function isHeader(value: unknown): value is Header {
  return (
    value !== null &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === FORMAT &&
    'version' in value &&
    typeof value.version === 'string' &&
    'seed' in value &&
    typeof value.seed === 'number' &&
    'encoding' in value &&
    (value.encoding === 'deflate-raw' || value.encoding === 'raw') &&
    'bytes' in value &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    'stored' in value &&
    typeof value.stored === 'number' &&
    'value' in value
  )
}

async function directory(create: boolean) {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
    throw new Error('File system storage is unavailable')
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(DIRECTORY, { create })
}

const canCompress = () =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'

/** The typed arrays of a part, aligned as the header's references expect. */
function payload(views: readonly ArrayBufferView[], bytes: number): Blob {
  const chunks: BlobPart[] = []
  let written = 0
  for (const view of views) {
    const padding = align(written) - written
    if (padding) chunks.push(new Uint8Array(padding))
    written = align(written)
    const { buffer } = view
    chunks.push(
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, view.byteOffset, view.byteLength)
        : new Uint8Array(new Uint8Array(buffer, view.byteOffset, view.byteLength)),
    )
    written += view.byteLength
  }
  if (bytes > written) chunks.push(new Uint8Array(bytes - written))
  return new Blob(chunks)
}

/**
 * One part as file contents: header length, JSON header, then the part's typed arrays, aligned
 * and deflated as one stream where the browser can.
 */
export async function serializeWorldPart(
  version: string,
  seed: number,
  data: unknown,
  compress = canCompress(),
): Promise<Blob> {
  const { value, views, bytes } = encode(data)
  const raw = payload(views, bytes)
  const body = compress
    ? await new Response(raw.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob()
    : raw
  const header: Header = {
    format: FORMAT,
    version,
    seed,
    encoding: compress ? 'deflate-raw' : 'raw',
    bytes,
    stored: body.size,
    value,
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const prefix = new Uint8Array(align(4 + json.byteLength))
  new DataView(prefix.buffer).setUint32(0, json.byteLength, true)
  prefix.set(json, 4)
  return new Blob([prefix, body])
}

/** Inflates straight into one buffer of the recorded size: no chunk list, no second copy. */
async function inflate(stored: Blob, bytes: number): Promise<ArrayBuffer | undefined> {
  const output = new Uint8Array(bytes)
  const reader = stored.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  let offset = 0
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read in order
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > bytes) {
        // Longer than recorded: stop inflating the rest instead of draining it.
        // eslint-disable-next-line no-await-in-loop -- leaves the loop right after
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      output.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return offset === bytes ? output.buffer : undefined
}

/**
 * The part stored in `contents` if it was written in this format for exactly this generator and
 * seed and is complete, else `undefined`. Throws on malformed contents.
 */
export async function parseWorldPart(
  contents: Blob,
  version: string,
  seed: number,
): Promise<unknown> {
  if (contents.size < 4) return undefined
  const headerBytes = new DataView(await contents.slice(0, 4).arrayBuffer()).getUint32(0, true)
  const dataStart = align(4 + headerBytes)
  if (dataStart > contents.size) return undefined
  const header: unknown = JSON.parse(
    new TextDecoder().decode(await contents.slice(4, 4 + headerBytes).arrayBuffer()),
  )
  if (!isHeader(header) || header.version !== version || header.seed !== seed) return undefined
  if (contents.size !== dataStart + header.stored) return undefined
  const body = contents.slice(dataStart)
  let data: ArrayBuffer | undefined
  if (header.encoding === 'raw')
    data = header.stored === header.bytes ? await body.arrayBuffer() : undefined
  else data = canCompress() ? await inflate(body, header.bytes) : undefined
  return data && decode(header.value, data)
}

/** The stored part for exactly this generator and seed, or `undefined`. Never throws. */
export async function readCachedPart(
  version: string,
  seed: number,
  mobile: boolean,
  part: CachedWorldPart,
): Promise<unknown> {
  try {
    const handle = await (await directory(false)).getFileHandle(fileName(mobile, part))
    return await parseWorldPart(await handle.getFile(), version, seed)
  } catch {
    return undefined
  }
}

async function writePart(folder: FileSystemDirectoryHandle, name: string, contents: Blob) {
  const handle = await folder.getFileHandle(name, { create: true })
  // Written to a swap file and committed on close: a reader never sees half a part.
  const writable = await handle.createWritable()
  try {
    await writable.write(contents)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

/** Replaces the stored world of this profile with every part of `seed`. */
export async function storeWorld(
  version: string,
  seed: number,
  mobile: boolean,
  parts: Readonly<Record<CachedWorldPart, unknown>>,
): Promise<void> {
  const folder = await directory(true)
  // One part at a time keeps a single part's copy in flight; each file commits on its own,
  // and a reader only accepts a part whose header names this seed.
  for (const part of ['terrain', 'surfaces', 'vegetation'] as const)
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
    await writePart(
      folder,
      fileName(mobile, part),
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
      await serializeWorldPart(version, seed, parts[part]),
    )
}

/**
 * Bytes the stored world of this profile takes now, which storing the next one replaces; 0 when
 * nothing is stored or storage is unavailable. Never throws.
 */
export async function storedWorldBytes(mobile: boolean): Promise<number> {
  try {
    const folder = await directory(false)
    const sizes = await Promise.all(
      (['terrain', 'surfaces', 'vegetation'] as const).map(async (part) => {
        try {
          return (await (await folder.getFileHandle(fileName(mobile, part))).getFile()).size
        } catch {
          return 0
        }
      }),
    )
    return sizes.reduce((sum, size) => sum + size, 0)
  } catch {
    return 0
  }
}

/**
 * Stored size of a world, for the quota check before preparing one: deflated parts of seed 9182
 * plus headroom (about 31 MB on desktop and 8 MB on phones; raw files are three times larger).
 */
export function expectedWorldBytes(mobile: boolean) {
  const deflated = mobile ? 10e6 : 40e6
  return canCompress() ? deflated : deflated * 3
}

const NEXT_SEED_KEY = 'dotme:next-world-seed'

/**
 * The seed whose world was prepared for this visit by the previous one, consumed so that every
 * visit still shows a new world even when the next one is never prepared.
 */
export function takeNextSeed(): number | undefined {
  try {
    const store = storage()
    const raw = store?.getItem(NEXT_SEED_KEY)
    store?.removeItem(NEXT_SEED_KEY)
    const seed = Number(raw)
    return raw && Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff ? seed : undefined
  } catch {
    return undefined
  }
}

export function rememberNextSeed(seed: number) {
  try {
    storage()?.setItem(NEXT_SEED_KEY, String(seed))
  } catch {
    /* Private modes may refuse storage; the next visit simply generates its world. */
  }
}

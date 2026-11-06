/**
 * Prepared world parts kept between visits in the origin private file system. Reads and writes
 * happen inside the world worker, so neither the copies of tens of megabytes nor the file
 * round trips reach the render thread; a hit is transferred to the page like a freshly
 * generated part. Each part is one file: a JSON header describing the value, with every typed
 * array replaced by a reference into the raw bytes that follow. Raw files keep the write cheap;
 * an IndexedDB store of the same data kept the browser busy long enough to stall the GPU
 * compiles of a reload.
 *
 * Each header carries the generator's version (the content-hashed worker URL) and its seed, so
 * a new build or a different world is never served. One file per part and profile is kept:
 * storing the next world replaces the previous one. Files are written with `createWritable`,
 * which commits atomically on close; a browser without it simply never stores a world.
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

type Header = Readonly<{ version: string; seed: number; bytes: number; value: unknown }>

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

/** Rebuilds the value; each typed array gets its own buffer so it can be transferred. */
function decode(value: unknown, data: ArrayBuffer): unknown {
  const views = new Map<number, View>()
  const visit = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(visit)
    if (child === null || typeof child !== 'object') return child
    if (isViewRef(child)) {
      const known = views.get(child.offset)
      if (known) return known
      const View = VIEWS[child.$view]
      const end = child.offset + child.length * View.BYTES_PER_ELEMENT
      if (!Number.isInteger(child.offset) || child.offset < 0 || end > data.byteLength)
        throw new RangeError('Prepared world reference out of bounds')
      const view = new View(data.slice(child.offset, end))
      views.set(child.offset, view)
      return view
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(child)) result[key] = visit(item)
    return result
  }
  return visit(value)
}

function isHeader(value: unknown): value is Header {
  return (
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    typeof value.version === 'string' &&
    'seed' in value &&
    typeof value.seed === 'number' &&
    'bytes' in value &&
    typeof value.bytes === 'number' &&
    'value' in value
  )
}

async function directory(create: boolean) {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
    throw new Error('File system storage is unavailable')
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(DIRECTORY, { create })
}

/** One part as file contents: header length, JSON header, then the aligned typed arrays. */
export function serializeWorldPart(version: string, seed: number, data: unknown): Blob {
  const { value, views, bytes } = encode(data)
  const header: Header = { version, seed, bytes, value }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const prefix = new Uint8Array(align(4 + json.byteLength))
  new DataView(prefix.buffer).setUint32(0, json.byteLength, true)
  prefix.set(json, 4)
  const chunks: BlobPart[] = [prefix]
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
 * The part stored in `contents` if it was written for exactly this generator and seed and is
 * complete, else `undefined`. Throws on malformed contents.
 */
export function parseWorldPart(contents: ArrayBuffer, version: string, seed: number): unknown {
  const headerBytes = new DataView(contents, 0, 4).getUint32(0, true)
  const dataStart = align(4 + headerBytes)
  const header: unknown = JSON.parse(
    new TextDecoder().decode(new Uint8Array(contents, 4, headerBytes)),
  )
  if (!isHeader(header) || header.version !== version || header.seed !== seed) return undefined
  if (contents.byteLength !== dataStart + header.bytes) return undefined
  return decode(header.value, contents.slice(dataStart))
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
    return parseWorldPart(await (await handle.getFile()).arrayBuffer(), version, seed)
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
    await writePart(folder, fileName(mobile, part), serializeWorldPart(version, seed, parts[part]))
}

const NEXT_SEED_KEY = 'dotme:next-world-seed'

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

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

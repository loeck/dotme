/**
 * Fetches and decodes the terrain scans without Three.js, so the loader entry can start them
 * alongside world preparation; `terrain-textures.ts` wraps the decoded images once the
 * landscape builds its materials. Files are content-hashed assets (`new URL` literals, served
 * immutable); low-power devices take half-resolution variants, a quarter of the transfer and
 * of the GPU memory.
 */
const SCAN_NAMES = ['grass_ground', 'forest_floor', 'rock_01', 'bark_brown_01'] as const
export type ScanName = (typeof SCAN_NAMES)[number]
type ScanUrls = Readonly<{ color: URL; surface: URL }>

/** Literal URLs, so the bundler hashes and emits exactly these files. */
const FULL: Readonly<Record<ScanName, ScanUrls>> = {
  grass_ground: {
    color: new URL('../assets/textures/terrain/grass_ground-color.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/grass_ground-surface.webp', import.meta.url),
  },
  forest_floor: {
    color: new URL('../assets/textures/terrain/forest_floor-color.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/forest_floor-surface.webp', import.meta.url),
  },
  rock_01: {
    color: new URL('../assets/textures/terrain/rock_01-color.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/rock_01-surface.webp', import.meta.url),
  },
  bark_brown_01: {
    color: new URL('../assets/textures/terrain/bark_brown_01-color.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/bark_brown_01-surface.webp', import.meta.url),
  },
}

/** 512px color and 256px surface maps for the low-power profile. */
const HALF: Readonly<Record<ScanName, ScanUrls>> = {
  grass_ground: {
    color: new URL('../assets/textures/terrain/grass_ground-color-512.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/grass_ground-surface-256.webp', import.meta.url),
  },
  forest_floor: {
    color: new URL('../assets/textures/terrain/forest_floor-color-512.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/forest_floor-surface-256.webp', import.meta.url),
  },
  rock_01: {
    color: new URL('../assets/textures/terrain/rock_01-color-512.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/rock_01-surface-256.webp', import.meta.url),
  },
  bark_brown_01: {
    color: new URL('../assets/textures/terrain/bark_brown_01-color-512.webp', import.meta.url),
    surface: new URL('../assets/textures/terrain/bark_brown_01-surface-256.webp', import.meta.url),
  },
}

function scanUrls(lowPower: boolean): Readonly<Record<ScanName, ScanUrls>> {
  return lowPower ? HALF : FULL
}

/**
 * A decoded scan image. An `ImageBitmap` is decoded off the main thread and already flipped
 * (upload must not flip it again: WebGL ignores the flip flag for bitmaps); an image element is
 * the fallback where `createImageBitmap` cannot decode a blob.
 */
export type ScanImage = Readonly<
  { image: ImageBitmap; flipped: true } | { image: HTMLImageElement; flipped: false }
>
export type ScanImages = Readonly<
  Record<ScanName, Promise<Readonly<{ color: ScanImage; surface: ScanImage }>>>
>

async function decodeElement(url: URL): Promise<ScanImage> {
  const image = new Image()
  image.decoding = 'async'
  image.src = url.href
  await image.decode()
  return { image, flipped: false }
}

async function decode(url: URL): Promise<ScanImage> {
  if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function')
    return decodeElement(url)
  // Low priority: the landscape chunk and physics share the connection and gate the load sooner.
  const response = await fetch(url, { priority: 'low' })
  if (!response.ok) throw new Error(`Terrain scan unavailable: ${url.pathname}`)
  const blob = await response.blob()
  try {
    // Data maps and sRGB color alike are uploaded as stored, without any conversion.
    const image = await createImageBitmap(blob, {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
    return { image, flipped: true }
  } catch {
    return decodeElement(url)
  }
}

function loadImages(lowPower: boolean): ScanImages {
  const urls = scanUrls(lowPower)
  const pair = async (name: ScanName) => {
    const [color, surface] = await Promise.all([
      decode(urls[name].color),
      decode(urls[name].surface),
    ])
    return { color, surface }
  }
  const images: ScanImages = {
    grass_ground: pair('grass_ground'),
    forest_floor: pair('forest_floor'),
    rock_01: pair('rock_01'),
    bark_brown_01: pair('bark_brown_01'),
  }
  for (const name of SCAN_NAMES)
    images[name].catch(() => {
      // Consumers observe failures per material; an unused preload must not report them. A
      // failed scan is not cached: the next landscape (a retry, the next world) loads afresh.
      if (preloaded === images) preloaded = undefined
    })
  return images
}

let preloaded: ScanImages | undefined

/**
 * Starts fetching and decoding the scans for this page, once; the landscape takes them later
 * with `terrainImages`. Called before the GPU device, alongside world preparation.
 */
export function preloadTerrainImages(lowPower: boolean) {
  preloaded ??= loadImages(lowPower)
}

/** The page's preloaded scans, or a new load when nothing preloaded them. */
export function terrainImages(lowPower: boolean): ScanImages {
  preloaded ??= loadImages(lowPower)
  return preloaded
}

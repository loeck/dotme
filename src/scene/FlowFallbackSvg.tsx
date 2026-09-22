import { FLOW_CURVES, filamentPath, pointOnFilament } from './flow-model'
import type { FlowVariant } from './flow-model'

const FALLBACK_FILAMENTS = 24

function FallbackPaths({ variant }: Readonly<{ variant: FlowVariant }>) {
  return Array.from({ length: FALLBACK_FILAMENTS }, (_, index) => {
    const lane = (index / (FALLBACK_FILAMENTS - 1)) * 2 - 1
    const opacity = 0.13 + ((index * 17) % 9) * 0.025
    return (
      <path
        d={filamentPath(variant, lane, index * 0.73)}
        fill="none"
        key={`${variant}-${index}`}
        opacity={opacity}
        stroke={index % 5 === 0 ? '#b9dcff' : '#6dabed'}
        strokeWidth={index % 7 === 0 ? 1.4 : 0.65}
      />
    )
  })
}

function FallbackPoints({ variant }: Readonly<{ variant: FlowVariant }>) {
  return Array.from({ length: 28 }, (_, index) => {
    const lane = (((index * 13) % 29) / 28) * 1.8 - 0.9
    const t = 0.04 + (((index * 17) % 31) / 30) * 0.92
    const point = pointOnFilament(FLOW_CURVES[variant], t, lane, index * 0.73)
    return (
      <circle
        cx={point.x * 1200}
        cy={point.y * 800}
        fill={index % 6 === 0 ? '#e6f3ff' : '#87bff2'}
        key={`${variant}-point-${index}`}
        opacity={0.2 + ((index * 7) % 5) * 0.12}
        r={index % 9 === 0 ? 2.4 : 1.2}
      />
    )
  })
}

export function FlowFallbackSvg() {
  return (
    <div aria-hidden="true" className="absolute inset-0" data-flow-fallback>
      <svg
        className="hidden h-full w-full md:block"
        fill="none"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1200 800"
        width="100%"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="flow-fallback-glow" r="75%">
            <stop offset="0" stopColor="#152f4d" stopOpacity="0.34" />
            <stop offset="1" stopColor="#07101a" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect fill="url(#flow-fallback-glow)" height="800" width="1200" x="300" y="0" />
        <FallbackPaths variant="desktop" />
        <FallbackPoints variant="desktop" />
      </svg>
      <svg
        className="block h-full w-full md:hidden"
        fill="none"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1200 800"
        width="100%"
        xmlns="http://www.w3.org/2000/svg"
      >
        <FallbackPaths variant="mobile" />
        <FallbackPoints variant="mobile" />
      </svg>
    </div>
  )
}

export type SceneGpuInfo = {
  programs: number
  frameCalls: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
}

declare global {
  interface Window {
    sceneGpuInfo?: () => SceneGpuInfo
  }
}

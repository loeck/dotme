export interface AudioTestHooks {
  testAudioContexts?: AudioContext[]
  rejectOldSuspension?: () => void
  audioEnabledDuringAutoplay?: boolean
}
declare global {
  interface Window extends AudioTestHooks {}
}

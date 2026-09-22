export interface SceneControlsProps {
  paused: boolean
  onToggle: () => void
  available?: boolean
}

export function SceneControls({ paused, onToggle, available = true }: SceneControlsProps) {
  return (
    <aside
      className="absolute right-[max(1.5rem,5vw)] bottom-[max(2rem,env(safe-area-inset-bottom))] z-20 flex items-center gap-5 text-[0.7rem] text-[#8a919a] max-sm:right-[max(1.25rem,env(safe-area-inset-right))] max-sm:left-[max(1.25rem,env(safe-area-inset-left))] max-sm:justify-between max-sm:gap-3 max-sm:text-[0.65rem] max-[380px]:flex-col max-[380px]:items-end"
      aria-label="Scene controls"
    >
      <p className="m-0 inline-flex items-center gap-3 whitespace-nowrap">
        <svg aria-hidden="true" className="size-6 shrink-0" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10.5" stroke="currentColor" opacity="0.8" />
          <circle cx="12" cy="7.5" r="1" fill="currentColor" opacity="0.55" />
          <circle cx="12" cy="12" r="1.75" fill="#e4e8ed" />
          <circle cx="12" cy="16.5" r="1" fill="currentColor" opacity="0.55" />
        </svg>
        <span className="max-sm:hidden">Move to bend the field</span>
        <span className="hidden max-sm:inline">Drag to bend the field</span>
      </p>

      {available ? (
        <button
          className="inline-flex min-h-8 cursor-pointer items-center gap-2 border-0 bg-transparent px-0 py-1 text-inherit transition-[color,transform] duration-150 ease-out hover:text-[#e4e8ed] active:scale-[0.97] focus-visible:text-[#e4e8ed] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-[#b9dfff] motion-reduce:transition-none"
          type="button"
          aria-pressed={paused}
          onClick={onToggle}
        >
          <span aria-hidden="true" className="inline-block min-w-3 text-[0.65rem] text-[#e4e8ed]">
            {paused ? '▶' : 'Ⅱ'}
          </span>
          <span>{paused ? 'Resume animation' : 'Pause animation'}</span>
        </button>
      ) : null}
    </aside>
  )
}

export default SceneControls

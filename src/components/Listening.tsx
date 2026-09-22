const BAR_HEIGHTS = ['h-2', 'h-3', 'h-5', 'h-7', 'h-9', 'h-6', 'h-4', 'h-2.5'] as const

export function Listening() {
  return (
    <a
      href="https://last.fm/user/NainPuissant"
      target="_blank"
      rel="noreferrer"
      aria-label="Open Loëck’s listening history on Last.fm"
      className="group pointer-events-auto absolute bottom-[max(2rem,8vh)] left-[max(1.5rem,5vw)] z-10 flex items-end gap-4 text-[0.68rem] leading-4 text-[#737b85] no-underline transition-colors duration-200 hover:text-[#aeb6bf] focus-visible:rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-[#b9dfff] max-sm:hidden"
    >
      <div className="relative size-14 shrink-0 overflow-hidden rounded-md border border-white/10 bg-[radial-gradient(circle_at_68%_30%,rgba(184,213,234,0.38),transparent_11%),radial-gradient(circle_at_45%_74%,rgba(96,129,151,0.34),transparent_26%),linear-gradient(145deg,#131920_0%,#07090c_48%,#25313a_100%)] shadow-[0_0_24px_rgba(113,154,186,0.08)]">
        <div className="absolute inset-x-0 bottom-0 h-7 bg-[linear-gradient(155deg,transparent_47%,rgba(203,220,232,0.2)_48%,rgba(61,76,87,0.4)_73%,transparent_74%)]" />
      </div>

      <div className="min-w-32 pb-0.5">
        <span className="block tracking-[0.04em]">Listening lately</span>
        <strong className="block font-normal text-[#cbd1d8] transition-colors duration-200 group-hover:text-[#e4e8ed]">
          NainPuissant
        </strong>
        <span className="block">Last.fm</span>
      </div>

      <div className="flex h-10 items-end gap-1 pb-1 opacity-60" aria-hidden="true">
        {BAR_HEIGHTS.map((height, index) => (
          <span
            key={height}
            className={`w-px rounded-full bg-[#aeb8c2] ${height} ${index % 3 === 0 ? 'opacity-55' : 'opacity-85'}`}
          />
        ))}
      </div>
    </a>
  )
}

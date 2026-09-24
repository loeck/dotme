import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const SOCIAL_LINK_CLASS =
  'inline-flex min-h-8 items-center gap-2.5 no-underline transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:text-[var(--profile-primary)] focus-visible:text-[var(--profile-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-[var(--profile-focus)] motion-reduce:transition-none'

function GithubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <path
        fill="currentColor"
        d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.14-1.25-5.14-5.58 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.69.11 2.98a4.5 4.5 0 0 1 1.16 3.03c0 4.34-2.65 5.3-5.16 5.57.4.35.76 1.04.76 2.1v3.1c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z"
      />
    </svg>
  )
}

function LinkedinIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <path
        fill="currentColor"
        d="M4.7 3.25A1.75 1.75 0 1 1 4.7 6.75a1.75 1.75 0 0 1 0-3.5ZM3.2 8.2h3v9.65h-3V8.2Zm4.85 0h2.88v1.32h.04c.4-.76 1.38-1.56 2.84-1.56 3.04 0 3.6 2 3.6 4.6v5.3h-3v-4.7c0-1.12-.02-2.56-1.56-2.56-1.56 0-1.8 1.22-1.8 2.48v4.78h-3V8.2Z"
      />
    </svg>
  )
}

export function Profile() {
  return (
    <header
      className="profile-panel relative z-10 w-full max-w-[52rem] px-[max(1.5rem,5vw)] pt-[max(2.5rem,7.8vh)] pb-8 max-sm:max-w-[30rem] max-sm:pr-14 max-sm:pt-[max(2rem,env(safe-area-inset-top))] max-sm:pl-[max(1.25rem,env(safe-area-inset-left))]"
      aria-labelledby="profile-title"
    >
      <p className="m-0 text-[0.8rem] tracking-[0.025em] text-[var(--profile-muted)]">
        {'//loeck.me'}
      </p>
      <div className="h-10" aria-hidden="true" />
      <h1
        id="profile-title"
        className="mt-0 mb-2 text-[clamp(1.2rem,1.58vw,1.42rem)] leading-[1.35] font-normal tracking-[-0.025em] text-[var(--profile-primary)]"
      >
        Hi, I’m Loëck.
      </h1>
      <p className="m-0 text-[0.8rem] leading-5 text-[var(--profile-muted)]">
        Building some stuff in Paris, still figuring out the rest.
      </p>
      <div className="h-[3.75rem]" aria-hidden="true" />
      <nav
        className="flex items-center gap-4 text-[0.76rem] text-[var(--profile-muted)] max-sm:gap-2 max-sm:text-[0.7rem]"
        aria-label="Social links"
      >
        <a
          className={SOCIAL_LINK_CLASS}
          href="https://github.com/loeck"
          target="_blank"
          rel="noreferrer"
        >
          <GithubIcon className="size-[1.1rem] shrink-0 text-[var(--profile-icon)]" />
          <span>GitHub</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <span className="select-none text-[var(--profile-divider)]" aria-hidden="true">
          |
        </span>
        <a
          className={SOCIAL_LINK_CLASS}
          href="https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550"
          target="_blank"
          rel="noreferrer"
        >
          <LinkedinIcon className="size-[1.1rem] shrink-0 text-[var(--profile-icon)]" />
          <span>LinkedIn</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </nav>
    </header>
  )
}

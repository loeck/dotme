import { m } from 'framer-motion'

import { Highlight } from '~/components/Highlight'

export const AboutMe = ({ variant }) => (
  <m.div
    className={'flex p-6 gap-4 bg-white text-black relative z-10'}
    animate={{
      backgroundColor: variant === 'dark' ? '#000' : '#fff',
      color: variant === 'dark' ? '#fff' : '#000',
    }}
    initial={false}
  >
    <div>
      <img
        className="rounded-full"
        src="https://github.com/loeck.png?size=88"
        alt=""
        loading="lazy"
        height={88}
        width={88}
      />
    </div>
    <div className="flex flex-col gap-2">
      <div>Hi, I'm Loëck !</div>
      <div>
        I work in Paris at{' '}
        <Highlight variant={variant}>
          <a href="https://www.regate.io/" target="_blank" rel="noreferrer">
            Regate
          </a>
        </Highlight>{' '}
        as a Lead Frontend Architect
      </div>
      <div className="flex gap-2">
        <Highlight variant={variant}>
          <a href="https://github.com/loeck" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </Highlight>
        <Highlight variant={variant}>
          <a
            href="https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550"
            target="_blank"
            rel="noreferrer"
          >
            LinkedIn
          </a>
        </Highlight>
        <Highlight variant={variant}>
          <a
            href="https://www.join-jump.com/"
            target="_blank"
            rel="noreferrer"
            href="https://last.fm/user/NainPuissant"
          >
            Last.fm
          </a>
        </Highlight>
      </div>
    </div>
  </m.div>
)

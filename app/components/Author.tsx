import { m } from 'framer-motion'

import { Highlight } from '~/components/Highlight'

export const Author = ({ variant }) => (
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
        width={88}
      />
    </div>
    <div className="flex flex-col gap-2">
      <div>Hi, I'm Loëck !</div>
      <div>
        I work in Paris at <Highlight variant={variant}>Jump</Highlight> as a
        Lead Frontend Developer
      </div>
      <div className="flex gap-2">
        <Highlight variant={variant}>Github</Highlight>
        <Highlight variant={variant}>Linkedin</Highlight>
        <Highlight variant={variant}>Last.fm</Highlight>
      </div>
    </div>
  </m.div>
)

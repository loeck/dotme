import { m } from 'framer-motion'

export const Highlight = ({ children, variant }) => (
  <m.div
    className={'whitespace-nowrap inline-flex px-1 bg-black text-white'}
    animate={{
      backgroundColor: variant === 'dark' ? '#fff' : '#000',
      color: variant === 'dark' ? '#000' : '#fff',
    }}
  >
    {children}
  </m.div>
)

import { m, AnimatePresence } from 'framer-motion'
import { PlayIcon, StopIcon } from '@radix-ui/react-icons'

export const ControlTrack = ({ variant, state, onClick }) => (
  <AnimatePresence>
    {variant && (
      <m.div
        className="px-3"
        initial={{
          y: '-100%',
        }}
        animate={{
          color: variant === 'light' ? '#000' : '#fff',
          y: 0,
        }}
      >
        <div
          className={`inline-flex rounded-full p-2 cursor-pointer ${
            variant === 'light' ? 'bg-white' : 'bg-black'
          }`}
          onClick={onClick}
        >
          {state === 'stop' ? (
            <PlayIcon height={20} width={20} />
          ) : (
            <StopIcon height={20} width={20} />
          )}
        </div>
      </m.div>
    )}
  </AnimatePresence>
)

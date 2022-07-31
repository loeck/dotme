import { m, AnimatePresence } from 'framer-motion'
import { PlayIcon, StopIcon, TrackNextIcon } from '@radix-ui/react-icons'

export const ControlTrack = ({
  variant,
  state,
  onChangeState,
  onNextTrack,
}) => (
  <AnimatePresence>
    {variant && (
      <m.div
        className="select-none px-3 flex gap-3"
        initial={{
          y: '-100%',
        }}
        animate={{
          color: variant === 'light' ? '#000' : '#fff',
          y: 0,
        }}
      >
        <div
          className={`relative z-10 inline-flex rounded-full p-2 cursor-pointer ${
            variant === 'light' ? 'bg-white' : 'bg-black'
          }`}
          onClick={onChangeState}
        >
          {state === 'stop' ? (
            <PlayIcon height={20} width={20} />
          ) : (
            <StopIcon height={20} width={20} />
          )}
        </div>

        {state === 'play' && (
          <m.div
            className={`inline-flex rounded-full p-2 cursor-pointer ${
              variant === 'light' ? 'bg-white' : 'bg-black'
            }`}
            onClick={onNextTrack}
            initial={{
              x: '-100%',
            }}
            animate={{
              x: 0,
            }}
            exit={{
              x: '-100%',
            }}
          >
            <TrackNextIcon height={20} width={20} />
          </m.div>
        )}
      </m.div>
    )}
  </AnimatePresence>
)

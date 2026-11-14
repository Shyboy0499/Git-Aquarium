import { P, createState, step, type State } from './sim'

let state: State | undefined
let running = true

onmessage = (e: MessageEvent<{ seed?: number; running?: boolean }>) => {
  if (e.data.seed !== undefined) state = createState(e.data.seed)
  if (e.data.running !== undefined) running = e.data.running
  if (state) postMessage(state)
}

// Fixed timestep: the timer only decides when a tick runs, never what it does.
setInterval(() => {
  if (!running || !state) return
  step(state)
  // ponytail: structured-clones the whole state every tick; send typed arrays if profiling says so
  postMessage(state)
}, 1000 / P.ticksPerSecond)

import { P, createState, step, type GitEvent, type State } from './sim'

export interface Command {
  load?: { seed: number; lineages: number; events: GitEvent[] } // also how reset works: same inputs, fresh state
  running?: boolean
  speed?: number
}

let state: State | undefined
let events: GitEvent[] = []
let running = true
let speed = 1

onmessage = (e: MessageEvent<Command>) => {
  const c = e.data
  if (c.load) {
    events = c.load.events
    state = createState(c.load.seed, c.load.lineages)
  }
  if (c.running !== undefined) running = c.running
  if (c.speed !== undefined) speed = c.speed
  if (state) postMessage(state)
}

// Fixed timestep: the timer and the speed setting decide when ticks run, never what a tick does.
setInterval(() => {
  if (!running || !state) return
  for (let i = 0; i < speed; i++) step(state, events)
  // ponytail: structured-clones the whole state every tick; send typed arrays if profiling says so
  postMessage(state)
}, 1000 / P.ticksPerSecond)

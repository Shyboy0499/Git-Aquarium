// Where the pull request fish swim. Positions are in the simulation's units, so the ecosystem's renderer can draw them.
// There is no replay here: fish wander, keep loosely to their author's school, and stay apart.
import { P } from './sim'
import { STALE_DAYS, type OpenPull } from './pulls'

export interface Swim {
  pull: OpenPull
  x: number
  y: number
  z: number
  yaw: number // heading in the horizontal plane
  speed: number // units per second: a quiet pull request barely moves
  phase: number
}

const MARGIN = 60
const frac = (v: number) => v - Math.floor(v)

// The same pull requests always start in the same places.
export function placePulls(pulls: OpenPull[]): Swim[] {
  return pulls.map((pull, i) => ({
    pull,
    x: MARGIN + frac(pull.number * 0.618) * (P.width - 2 * MARGIN),
    y: 90 + frac(pull.number * 0.371) * (P.height - 170),
    z: 30 + frac(pull.number * 0.829) * (P.depth - 60),
    yaw: i % 2 ? 0.2 : Math.PI - 0.2,
    speed: 10 + 30 * Math.max(0, 1 - pull.quietDays / STALE_DAYS),
    phase: pull.number * 1.7,
  }))
}

export function swim(fish: Swim[], dt: number, time: number) {
  // Each author's school has a centre its fish lean toward.
  const centres = new Map<number, { x: number; y: number; n: number }>()
  for (const f of fish) {
    const c = centres.get(f.pull.group) ?? { x: 0, y: 0, n: 0 }
    c.x += f.x; c.y += f.y; c.n++
    centres.set(f.pull.group, c)
  }
  for (const f of fish) {
    const c = centres.get(f.pull.group)!
    const toward = Math.cos(f.yaw) * (c.x / c.n - f.x) > 0 ? 0 : 1 // heading away from its school: turn harder
    // wander, turn back toward the school, and ease back to side-on so the body can be read
    f.yaw += (0.5 * Math.sin(time * 0.7 + f.phase) + 0.25 * toward * Math.sin(f.yaw + 0.3) - 0.5 * Math.sin(2 * f.yaw)) * dt
    f.x += Math.cos(f.yaw) * f.speed * dt
    f.z += Math.sin(f.yaw) * f.speed * 0.5 * dt
    f.y += (Math.sin(time * 0.5 + f.phase * 1.3) * 4 + (c.y / c.n - f.y) * 0.03) * dt
    if (f.x < MARGIN) { f.x = MARGIN; f.yaw = Math.PI - f.yaw }
    if (f.x > P.width - MARGIN) { f.x = P.width - MARGIN; f.yaw = Math.PI - f.yaw }
    if (f.z < 20) { f.z = 20; f.yaw = -f.yaw }
    if (f.z > P.depth - 20) { f.z = P.depth - 20; f.yaw = -f.yaw }
    f.y = Math.min(P.height - 50, Math.max(70, f.y))
  }
  // ponytail: O(n^2) separation, 5,000 pairs at the 100 drawn; a grid if more are ever drawn
  for (let i = 0; i < fish.length; i++) {
    for (let j = i + 1; j < fish.length; j++) {
      const a = fish[i], b = fish[j]
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
      const d = Math.hypot(dx, dy, dz)
      if (d > 0 && d < 34) {
        const push = ((34 - d) / d) * 0.5 * Math.min(1, 4 * dt)
        a.x -= dx * push; a.y -= dy * push; a.z -= dz * push
        b.x += dx * push; b.y += dy * push; b.z += dz * push
      }
    }
  }
}

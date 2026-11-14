import { P, maxEnergy, type State } from './sim'

const canvas = document.querySelector('canvas')!
const ctx = canvas.getContext('2d')!
const hud = document.querySelector('#hud')!
const seed = document.querySelector<HTMLInputElement>('#seed')!
const pause = document.querySelector<HTMLButtonElement>('#pause')!
canvas.width = P.width
canvas.height = P.height

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
worker.onmessage = (e: MessageEvent<State>) => draw(e.data)

const reset = () => worker.postMessage({ seed: Number(seed.value) })
document.querySelector('form')!.addEventListener('submit', (e) => {
  e.preventDefault()
  reset()
})
let running = true
pause.addEventListener('click', () => {
  running = !running
  pause.textContent = running ? 'Pause' : 'Play'
  worker.postMessage({ running })
})
reset()

// Rendering only reads state; it never changes the simulation.
function draw(s: State) {
  ctx.fillStyle = '#06283d'
  ctx.fillRect(0, 0, P.width, P.height)
  ctx.fillStyle = '#9be37a'
  for (const f of s.food) ctx.fillRect(f.x - 1.5, f.y - 1.5, 3, 3)

  let energy = 0
  for (const o of s.organisms) {
    energy += o.energy
    const g = o.genome
    const len = 6 + 10 * g.bodyLength
    const fin = len * (0.4 + 0.6 * g.finSize)
    const hue = 20 + (o.lineage * 360) / P.lineages + (g.hue - 0.5) * 50 // lineage palette + own variation
    ctx.save()
    ctx.translate(o.x, o.y)
    ctx.rotate(o.heading)
    ctx.fillStyle = `hsl(${hue} 80% ${35 + (30 * o.energy) / maxEnergy(g)}%)` // dimmer = hungrier
    ctx.beginPath()
    ctx.ellipse(0, 0, len, len * 0.45, 0, 0, 2 * Math.PI)
    ctx.moveTo(-len * 0.8, 0)
    ctx.lineTo(-len - fin, -fin * 0.6)
    ctx.lineTo(-len - fin, fin * 0.6)
    ctx.fill()
    ctx.restore()
  }

  const n = s.organisms.length
  hud.textContent =
    `Simulated measurements: tick ${s.tick} · population ${n} · ` +
    `mean energy ${n ? (energy / n).toFixed(1) : '0'} · births ${s.births} · ` +
    `deaths ${s.deaths} · mutations ${s.mutations}`
}

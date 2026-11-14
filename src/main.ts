import { importRepo, type Dataset } from './dataset'
import { demo } from './demo'
import { P, RULES, maxEnergy, type State } from './sim'
import type { Command } from './worker'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
// Repository text is untrusted, so it only ever reaches the page as text content.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
  const node = document.createElement(tag)
  node.textContent = text
  return node
}

const canvas = $<HTMLCanvasElement>('canvas')
const ctx = canvas.getContext('2d')!
canvas.width = P.width
canvas.height = P.height
const water = ctx.createLinearGradient(0, 0, 0, P.height)
water.addColorStop(0, '#0b4467')
water.addColorStop(1, '#041c2b')
const LINK_TICKS = 160 // how long a pull request stays drawn

let data: Dataset = demo
let shown = -1 // event cursor the log currently reflects

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const send = (c: Command) => worker.postMessage(c)
worker.onmessage = (e: MessageEvent<State>) => draw(e.data)

// Loading and resetting are the same thing: a fresh state from the same seed and frozen dataset.
const load = () =>
  send({ load: { seed: Number($<HTMLInputElement>('#seed').value), lineages: data.branches.length, events: data.events } })
const hue = (lineage: number) => 20 + (lineage * 360) / data.branches.length

function use(d: Dataset) {
  data = d
  const count = (...kinds: string[]) => d.events.filter((e) => kinds.includes(e.kind)).length
  const days = d.events.length ? `${d.events[0].at.slice(0, 10)} to ${d.events[d.events.length - 1].at.slice(0, 10)}` : 'no events'
  $('#status').textContent =
    (d.source === 'synthetic'
      ? `Synthetic demo data (${d.repo}): fictional events, not imported from GitHub. `
      : `Recorded data from github.com/${d.repo}, frozen at import. `) +
    `${days} · commits ${count('COMMIT_OBSERVED')} · pull requests opened ${count('PR_OPENED')} · ` +
    `merged ${count('PR_MERGED')} · CI results ${count('CI_FAILED', 'CI_PASSED')}`
  $('#notices').replaceChildren(...d.notices.map((n) => el('li', n)))
  $('#legend').replaceChildren(...d.branches.map((name, i) => {
    const li = el('li')
    const dot = el('i')
    dot.style.background = `hsl(${hue(i)} 80% 55%)`
    li.append(dot, name + ' ', el('b'))
    return li
  }))
  $<HTMLProgressElement>('#timeline').max = d.events[d.events.length - 1]?.tick ?? 1
  load()
}

$('#source').addEventListener('submit', async (e) => {
  e.preventDefault()
  const button = $<HTMLButtonElement>('#import')
  button.disabled = true
  $('#error').textContent = 'Importing...'
  try {
    use(await importRepo($<HTMLInputElement>('#repo').value))
    $('#error').textContent = ''
  } catch (err) {
    $('#error').textContent = `Import failed: ${(err as Error).message} The previous dataset is still loaded.`
  } finally {
    button.disabled = false
  }
})
$('#demo').addEventListener('click', () => use(demo))
$('#controls').addEventListener('submit', (e) => {
  e.preventDefault()
  load()
})
let running = true
$('#pause').addEventListener('click', (e) => {
  running = !running
  ;(e.target as HTMLElement).textContent = running ? 'Pause' : 'Play'
  send({ running })
})
$<HTMLSelectElement>('#speed').addEventListener('change', (e) => send({ speed: Number((e.target as HTMLSelectElement).value) }))
use(demo)

// Rendering only reads state; it never changes the simulation.
function draw(s: State) {
  ctx.fillStyle = water
  ctx.fillRect(0, 0, P.width, P.height)
  const stress = s.penalty / P.maxPenalty
  ctx.fillStyle = `rgba(150, 95, 30, ${0.5 * stress})` // murky water while CI groups are failing
  ctx.fillRect(0, 0, P.width, P.height)
  ctx.fillStyle = '#9be37a'
  for (const f of s.food) ctx.fillRect(f.x - 1.5, f.y - 1.5, 3, 3)

  let energy = 0
  const groups = data.branches.map(() => ({ x: 0, y: 0, n: 0 }))
  for (const o of s.organisms) {
    energy += o.energy
    const group = groups[o.lineage]
    group.x += o.x
    group.y += o.y
    group.n++
    const g = o.genome
    const len = 6 + 10 * g.bodyLength
    const fin = len * (0.4 + 0.6 * g.finSize)
    ctx.save()
    ctx.translate(o.x, o.y)
    ctx.rotate(o.heading)
    // Lineage palette plus the organism's own variation; dimmer = hungrier.
    ctx.fillStyle = `hsl(${hue(o.lineage) + (g.hue - 0.5) * 50} 80% ${35 + (30 * o.energy) / maxEnergy(g)}%)`
    ctx.beginPath()
    ctx.ellipse(0, 0, len, len * 0.45, 0, 0, 2 * Math.PI)
    ctx.moveTo(-len * 0.8, 0)
    ctx.lineTo(-len - fin, -fin * 0.6)
    ctx.lineTo(-len - fin, fin * 0.6)
    ctx.fill()
    ctx.fillStyle = '#021521'
    ctx.fillRect(len * 0.5, -len * 0.18, 2, 2)
    ctx.restore()
  }

  // Recent pull requests: a line between the two lineages' centres, or a ring if only one branch is in the snapshot.
  ctx.font = '12px system-ui, sans-serif'
  for (let i = s.cursor - 1; i >= 0 && s.tick - data.events[i].tick < LINK_TICKS; i--) {
    const e = data.events[i]
    if (e.kind !== 'PR_OPENED' && e.kind !== 'PR_MERGED') continue
    const [head, base] = e.branches.map((b) => groups[data.branches.indexOf(b)]).map((c) => (c?.n ? c : undefined))
    const anchor = base ?? head
    if (!anchor) continue
    const age = (s.tick - e.tick) / LINK_TICKS
    const merged = e.kind === 'PR_MERGED'
    ctx.strokeStyle = ctx.fillStyle = `rgba(255, 255, 255, ${1 - age})`
    ctx.lineWidth = merged ? 3 : 1.5
    ctx.setLineDash(merged ? [] : [6, 6])
    ctx.beginPath()
    if (head && base) {
      ctx.moveTo(head.x / head.n, head.y / head.n)
      ctx.lineTo(base.x / base.n, base.y / base.n)
    } else {
      ctx.arc(anchor.x / anchor.n, anchor.y / anchor.n, 20 + 40 * age, 0, 2 * Math.PI)
    }
    ctx.stroke()
    ctx.fillText(`PR #${e.id} ${merged ? 'merged' : 'opened'}`, anchor.x / anchor.n + 10, anchor.y / anchor.n + 18)
  }
  ctx.setLineDash([])

  const n = s.organisms.length
  $('#hud').textContent =
    `Simulated measurements: tick ${s.tick} · population ${n} · ` +
    `mean energy ${n ? (energy / n).toFixed(1) : '0'} · births ${s.births} · deaths ${s.deaths} · ` +
    `mutations ${s.mutations} · water stress ${Math.round(100 * stress)}%`
  const legend = $('#legend').children
  groups.forEach((group, i) => (legend[i].lastElementChild!.textContent = String(group.n)))
  $<HTMLProgressElement>('#timeline').value = s.tick

  if (s.cursor === shown) return
  shown = s.cursor
  const last = data.events[s.cursor - 1]
  $('#date').textContent =
    s.cursor === data.events.length ? 'All repository events replayed; only the baseline food supply continues.'
    : last ? `Replaying ${last.at.slice(0, 10)} · event ${s.cursor} of ${data.events.length}`
    : `Waiting for the first of ${data.events.length} repository events`
  $('#log').replaceChildren(...data.events.slice(Math.max(0, s.cursor - 8), s.cursor).reverse().map((e) => {
    const li = el('li')
    li.append(el('strong', `${e.at.slice(0, 10)} · ${e.kind}`), el('span', e.title), el('small', `${RULES[e.kind].id}: ${RULES[e.kind].effect}`))
    if (e.url) {
      const a = el('a', 'GitHub source')
      a.href = e.url
      a.target = '_blank'
      a.rel = 'noopener'
      li.append(a)
    } else {
      li.append(el('small', 'Synthetic event: no GitHub source'))
    }
    return li
  }))
}

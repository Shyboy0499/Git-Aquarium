import '@fontsource-variable/fraunces'
import '@fontsource-variable/fraunces/wght-italic.css'
import '@fontsource-variable/martian-mono'
import './style.css'
import { importRepo, type Dataset } from './dataset'
import { demo } from './demo'
import { P, RULES, maxEnergy, type EventKind, type Organism, type State } from './sim'
import { COLORS, createTank, type Swimmer } from './tank'
import type { Command } from './worker'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
// Repository text is untrusted, so it only ever reaches the page as text content.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}

const W = P.width
const H = P.height
const TAU = 2 * Math.PI
const TICK_MS = 1000 / P.ticksPerSecond
const LINK_TICKS = 200 // how long a pull request stays drawn
const KIND: Record<EventKind, string> = {
  COMMIT_OBSERVED: 'Commit observed', PR_OPENED: 'PR opened', PR_MERGED: 'PR merged',
  CI_FAILED: 'CI failed', CI_PASSED: 'CI passed',
}

// ---- Canvases ----------------------------------------------------------------------------------

const overlay = $<HTMLCanvasElement>('#overlay') // pull request arcs and labels, drawn over the 3D view
const tank = (() => {
  try {
    return createTank($<HTMLCanvasElement>('#scene'))
  } catch { // no WebGL: the readouts and event log still work
    $('.view').replaceChildren(el('p', 'The aquarium view needs WebGL, which this browser did not provide. The measurements and event log below still work.'))
  }
})()
const dpr = Math.min(2, window.devicePixelRatio || 1)
overlay.width = W * dpr
overlay.height = H * dpr
const ctx = overlay.getContext('2d')!
ctx.scale(dpr, dpr)

// ---- Replay state -------------------------------------------------------------------------------

let data: Dataset = demo
let cur: State | undefined // latest snapshot from the worker
let from = new Map<number, Organism>() // the snapshot before it, for smooth motion between ticks
let arrived = 0
let running = true
let shown = -1 // event cursor the log currently reflects
const born = new Map<number, number>() // when each newborn first appeared, so it can grow in
let fading: { o: Organism; at: number }[] = [] // the recently dead, shrinking and sinking

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const send = (c: Command) => worker.postMessage(c)
worker.onmessage = (e: MessageEvent<State>) => {
  const next = e.data
  const now = performance.now()
  if (!cur || next.tick < cur.tick) { // a fresh replay: nothing to blend from
    from = new Map()
    born.clear()
    fading = []
  } else if (next.tick > cur.tick) {
    from = new Map(cur.organisms.map((o) => [o.id, o]))
    const alive = new Set(next.organisms.map((o) => o.id))
    for (const o of next.organisms) if (!from.has(o.id)) born.set(o.id, now)
    for (const o of cur.organisms) {
      if (alive.has(o.id)) continue
      born.delete(o.id)
      fading.push({ o, at: now })
    }
  }
  cur = next
  arrived = now
  report(next)
}

// Loading and resetting are the same thing: a fresh state from the same seed and frozen dataset.
const load = () =>
  send({ load: { seed: Number($<HTMLInputElement>('#seed').value), lineages: data.branches.length, events: data.events } })

function use(d: Dataset) {
  data = d
  const count = (...kinds: string[]) => String(d.events.filter((e) => kinds.includes(e.kind)).length)
  const stat = (label: string, value: string) => {
    const div = el('div')
    div.append(el('dt', label), el('dd', value))
    return div
  }
  const counts = el('dl')
  counts.append(
    stat('Commits', count('COMMIT_OBSERVED')), stat('PRs', count('PR_OPENED')),
    stat('Merged', count('PR_MERGED')), stat('CI runs', count('CI_FAILED', 'CI_PASSED')),
  )
  $('#dataset').replaceChildren(
    el('span', d.source, `badge ${d.source}`),
    el('strong', d.repo),
    el('p', (d.source === 'synthetic' ? 'Fictional events, not imported from GitHub. ' : 'Imported from GitHub and frozen. ') +
      (d.events.length ? `${d.events[0].at.slice(0, 10)} to ${d.events[d.events.length - 1].at.slice(0, 10)}.` : 'No events.')),
    counts,
  )
  const notices = $<HTMLDetailsElement>('#notices')
  notices.open = d.source === 'recorded' // real imports show their gaps without being asked
  notices.firstElementChild!.textContent = `Data boundaries (${d.notices.length})`
  notices.lastElementChild!.replaceChildren(...d.notices.map((n) => el('li', n)))

  $('#legend').replaceChildren(...d.branches.map((name, i) => {
    const li = el('li')
    li.style.setProperty('--c', COLORS[i % COLORS.length])
    li.append(el('i'), el('span', name), el('b'), el('u'))
    return li
  }))
  const end = d.events[d.events.length - 1]?.tick ?? 1
  $('#marks').replaceChildren(...d.events.map((e) => {
    const mark = el('i', '', e.kind)
    mark.style.left = `${(100 * e.tick) / end}%`
    return mark
  }))
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
$('#pause').addEventListener('click', (e) => {
  running = !running
  ;(e.target as HTMLElement).textContent = running ? 'Pause' : 'Play'
  send({ running })
})
$('#speed').addEventListener('change', (e) => send({ speed: Number((e.target as HTMLInputElement).value) }))

// ---- Readouts (once per snapshot) ---------------------------------------------------------------

function report(s: State) {
  const n = s.organisms.length
  const counts = data.branches.map(() => 0)
  let energy = 0
  for (const o of s.organisms) {
    energy += o.energy
    counts[o.lineage]++
  }
  const stress = Math.round((100 * s.penalty) / P.maxPenalty)
  $('#s-pop').textContent = String(n)
  $('#s-energy').textContent = n ? (energy / n).toFixed(1) : '0'
  $('#s-births').textContent = String(s.births)
  $('#s-deaths').textContent = String(s.deaths)
  $('#s-mutations').textContent = String(s.mutations)
  $('#s-stress').textContent = `${stress}%`
  const legend = $('#legend').children
  counts.forEach((c, i) => {
    if (!legend[i]) return
    legend[i].children[2].textContent = String(c)
    ;(legend[i].children[3] as HTMLElement).style.width = `${n ? (100 * c) / n : 0}%`
  })
  const end = data.events[data.events.length - 1]?.tick ?? 1
  const progress = Math.min(100, (100 * s.tick) / end)
  $('#fill').style.width = `${progress}%`
  $('#timeline').setAttribute('aria-valuenow', String(Math.round(progress)))
  const alarm = $('#alarm')
  alarm.hidden = stress === 0
  alarm.textContent = s.failing.length
    ? `Murky water · ${s.failing.length} CI ${s.failing.length === 1 ? 'group' : 'groups'} failing`
    : `Water clearing · stress ${stress}%`

  if (s.cursor === shown) return
  const fresh = s.cursor > shown && shown >= 0 ? s.cursor - shown : 0 // how many entries just arrived
  shown = s.cursor
  const last = data.events[s.cursor - 1]
  $('#date').textContent =
    !data.events.length ? 'No repository events · baseline supply only'
    : s.cursor === data.events.length ? 'Replay complete · baseline supply continues'
    : last ? `Replaying ${last.at.slice(0, 10)} · event ${s.cursor} of ${data.events.length}`
    : `Awaiting the first of ${data.events.length} events`
  $('#log').replaceChildren(...data.events.slice(Math.max(0, s.cursor - 7), s.cursor).reverse().map((e, i) => {
    const li = el('li', '', e.kind + (i < fresh ? ' new' : ''))
    const rule = el('small')
    rule.append(el('b', RULES[e.kind].id), ` ${RULES[e.kind].effect}`)
    li.append(el('span', e.at.slice(0, 10), 'when'), el('span', KIND[e.kind], 'kind'), el('p', e.title), rule)
    if (e.url) {
      const a = el('a', 'GitHub source')
      a.href = e.url
      a.target = '_blank'
      a.rel = 'noopener'
      li.append(a)
    } else {
      li.append(el('small', 'Synthetic event · no GitHub source'))
    }
    return li
  }))
}

// ---- The tank (every animation frame) -----------------------------------------------------------

let anim = 0 // seconds of animation; stands still while paused
let lastFrame = 0
let murk = 0 // displayed water stress, eased toward the simulated value

function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  if (!cur || !tank) return
  const s = cur
  if (running) anim += dt
  const blend = Math.min(1, (now - arrived) / TICK_MS)
  murk += (s.penalty / P.maxPenalty - murk) * 0.03

  // Blend each fish between the last two snapshots so it glides rather than steps.
  const swimmers: Swimmer[] = s.organisms.map((o) => {
    const p = from.get(o.id) ?? o
    const ux = p.ux + (o.ux - p.ux) * blend
    const uy = p.uy + (o.uy - p.uy) * blend
    const uz = p.uz + (o.uz - p.uz) * blend
    const len = Math.hypot(ux, uy, uz) || 1
    const age = born.has(o.id) ? (now - born.get(o.id)!) / 700 : 1
    return {
      id: o.id, lineage: o.lineage, genome: o.genome,
      x: p.x + (o.x - p.x) * blend, y: p.y + (o.y - p.y) * blend, z: p.z + (o.z - p.z) * blend,
      ux: ux / len, uy: uy / len, uz: uz / len,
      energy: o.energy / maxEnergy(o.genome),
      grown: Math.min(1, age),
    }
  })
  const living = swimmers.length
  fading = fading.filter((f) => now - f.at < 900)
  for (const { o, at } of fading) { // the dead lose their colour, shrink, and sink
    const k = (now - at) / 900
    swimmers.push({ ...o, y: o.y - 45 * k, energy: 0, grown: 1 - k })
  }
  tank.draw(swimmers, s.food, murk, anim)

  // Recent pull requests: an arc between the eldest fish of the two lineages, or a ring if only one branch is in the snapshot.
  ctx.clearRect(0, 0, W, H)
  ctx.font = '500 10px "Martian Mono Variable", ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = s.cursor - 1; i >= 0 && s.tick - data.events[i].tick < LINK_TICKS; i--) {
    const e = data.events[i]
    if (e.kind !== 'PR_OPENED' && e.kind !== 'PR_MERGED') continue
    const [head, base] = e.branches.map((b) => {
      const lineage = data.branches.indexOf(b)
      for (let j = 0; lineage >= 0 && j < living; j++) {
        if (swimmers[j].lineage === lineage) return tank.project(swimmers[j].x, swimmers[j].y, swimmers[j].z)
      }
    })
    const anchor = base ?? head
    if (!anchor) continue
    const age = (s.tick - e.tick) / LINK_TICKS
    const merged = e.kind === 'PR_MERGED'
    let [lx, ly] = anchor
    ly -= 34
    ctx.save()
    ctx.globalAlpha = Math.min(1, 3 * (1 - age))
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = merged ? 2 : 1.25
    ctx.setLineDash(merged ? [] : [4, 6])
    ctx.beginPath()
    if (head && base) {
      const mx = (head[0] + base[0]) / 2
      const my = (head[1] + base[1]) / 2 - Math.max(40, 0.3 * Math.hypot(head[0] - base[0], head[1] - base[1]))
      ctx.moveTo(head[0], head[1])
      ctx.quadraticCurveTo(mx, my, base[0], base[1])
      lx = 0.25 * head[0] + 0.5 * mx + 0.25 * base[0] // the top of the arc
      ly = 0.25 * head[1] + 0.5 * my + 0.25 * base[1] - 16
    } else {
      ctx.arc(anchor[0], anchor[1], 18 + 46 * age, 0, TAU)
    }
    ctx.stroke()
    ctx.setLineDash([])
    const label = `PR #${e.id} ${merged ? 'MERGED' : 'OPENED'}`
    const width = ctx.measureText(label).width + 16
    ctx.fillStyle = 'rgba(6, 22, 34, 0.8)'
    ctx.beginPath()
    ctx.roundRect(lx - width / 2, ly - 9, width, 18, 9)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(label, lx, ly + 0.5)
    ctx.restore()
  }
}

use(demo)
requestAnimationFrame(frame)

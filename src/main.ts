import '@fontsource-variable/fraunces'
import '@fontsource-variable/fraunces/wght-italic.css'
import '@fontsource-variable/martian-mono'
import './style.css'
import { importRepo, type Dataset } from './dataset'
import { demo } from './demo'
import { P, RULES, maxEnergy, type EventKind, type Organism, type State } from './sim'
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
const HUES = [186, 322, 42, 150, 268, 14, 96, 218] // one glow colour per lineage
const hue = (lineage: number) => HUES[lineage % HUES.length]
const KIND: Record<EventKind, string> = {
  COMMIT_OBSERVED: 'Commit observed', PR_OPENED: 'PR opened', PR_MERGED: 'PR merged',
  CI_FAILED: 'CI failed', CI_PASSED: 'CI passed',
}

// ---- Canvas layers ------------------------------------------------------------------------------

const dpr = Math.min(2, window.devicePixelRatio || 1)
function layer(target = document.createElement('canvas')) {
  target.width = W * dpr
  target.height = H * dpr
  const c = target.getContext('2d')!
  c.scale(dpr, dpr)
  return c
}
const ctx = layer($<HTMLCanvasElement>('canvas'))
const backdrop = layer() // painted once

function sprite(color: (alpha: number) => string) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  glow.addColorStop(0, color(0.9))
  glow.addColorStop(0.35, color(0.25))
  glow.addColorStop(1, color(0))
  g.fillStyle = glow
  g.fillRect(0, 0, 64, 64)
  return c
}
const glows = HUES.map((h) => sprite((a) => `hsla(${h}, 95%, 62%, ${a})`))
const plankton = sprite((a) => `rgba(150, 255, 200, ${a})`)
const bloom = sprite((a) => `rgba(255, 40, 70, ${a})`)

{
  const c = backdrop
  const water = c.createLinearGradient(0, 0, 0, H)
  water.addColorStop(0, '#07304a')
  water.addColorStop(0.45, '#041a2c')
  water.addColorStop(1, '#010810')
  c.fillStyle = water
  c.fillRect(0, 0, W, H)
  for (const [x, width, alpha] of [[120, 90, 0.07], [330, 140, 0.05], [560, 70, 0.06], [700, 110, 0.04]]) { // light shafts
    const shaft = c.createLinearGradient(0, 0, 0, H * 0.8)
    shaft.addColorStop(0, `rgba(140, 240, 255, ${alpha})`)
    shaft.addColorStop(1, 'rgba(140, 240, 255, 0)')
    c.fillStyle = shaft
    c.beginPath()
    c.moveTo(x, 0)
    c.lineTo(x + width, 0)
    c.lineTo(x + width - 140, H * 0.8)
    c.lineTo(x - 200, H * 0.8)
    c.fill()
  }
  for (const [base, height, color] of [[H - 30, 14, '#052033'], [H - 14, 9, '#03141f']] as const) { // seabed
    c.fillStyle = color
    c.beginPath()
    c.moveTo(0, H)
    for (let x = 0; x <= W; x += 20) c.lineTo(x, base + Math.sin(x * 0.013 + base) * height + Math.sin(x * 0.041) * height * 0.4)
    c.lineTo(W, H)
    c.fill()
  }
  const vignette = c.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H / 2, W * 0.72)
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 4, 10, 0.75)')
  c.fillStyle = vignette
  c.fillRect(0, 0, W, H)
}

// ---- Replay state -------------------------------------------------------------------------------

let data: Dataset = demo
let cur: State | undefined // latest snapshot from the worker
let from = new Map<number, Organism>() // the snapshot before it, for smooth motion between ticks
let arrived = 0
let running = true
let shown = -1 // event cursor the log currently reflects
interface Effect { x: number; y: number; at: number; lineage: number; birth: boolean }
let effects: Effect[] = []

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const send = (c: Command) => worker.postMessage(c)
worker.onmessage = (e: MessageEvent<State>) => {
  const next = e.data
  const now = performance.now()
  if (!cur || next.tick < cur.tick) { // a fresh replay: nothing to blend from
    from = new Map()
    effects = []
  } else if (next.tick > cur.tick) {
    from = new Map(cur.organisms.map((o) => [o.id, o]))
    const alive = new Set(next.organisms.map((o) => o.id))
    for (const o of next.organisms) if (!from.has(o.id)) effects.push({ x: o.x, y: o.y, at: now, lineage: o.lineage, birth: true })
    for (const o of cur.organisms) if (!alive.has(o.id)) effects.push({ x: o.x, y: o.y, at: now, lineage: o.lineage, birth: false })
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
    li.style.setProperty('--c', `hsl(${hue(i)} 90% 62%)`)
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
    ? `Red tide · ${s.failing.length} CI ${s.failing.length === 1 ? 'group' : 'groups'} failing`
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
// Rendering only reads state; it never changes the simulation.

let anim = 0 // seconds of animation; stands still while paused
let lastFrame = 0
let tide = 0 // displayed water stress, eased toward the simulated value
const WAKE = 32 // numbers kept per fish: its last 16 tail positions, newest first
let wakes = new Map<number, number[]>()

function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  if (!cur) return
  const s = cur
  if (running) anim += dt
  const blend = Math.min(1, (now - arrived) / TICK_MS)
  tide += (s.penalty / P.maxPenalty - tide) * 0.04

  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.drawImage(backdrop.canvas, 0, 0, W, H)

  if (tide > 0.005) { // red tide while CI groups are failing
    ctx.fillStyle = `rgba(110, 6, 24, ${0.4 * tide})`
    ctx.fillRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.32 * tide
    for (let i = 0; i < 5; i++) {
      const r = 170 + 50 * Math.sin(anim * 0.2 + i)
      const x = W * (0.5 + 0.45 * Math.sin(anim * 0.11 + i * 1.9))
      const y = H * (0.45 + 0.4 * Math.cos(anim * 0.09 + i * 2.7))
      ctx.drawImage(bloom, x - r, y - r, 2 * r, 2 * r)
    }
  }

  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#9fd0d8'
  for (let i = 0; i < 70; i++) { // marine snow, drifting at different depths
    const depth = 0.3 + ((i * 37) % 10) / 14
    ctx.globalAlpha = 0.05 + 0.14 * depth
    ctx.fillRect((i * 97.3 + anim * 6 * depth) % W, (i * 53.7 + anim * 10 * depth) % H, 1 + depth, 1 + depth)
  }

  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = '#eafff9'
  for (const f of s.food) { // food: twinkling plankton
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(anim * 3 + f.x * 0.37 + f.y * 0.71)
    ctx.drawImage(plankton, f.x - 7, f.y - 7, 14, 14)
    ctx.fillRect(f.x - 0.8, f.y - 0.8, 1.6, 1.6)
  }

  // Blend each fish between the last two snapshots, then lay down wakes, glows, and bodies.
  ctx.lineCap = 'round'
  const nextWakes = new Map<number, number[]>()
  const fish = s.organisms.map((o) => {
    const p = from.get(o.id)
    let x = o.x, y = o.y, heading = o.heading
    if (p) {
      let turn = o.heading - p.heading
      turn -= TAU * Math.round(turn / TAU)
      x = p.x + (o.x - p.x) * blend
      y = p.y + (o.y - p.y) * blend
      heading = p.heading + turn * blend
    }
    const len = 5 + 9 * o.genome.bodyLength
    const colour = hue(o.lineage) + (o.genome.hue - 0.5) * 24 // lineage colour plus the fish's own variation
    const energy = o.energy / maxEnergy(o.genome)
    const wake = wakes.get(o.id) ?? []
    wake.unshift(x - Math.cos(heading) * len, y - Math.sin(heading) * len)
    if (wake.length > WAKE) wake.length = WAKE
    nextWakes.set(o.id, wake)
    ctx.strokeStyle = `hsl(${colour} 90% 60%)`
    for (let j = 0; j + 3 < wake.length; j += 2) { // a wake that thins and fades behind the tail
      const k = 1 - j / WAKE
      ctx.globalAlpha = 0.45 * k * k * (0.4 + 0.6 * energy)
      ctx.lineWidth = (1 + len * 0.16) * k
      ctx.beginPath()
      ctx.moveTo(wake[j], wake[j + 1])
      ctx.lineTo(wake[j + 2], wake[j + 3])
      ctx.stroke()
    }
    return { o, x, y, heading, len, colour, energy }
  })
  wakes = nextWakes
  for (const f of fish) { // dimmer = hungrier
    const r = f.len * 2.4
    ctx.globalAlpha = 0.25 + 0.6 * f.energy
    ctx.drawImage(glows[f.o.lineage % glows.length], f.x - r, f.y - r, 2 * r, 2 * r)
  }
  ctx.globalCompositeOperation = 'source-over'
  for (const { o, x, y, heading, len, colour, energy } of fish) {
    const g = o.genome
    const wide = len * 0.42
    const fin = len * (0.5 + 0.6 * g.finSize)
    const beat = Math.sin(anim * (5 + 7 * g.speed) + o.id) // tail beat, faster for faster swimmers
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(heading + beat * 0.05)
    if (Math.cos(heading) < 0) ctx.scale(1, -1) // keep the belly down when swimming left
    ctx.globalAlpha = 0.65 + 0.35 * energy
    ctx.fillStyle = `hsl(${colour} 90% ${46 + 16 * energy}%)`
    ctx.save()
    ctx.translate(-len * 0.72, 0)
    ctx.rotate(beat * 0.5)
    ctx.beginPath()
    ctx.moveTo(len * 0.1, 0)
    ctx.quadraticCurveTo(-fin * 0.5, -fin * 0.1, -fin, -fin * 0.62)
    ctx.quadraticCurveTo(-fin * 0.62, 0, -fin, fin * 0.62)
    ctx.quadraticCurveTo(-fin * 0.5, fin * 0.1, len * 0.1, 0)
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.moveTo(len, 0)
    ctx.bezierCurveTo(len * 0.5, -wide * 1.25, -len * 0.4, -wide, -len * 0.78, 0)
    ctx.bezierCurveTo(-len * 0.4, wide, len * 0.5, wide * 1.25, len, 0)
    ctx.fill()
    ctx.globalAlpha = 0.3 + 0.6 * energy // the light organ along the flank
    ctx.fillStyle = `hsl(${colour} 100% 86%)`
    ctx.beginPath()
    ctx.ellipse(len * 0.1, 0, len * 0.5, wide * 0.28, 0, 0, TAU)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = '#01070f'
    ctx.beginPath()
    ctx.arc(len * 0.6, -wide * 0.22, Math.max(0.9, len * 0.09), 0, TAU)
    ctx.fill()
    ctx.restore()
  }

  // A birth flares in the lineage's colour; a death dims and sinks.
  ctx.globalCompositeOperation = 'lighter'
  effects = effects.filter((e) => now - e.at < 900)
  for (const e of effects) {
    const k = (now - e.at) / 900
    const r = e.birth ? 10 + 30 * k : 12 - 6 * k
    ctx.globalAlpha = (e.birth ? 0.9 : 0.45) * (1 - k)
    ctx.drawImage(glows[e.lineage % glows.length], e.x - r, e.y + (e.birth ? 0 : 22 * k) - r, 2 * r, 2 * r)
  }
  ctx.globalCompositeOperation = 'source-over'

  // Recent pull requests: an arc between the eldest fish of the two lineages, or a ring if only one branch is in the snapshot.
  ctx.font = '500 10px "Martian Mono Variable", ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = s.cursor - 1; i >= 0 && s.tick - data.events[i].tick < LINK_TICKS; i--) {
    const e = data.events[i]
    if (e.kind !== 'PR_OPENED' && e.kind !== 'PR_MERGED') continue
    const [head, base] = e.branches.map((b) => {
      const lineage = data.branches.indexOf(b)
      return lineage < 0 ? undefined : fish.find((f) => f.o.lineage === lineage)
    })
    const anchor = base ?? head
    if (!anchor) continue
    const age = (s.tick - e.tick) / LINK_TICKS
    const merged = e.kind === 'PR_MERGED'
    const tint = merged ? '#ffffff' : '#b79bff'
    let lx = anchor.x
    let ly = anchor.y - 34
    ctx.save()
    ctx.globalAlpha = 1 - age
    ctx.strokeStyle = ctx.shadowColor = tint
    ctx.shadowBlur = merged ? 16 : 8
    ctx.lineWidth = merged ? 2 : 1.2
    ctx.setLineDash(merged ? [] : [3, 7])
    ctx.beginPath()
    if (head && base) {
      const mx = (head.x + base.x) / 2
      const my = (head.y + base.y) / 2 - Math.max(40, 0.3 * Math.hypot(head.x - base.x, head.y - base.y))
      const along = (k: number) => [ // point on the arc, k from head (0) to base (1)
        (1 - k) * (1 - k) * head.x + 2 * k * (1 - k) * mx + k * k * base.x,
        (1 - k) * (1 - k) * head.y + 2 * k * (1 - k) * my + k * k * base.y,
      ]
      ctx.moveTo(head.x, head.y)
      ctx.quadraticCurveTo(mx, my, base.x, base.y)
      ctx.stroke()
      const [px, py] = along((anim * 0.5) % 1) // a spark travelling toward the base branch
      ctx.drawImage(plankton, px - 9, py - 9, 18, 18)
      ;[lx, ly] = along(0.5)
      ly -= 16
    } else {
      ctx.arc(anchor.x, anchor.y, 18 + 46 * age, 0, TAU)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.shadowBlur = 0
    const label = `PR #${e.id} ${merged ? 'MERGED' : 'OPENED'}`
    const width = ctx.measureText(label).width + 16
    ctx.fillStyle = 'rgba(1, 8, 16, 0.75)'
    ctx.beginPath()
    ctx.roundRect(lx - width / 2, ly - 9, width, 18, 9)
    ctx.fill()
    ctx.fillStyle = tint
    ctx.fillText(label, lx, ly + 0.5)
    ctx.restore()
  }
}

use(demo)
requestAnimationFrame(frame)

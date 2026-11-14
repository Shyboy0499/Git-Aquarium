// Deterministic artificial-life engine.
// No DOM, network, or storage: same seed -> same state at the same tick.

export const TRAITS = [
  'bodyLength', 'finSize', 'hue', 'speed',
  'metabolism', 'perceptionRange', 'lifespan', 'mutationRate',
] as const
export type Trait = (typeof TRAITS)[number]
export type Genome = Record<Trait, number> // every trait normalized to [0, 1]

export interface Organism {
  id: number
  lineage: number
  genome: Genome
  parents: [number, number] | null // null for the founding population
  x: number
  y: number
  heading: number
  energy: number
  age: number // ticks
  cooldown: number // ticks until it may reproduce again
}

export interface State {
  tick: number
  rng: number // mulberry32 state, kept in the state so a snapshot resumes exactly
  nextId: number
  organisms: Organism[]
  food: { x: number; y: number }[]
  births: number
  deaths: number
  mutations: number
  cursor: number // index of the next repository event to apply
  failing: string[] // CI groups (workflow@branch) whose latest supported result is a failure
  penalty: number // environmental energy cost per organism per tick
}

export type EventKind = 'COMMIT_OBSERVED' | 'PR_OPENED' | 'PR_MERGED' | 'CI_FAILED' | 'CI_PASSED'

// One frozen repository record, already placed on the replay clock.
export interface GitEvent {
  tick: number
  at: string // ISO time used as the replay proxy (committer, created, merged, or completed time)
  kind: EventKind
  id: string // sha, PR number, or run id
  title: string
  url: string | null // GitHub source; null for synthetic events
  branches: string[] // [] unknown, [head, base] for PRs, [branch] for CI
  group: string // CI only: workflow@branch
}

// Designed simulation rules, not measurements of software quality.
export const RULES: Record<EventKind, { id: string; effect: string }> = {
  COMMIT_OBSERVED: { id: 'R-COMMIT-FOOD', effect: 'adds a bounded amount of food' },
  PR_OPENED: { id: 'R-PR-OPEN', effect: 'shows an interaction between lineages; no ecological effect' },
  PR_MERGED: { id: 'R-PR-MERGE', effect: 'adds a bounded resource pulse and a visual connection' },
  CI_FAILED: { id: 'R-CI-FAIL', effect: 'raises the bounded environmental penalty for this workflow and branch' },
  CI_PASSED: { id: 'R-CI-PASS', effect: "clears this workflow and branch's penalty; the water recovers gradually" },
}

// Starting parameters from the README; tuning knobs, not measurements.
export const P = {
  width: 800,
  height: 500,
  ticksPerSecond: 20,
  startPopulation: 64,
  maxPopulation: 200,
  maxFood: 500,
  startFood: 120,
  foodPerTick: 0.4, // baseline supply (R-BASELINE): chance of one new particle per tick, with or without Git activity
  commitFood: 12, // particles per deduplicated commit
  mergeFood: 40, // particles per confirmed merge
  penaltyPerGroup: 0.015, // energy per tick for each failing CI group
  maxPenalty: 0.045,
  penaltyRecovery: 0.0003, // how fast the penalty falls per tick once a group passes
  foodEnergy: 12,
  baseCost: 0.03,
  moveCost: 0.008,
  senseCost: 0.0001,
  wander: 0.6, // max heading change per tick (radians) when no food is in sight
  maturity: 0.15, // fraction of lifespan before breeding
  breedEnergy: 0.6, // fraction of max energy needed to breed
  breedCost: 0.25, // fraction of max energy each parent gives the child
  cooldown: 200,
  mateRange: 140,
  mutationStep: 0.1,
}

export const maxEnergy = (g: Genome) => 60 + 80 * g.bodyLength
const lifespanTicks = (g: Genome) => 1200 + 3600 * g.lifespan
const sightRange = (g: Genome) => 30 + 120 * g.perceptionRange
const swimSpeed = (g: Genome) => 0.8 + 2.2 * g.speed
const eatRange = (g: Genome) => 4 + 6 * g.bodyLength
const mutationChance = (g: Genome) => 0.02 + 0.18 * g.mutationRate

function rand(s: State): number {
  s.rng = (s.rng + 0x6d2b79f5) | 0
  let t = s.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const spot = (s: State) => ({ x: rand(s) * P.width, y: rand(s) * P.height })

// One lineage per observed branch (R-BRANCH-LINEAGE); the starting population is shared between them.
export function createState(seed: number, lineages = 4): State {
  const s: State = {
    tick: 0, rng: seed | 0, nextId: 1,
    organisms: [], food: [], births: 0, deaths: 0, mutations: 0,
    cursor: 0, failing: [], penalty: 0,
  }
  for (let i = 0; i < P.startPopulation; i++) {
    const genome = {} as Genome
    for (const t of TRAITS) genome[t] = rand(s)
    s.organisms.push({
      id: s.nextId++, lineage: i % lineages, genome, parents: null,
      ...spot(s), heading: rand(s) * 2 * Math.PI,
      energy: maxEnergy(genome) * 0.6,
      age: Math.floor(rand(s) * lifespanTicks(genome) * 0.5), // mixed ages so founders don't die together
      cooldown: 0,
    })
  }
  for (let i = 0; i < P.startFood; i++) s.food.push(spot(s))
  return s
}

function addFood(s: State, particles: number) {
  for (let i = 0; i < particles && s.food.length < P.maxFood; i++) s.food.push(spot(s))
}

// `events` is the frozen dataset in replay order; the state only remembers how far it has read.
export function step(s: State, events: readonly GitEvent[] = []): void {
  s.tick++
  // 1. Scheduled repository events.
  for (; s.cursor < events.length && events[s.cursor].tick <= s.tick; s.cursor++) {
    const e = events[s.cursor]
    if (e.kind === 'COMMIT_OBSERVED') addFood(s, P.commitFood)
    else if (e.kind === 'PR_MERGED') addFood(s, P.mergeFood)
    else if (e.kind === 'CI_FAILED') { if (!s.failing.includes(e.group)) s.failing.push(e.group) }
    else if (e.kind === 'CI_PASSED') s.failing = s.failing.filter((g) => g !== e.group)
  }
  // Failures bite at once; recovery is gradual.
  const target = Math.min(P.maxPenalty, s.failing.length * P.penaltyPerGroup)
  s.penalty = s.penalty < target ? target : Math.max(target, s.penalty - P.penaltyRecovery)

  // 2. Baseline resources.
  if (rand(s) < P.foodPerTick) addFood(s, 1)

  // 3-5. Perception, movement, eating, energy, age.
  for (const o of s.organisms) {
    const g = o.genome
    const sight = sightRange(g)
    const speed = swimSpeed(g)
    // ponytail: O(organisms x food) scan, ~100k checks at the caps; spatial grid if the caps grow
    let target = -1
    let best = sight * sight
    for (let i = 0; i < s.food.length; i++) {
      const dx = s.food[i].x - o.x
      const dy = s.food[i].y - o.y
      const d = dx * dx + dy * dy
      if (d < best) { best = d; target = i }
    }
    let move = speed
    if (target < 0) {
      o.heading += (rand(s) - 0.5) * 2 * P.wander
    } else {
      const gap = Math.sqrt(best)
      o.heading = Math.atan2(s.food[target].y - o.y, s.food[target].x - o.x)
      move = Math.min(speed, gap)
      if (gap - move <= eatRange(g)) {
        o.energy = Math.min(maxEnergy(g), o.energy + P.foodEnergy * (0.6 + 0.8 * g.metabolism))
        s.food[target] = s.food[s.food.length - 1]
        s.food.pop()
      }
    }
    o.x += Math.cos(o.heading) * move
    o.y += Math.sin(o.heading) * move
    if (o.x < 0 || o.x > P.width) { // bounce off the glass
      o.x = Math.min(P.width, Math.max(0, o.x))
      o.heading = Math.PI - o.heading
    }
    if (o.y < 0 || o.y > P.height) {
      o.y = Math.min(P.height, Math.max(0, o.y))
      o.heading = -o.heading
    }
    o.energy -=
      P.baseCost * (0.5 + g.metabolism) * (0.5 + g.bodyLength) +
      P.moveCost * speed * speed +
      P.senseCost * sight +
      s.penalty
    o.age++
    if (o.cooldown > 0) o.cooldown--
  }

  // 6. Deaths: starvation or old age.
  const alive = s.organisms.filter((o) => o.energy > 0 && o.age < lifespanTicks(o.genome))
  s.deaths += s.organisms.length - alive.length
  s.organisms = alive

  // 7. Reproduction: two ready organisms of the same lineage within mating range.
  const ready = (o: Organism) =>
    o.cooldown === 0 &&
    o.age >= P.maturity * lifespanTicks(o.genome) &&
    o.energy >= P.breedEnergy * maxEnergy(o.genome)
  const n = alive.length // newborns appended below are never scanned this tick
  for (let i = 0; i < n && alive.length < P.maxPopulation; i++) {
    const a = alive[i]
    if (!ready(a)) continue
    for (let j = i + 1; j < n; j++) {
      const b = alive[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      if (b.lineage !== a.lineage || !ready(b) || dx * dx + dy * dy > P.mateRange * P.mateRange) continue
      alive.push(breed(s, a, b))
      break
    }
  }
}

function breed(s: State, a: Organism, b: Organism): Organism {
  const chance = (mutationChance(a.genome) + mutationChance(b.genome)) / 2
  const genome = {} as Genome
  for (const t of TRAITS) {
    let v = rand(s) < 0.5 ? a.genome[t] : b.genome[t]
    if (rand(s) < chance) {
      v = Math.min(1, Math.max(0, v + (rand(s) - 0.5) * 2 * P.mutationStep))
      s.mutations++
    }
    genome[t] = v
  }
  // Parents pay; the child starts with what they paid (anything above its capacity is lost).
  const paidA = P.breedCost * maxEnergy(a.genome)
  const paidB = P.breedCost * maxEnergy(b.genome)
  a.energy -= paidA
  b.energy -= paidB
  a.cooldown = b.cooldown = P.cooldown
  s.births++
  return {
    id: s.nextId++, lineage: a.lineage, genome, parents: [a.id, b.id],
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, heading: rand(s) * 2 * Math.PI,
    energy: Math.min(maxEnergy(genome), paidA + paidB), age: 0, cooldown: 0,
  }
}

// FNV-1a over the JSON form; JSON round-trips doubles exactly, so equal hash <=> equal state.
export function hashState(s: State): string {
  const json = JSON.stringify(s)
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

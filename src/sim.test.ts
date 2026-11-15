import { expect, test } from 'vitest'
import { fromGitHub } from './dataset'
import { demo } from './demo'
import { P, TRAITS, createState, hashState, lifespanTicks, maxEnergy, step, type GitEvent, type State } from './sim'

function run(seed: number, ticks: number, events: GitEvent[] = [], check?: (s: State) => void): State {
  const s = createState(seed)
  for (let i = 0; i < ticks; i++) {
    step(s, events)
    check?.(s)
  }
  return s
}

test('same seed and frozen dataset give the same state hash after 10,000 ticks', () => {
  const a = run(42, 10_000, demo.events)
  expect(a.cursor).toBe(demo.events.length)
  expect(hashState(a)).toBe(hashState(run(42, 10_000, demo.events)))
  expect(hashState(run(43, 100))).not.toBe(hashState(run(42, 100)))
})

test('a serialized snapshot resumes to the same state', () => {
  const a = run(5, 1500, demo.events)
  const b: State = JSON.parse(JSON.stringify(a))
  for (let i = 0; i < 1500; i++) {
    step(a, demo.events)
    step(b, demo.events)
  }
  expect(hashState(b)).toBe(hashState(a))
})

test('the ecosystem stays within its bounds and stays alive', () => {
  const s = run(7, 10_000, demo.events, (s) => {
    if (s.organisms.length > P.maxPopulation) throw new Error(`population ${s.organisms.length} at tick ${s.tick}`)
    if (s.food.length > P.maxFood) throw new Error(`food ${s.food.length} at tick ${s.tick}`)
    if (!(s.penalty >= 0 && s.penalty <= P.maxPenalty)) throw new Error(`penalty ${s.penalty} at tick ${s.tick}`)
    for (const o of s.organisms) {
      if (!(o.energy > 0 && o.energy <= maxEnergy(o.genome))) throw new Error(`energy ${o.energy} at tick ${s.tick}`)
      if (!(o.x >= 0 && o.x <= P.width && o.y >= 0 && o.y <= P.height && o.z >= 0 && o.z <= P.depth)) throw new Error(`escaped at tick ${s.tick}`)
      if (Math.abs(Math.hypot(o.ux, o.uy, o.uz) - 1) > 1e-9) throw new Error(`direction is not a unit vector at tick ${s.tick}`)
      for (const t of TRAITS) {
        if (!(o.genome[t] >= 0 && o.genome[t] <= 1)) throw new Error(`${t}=${o.genome[t]} at tick ${s.tick}`)
      }
    }
  })
  expect(s.organisms.length).toBeGreaterThan(0)
  expect(s.births).toBeGreaterThan(0)
  expect(s.deaths).toBeGreaterThan(0)
  expect(s.mutations).toBeGreaterThan(0)
  expect(s.organisms.length).toBe(P.startPopulation + s.births - s.deaths)
  const sum = (key: 'born' | 'starved' | 'aged') => s.tally.reduce((n, t) => n + t[key], 0)
  expect(sum('born')).toBe(s.births) // the per-lineage record accounts for every birth and death
  expect(sum('starved') + sum('aged')).toBe(s.deaths)
  expect(sum('starved')).toBeGreaterThan(0)
  expect(sum('aged')).toBeGreaterThan(0)
})

test('only eligible pairs reproduce, and both parents pay', () => {
  let newest = P.startPopulation
  let checked = 0
  run(3, 4000, demo.events, (s) => {
    for (const child of s.organisms) {
      if (child.id <= newest) continue
      const parents = s.organisms.filter((o) => child.parents!.includes(o.id))
      expect(parents).toHaveLength(2) // two distinct parents, both still alive
      for (const p of parents) {
        expect(p.lineage).toBe(child.lineage)
        expect(p.age).toBeGreaterThanOrEqual(P.maturity * lifespanTicks(p.genome))
        expect(p.cooldown).toBe(P.cooldown) // so neither can breed again this tick
        // It had the breeding threshold and paid the breeding cost, so this much is left.
        expect(p.energy).toBeGreaterThanOrEqual((P.breedEnergy - P.breedCost) * maxEnergy(p.genome) - 1e-9)
      }
      expect(child.age).toBe(0)
      expect(child.energy).toBeLessThanOrEqual(maxEnergy(child.genome))
      checked++
    }
    newest = Math.max(newest, ...s.organisms.map((o) => o.id))
  })
  expect(checked).toBeGreaterThan(20)
})

test('mapping rules: commits and merges add bounded food, CI penalties are tracked per group', () => {
  const event = (tick: number, kind: GitEvent['kind'], group = ''): GitEvent =>
    ({ tick, kind, group, at: '', id: `${tick}`, title: '', url: null, branches: [] })
  const s = createState(1)
  s.organisms = [] // nothing eats, so food counts are exact
  s.food = []
  const events = [
    event(1, 'COMMIT_OBSERVED'), event(2, 'PR_OPENED'), event(3, 'PR_MERGED'),
    event(4, 'CI_FAILED', 'build@main'), event(4, 'CI_FAILED', 'test@dev'), event(5, 'CI_FAILED', 'build@main'),
    event(6, 'CI_PASSED', 'test@main'), event(7, 'CI_PASSED', 'build@main'),
    ...Array.from({ length: 60 }, (_, i) => event(900 + i, 'PR_MERGED')),
  ]
  // Baseline supply adds at most one particle per tick, so event food is pinned to a narrow range.
  const expectFood = (fromEvents: number) => {
    expect(s.food.length).toBeGreaterThanOrEqual(fromEvents)
    expect(s.food.length).toBeLessThanOrEqual(fromEvents + s.tick)
  }
  step(s, events)
  expectFood(P.commitFood)
  step(s, events)
  step(s, events)
  expectFood(P.commitFood + P.mergeFood) // the opened PR in between added nothing
  step(s, events)
  step(s, events)
  expect(s.penalty).toBeCloseTo(2 * P.penaltyPerGroup) // a repeated failure in one group counts once
  step(s, events)
  expect(s.failing).toEqual(['build@main', 'test@dev']) // success in another group clears nothing
  step(s, events)
  expect(s.failing).toEqual(['test@dev'])
  expect(s.penalty).toBeLessThan(2 * P.penaltyPerGroup) // recovery has started...
  expect(s.penalty).toBeGreaterThan(P.penaltyPerGroup) // ...but is gradual
  for (let i = 0; i < 1000; i++) step(s, events)
  expect(s.penalty).toBeCloseTo(P.penaltyPerGroup)
  expect(s.food.length).toBe(P.maxFood) // a burst of merges cannot exceed the food cap
})

test('GitHub import: dedupes, keeps only supported CI results, and reports what is missing', () => {
  const commit = (sha: string, date: string, html_url = `https://github.com/o/r/commit/${sha}`) =>
    ({ sha, html_url, commit: { message: `Change ${sha}\n\nbody`, committer: { date } } })
  const d = fromGitHub('o/r', {
    branches: [{ name: 'main' }, { name: 'dev' }],
    commits: [
      commit('aaa', '2026-01-02T00:00:00Z'), commit('aaa', '2026-01-02T00:00:00Z'),
      commit('bbb', '2026-01-01T00:00:00Z', 'javascript:alert(1)'), commit('ccc', 'not a date'),
    ],
    pulls: [{
      number: 7, title: 'Add thing', html_url: 'https://github.com/o/r/pull/7',
      created_at: '2026-01-03T00:00:00Z', merged_at: '2026-01-04T00:00:00Z', head: { ref: 'dev' }, base: { ref: 'main' },
    }],
    runs: [
      { id: 1, name: 'ci', workflow_id: 9, head_branch: 'dev', conclusion: 'timed_out', updated_at: '2026-01-03T12:00:00Z' },
      { id: 2, name: 'ci', workflow_id: 9, head_branch: 'dev', conclusion: 'cancelled', updated_at: '2026-01-03T13:00:00Z' },
    ],
  })
  expect(d.events.map((e) => `${e.kind} ${e.id}`)).toEqual([
    'COMMIT_OBSERVED bbb', 'COMMIT_OBSERVED aaa', 'PR_OPENED 7', 'CI_FAILED 1', 'PR_MERGED 7',
  ])
  expect(d.events[0].url).toBeNull() // only github.com links survive
  expect(d.events[0].title).toBe('Change bbb')
  expect(d.events[3].group).toBe('9@dev')
  expect(d.events.map((e) => e.tick)).toEqual([...d.events.map((e) => e.tick)].sort((a, b) => a - b))
  expect(d.branches).toEqual(['main', 'dev'])
  expect(d.notices.join(' ')).toMatch(/1 workflow runs with other conclusions/)

  const many = Array.from({ length: 100 }, (_, i) => commit(`s${i}`, new Date(Date.UTC(2026, 1, 1 + i)).toISOString()))
  const cut = fromGitHub('o/r', { branches: [], commits: many, pulls: [{ number: 1, created_at: '2025-01-01T00:00:00Z' }], runs: null })
  expect(cut.events).toHaveLength(100) // the PR predates the truncated commit window, so it is left out and reported
  expect(cut.notices.join(' ')).toMatch(/Only the 100 most recent commits.*1 older records were left out/)
  expect(cut.notices.join(' ')).toMatch(/Actions data was unavailable/)
})

import { expect, test } from 'vitest'
import { P, TRAITS, createState, hashState, maxEnergy, step, type State } from './sim'

function run(seed: number, ticks: number, check?: (s: State) => void): State {
  const s = createState(seed)
  for (let i = 0; i < ticks; i++) {
    step(s)
    check?.(s)
  }
  return s
}

test('same seed gives the same state hash after 10,000 ticks', () => {
  expect(hashState(run(42, 10_000))).toBe(hashState(run(42, 10_000)))
  expect(hashState(run(43, 100))).not.toBe(hashState(run(42, 100)))
})

test('a serialized snapshot resumes to the same state', () => {
  const a = run(5, 500)
  const b: State = JSON.parse(JSON.stringify(a))
  for (let i = 0; i < 500; i++) {
    step(a)
    step(b)
  }
  expect(hashState(b)).toBe(hashState(a))
})

test('the ecosystem stays within its bounds and stays alive', () => {
  const s = run(7, 10_000, (s) => {
    if (s.organisms.length > P.maxPopulation) throw new Error(`population ${s.organisms.length} at tick ${s.tick}`)
    if (s.food.length > P.maxFood) throw new Error(`food ${s.food.length} at tick ${s.tick}`)
    for (const o of s.organisms) {
      if (!(o.energy > 0 && o.energy <= maxEnergy(o.genome))) throw new Error(`energy ${o.energy} at tick ${s.tick}`)
      if (!(o.x >= 0 && o.x <= P.width && o.y >= 0 && o.y <= P.height)) throw new Error(`escaped at tick ${s.tick}`)
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
})

import { afterEach, expect, test, vi } from 'vitest'
import { BUDGET, importRepo, openDataset, saveDataset } from './dataset'
import { demo } from './demo'

afterEach(() => vi.unstubAllGlobals())

const NOW = Date.UTC(2026, 5, 30)
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()

// A stand-in GitHub: `commits` commits on main, ten minutes apart. Returns the direct requests it was asked for.
function github(commits: number, headers: Record<string, string> = {}) {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.startsWith('/api/')) return new Response('{}', { status: 503 }) // a local server without a token
    asked.push(url)
    const q = new URL(url)
    const page = Number(q.searchParams.get('page') ?? 1)
    const body =
      q.pathname.endsWith('/branches') ? [{ name: 'main' }]
      : q.pathname.endsWith('/pulls') ? [{ number: 5, created_at: ago(2), updated_at: ago(2), head: { ref: 'x' }, base: { ref: 'main' } }]
      : q.pathname.endsWith('/runs') ? { workflow_runs: [] }
      : q.pathname.endsWith('/commits')
        ? Array.from({ length: Math.max(0, Math.min(100, commits - 100 * (page - 1))) }, (_, i) => {
          const n = 100 * (page - 1) + i
          return { sha: `c${n}`, commit: { message: `c${n}`, committer: { date: new Date(NOW - n * 600_000).toISOString() } } }
        })
      : { default_branch: 'main' }
    return new Response(JSON.stringify(body), { headers })
  })
  return asked
}

test('an import reads page after page until the period is covered', async () => {
  const asked = github(250)
  const steps: number[] = []
  const d = await importRepo('o/r', 30, NOW, (n) => steps.push(n))
  expect(d.events.filter((e) => e.kind === 'COMMIT_OBSERVED')).toHaveLength(250)
  expect(asked.filter((u) => u.includes('/commits'))).toHaveLength(3)
  expect(asked.find((u) => u.includes('/commits'))).toContain(`since=${ago(30)}`)
  expect(asked).toHaveLength(7) // repository, branches, pull requests, runs, and three commit pages: one small-repo import
  expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(d.notices.join(' ')).toMatch(/Asked for the last 30 days.*Read with 7 GitHub requests; one import may use 30 of the 60/)
  expect(d.notices.join(' ')).not.toMatch(/Stopped early/)
})

test('an import stops at its request budget and says how far back it reached', async () => {
  const asked = github(100_000)
  const d = await importRepo('o/r', 90, NOW)
  expect(asked).toHaveLength(BUDGET.open)
  expect(d.notices.join(' ')).toMatch(/Stopped early, so older records are missing: commits on main \(back to 2026-0/)

  const few = github(100_000, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '5' })
  await importRepo('o/r', 90, NOW)
  expect(few).toHaveLength(6) // never more than GitHub says are left this hour

  const token = github(100_000, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' })
  await importRepo('o/r', 90, NOW)
  expect(token).toHaveLength(134) // 90 days of these commits is 130 pages, inside a token's budget of 300
})

test('a saved dataset opens as the same replay, and a file is not trusted', () => {
  const { dataset, seed } = openDataset(saveDataset(demo, 7))
  expect(seed).toBe(7)
  expect(dataset).toEqual(demo)

  const file = (change: (f: any) => void) => {
    const f = JSON.parse(saveDataset(demo, 1))
    change(f)
    return JSON.stringify(f)
  }
  expect(() => openDataset('nope')).toThrow(/not JSON/)
  expect(() => openDataset('{"format":"other"}')).toThrow(/not a Git Aquarium dataset/)
  expect(() => openDataset(file((f) => { f.dataset.events[3].tick = 0 }))).toThrow(/Event 4 .* out of replay order/)
  expect(() => openDataset(file((f) => { f.dataset.events[0].lineage = 99 }))).toThrow(/Event 1/)
  expect(() => openDataset(file((f) => { f.dataset.events[0].kind = 'DROP_TABLE' }))).toThrow(/Event 1/)
  const unsafe = openDataset(file((f) => { f.dataset.events[0].url = 'javascript:alert(1)' }))
  expect(unsafe.dataset.events[0].url).toBeNull() // only github.com links survive
})

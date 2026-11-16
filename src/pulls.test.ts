import { expect, test, vi } from 'vitest'
import { OTHERS, STALE_DAYS, demoPulls, fetchPulls, fromGraph, fromRest, sizeOfDiff, tally } from './pulls'
import { placePulls, swim } from './pullschool'
import { P } from './sim'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 16)
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

test('the REST list becomes fish with what one request can know, and nothing more', () => {
  const set = fromRest('o/r', [
    { number: 9, title: 'Add thing\nsecond line', html_url: 'https://github.com/o/r/pull/9', user: { login: 'ann' }, draft: true,
      created_at: ago(40), updated_at: ago(35), labels: [{ name: 'bug' }], requested_reviewers: [{ login: 'bo' }] },
    { number: 8, title: 'Fix', html_url: 'javascript:alert(1)', user: null, created_at: ago(2), updated_at: 'not a date' },
  ], 0, NOW)
  expect(set).toMatchObject({ total: 2, exactTotal: true, detailed: false, source: 'recorded' })
  expect(set.pulls[0]).toMatchObject({
    number: 9, title: 'Add thing', author: 'ann', draft: true, ageDays: 40, quietDays: 35, labels: ['bug'], waiting: true,
    lines: null, review: null, checks: null, // unknown without a token: null, not zero and not "passing"
  })
  expect(set.pulls[1]).toMatchObject({ url: '', author: 'unknown', quietDays: 0, waiting: false }) // only github.com links survive
  expect(set.notices.join(' ')).toMatch(/need a GitHub token/)
  expect(tally(set)).toMatchObject({ drawn: 2, quiet: 1, drafts: 1, waiting: 1, failing: 0, approved: 0 })

  const many = fromRest('o/r', Array.from({ length: 100 }, (_, i) => ({ number: i + 1, user: { login: `u${i % 20}` }, created_at: ago(1), updated_at: ago(1) })), 3, NOW)
  expect(many).toMatchObject({ total: 300, exactTotal: false }) // three pages: 201 to 300
  expect(many.notices.join(' ')).toMatch(/Only the 100 most recently opened of about 300/)
  expect(many.authors).toHaveLength(8) // seven authors and everyone else
  expect(many.authors[7]).toBe(OTHERS)
  expect(Math.max(...many.pulls.map((p) => p.group))).toBe(7)
  expect(many.notices.join(' ')).toMatch(/the other 13 authors share one/)
})

test('the GraphQL answer adds size, review, and checks', () => {
  const node = (number: number, extra: object) => ({
    number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, createdAt: ago(3), updatedAt: ago(1),
    additions: 10, deletions: 5, reviewDecision: null, author: { login: 'ann' }, labels: { nodes: [] }, reviewRequests: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, ...extra,
  })
  const set = fromGraph('o/r', { totalCount: 295, nodes: [
    node(3, { reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }),
    node(2, { reviewDecision: 'CHANGES_REQUESTED', additions: 4000, deletions: 1000, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
    node(1, { author: null, commits: { nodes: [] }, reviewRequests: { totalCount: 2 } }),
  ] }, NOW)
  expect(set).toMatchObject({ total: 295, exactTotal: true, detailed: true })
  expect(set.pulls.map((p) => [p.lines, p.review, p.checks])).toEqual([
    [15, 'approved', 'passing'], [5000, 'changes requested', 'failing'], [15, 'none', 'none'],
  ])
  expect(set.pulls[2]).toMatchObject({ author: 'unknown', waiting: true })
  expect(tally(set)).toMatchObject({ failing: 1, approved: 1 })
  expect(set.notices.join(' ')).not.toMatch(/need a GitHub token/)
  expect(fromGraph('o/r', 'not an object', NOW).pulls).toEqual([]) // a malformed answer yields nothing, not a crash
})

test('size grows with the diff and is a fixed middle value when the diff is unknown', () => {
  expect(sizeOfDiff(0)).toBe(0)
  expect(sizeOfDiff(5000)).toBe(1)
  expect(sizeOfDiff(1_000_000)).toBe(1)
  expect(sizeOfDiff(100)).toBeGreaterThan(sizeOfDiff(10))
  expect(sizeOfDiff(null)).toBe(0.45)
})

test('fetching prefers the local server and falls back to GitHub', async () => {
  const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
  const rest = [{ number: 1, user: { login: 'ann' }, created_at: ago(1), updated_at: ago(1) }]
  const calls: string[] = []
  const stub = (relay: () => Response | Promise<Response>, github: () => Response) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return url.startsWith('/api/') ? relay() : github() }))
  try {
    stub(() => json({ totalCount: 1, nodes: [{ number: 7, additions: 1, deletions: 1, author: { login: 'bo' } }] }), () => json(rest))
    expect(await fetchPulls('o/r', NOW)).toMatchObject({ detailed: true, pulls: [{ number: 7 }] })
    expect(calls).toEqual(['/api/github/open-pulls?repo=o%2Fr']) // GitHub was not asked a second time

    stub(() => json({ reason: 'unconfigured' }, 503), () => json(rest)) // a server with no token
    expect(await fetchPulls('https://github.com/o/r', NOW)).toMatchObject({ detailed: false, pulls: [{ number: 1 }] })
    stub(() => new Response('<!doctype html>', { status: 200 }), () => json(rest, 200, { link: '<https://api.github.com/x?page=4>; rel="last"' })) // a static host
    expect(await fetchPulls('o/r', NOW)).toMatchObject({ detailed: false, total: 400, exactTotal: false })
    stub(() => Promise.reject(new Error('offline')), () => json({}, 403))
    await expect(fetchPulls('o/r', NOW)).rejects.toThrow(/rate limit/)
    stub(() => json({ reason: 'not found' }, 404), () => json(rest))
    await expect(fetchPulls('o/r', NOW)).rejects.toThrow(/not found/)
    await expect(fetchPulls('a/b c/d', NOW)).rejects.toThrow(/one repository/)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the demo is offline, and its fish stay in the tank and apart', () => {
  const set = demoPulls(NOW)
  expect(set).toMatchObject({ source: 'synthetic', detailed: true, exactTotal: true })
  expect(set.notices[0]).toMatch(/fictional/)
  expect(tally(set).quiet).toBeGreaterThan(0)
  expect(set.pulls.every((p) => p.group >= 0 && p.group < set.authors.length)).toBe(true)

  const fish = placePulls(set.pulls)
  expect(placePulls(set.pulls)).toEqual(fish) // the same pull requests start in the same places
  const still = fish.find((f) => f.pull.quietDays >= STALE_DAYS)!
  const lively = fish.find((f) => f.pull.quietDays === 0)!
  expect(lively.speed).toBeGreaterThan(still.speed) // quiet pull requests are slow
  for (let i = 0; i < 3000; i++) swim(fish, 1 / 60, i / 60)
  for (const f of fish) {
    expect(f.x).toBeGreaterThanOrEqual(0); expect(f.x).toBeLessThanOrEqual(P.width)
    expect(f.y).toBeGreaterThanOrEqual(0); expect(f.y).toBeLessThanOrEqual(P.height)
    expect(f.z).toBeGreaterThanOrEqual(0); expect(f.z).toBeLessThanOrEqual(P.depth)
    expect(Number.isFinite(f.yaw)).toBe(true)
  }
})

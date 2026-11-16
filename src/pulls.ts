// One repository's open pull requests, one fish each (issue #6). Nothing here renders.
// Every visible property is a recorded fact about the pull request; what could not be read is null, never guessed.
import { parseRepos } from './projects'

export type Checks = 'passing' | 'failing' | 'pending' | 'none'
export type Review = 'approved' | 'changes requested' | 'review required' | 'none'

export interface OpenPull {
  number: number
  title: string
  url: string // a github.com address, or ''
  author: string
  group: number // index into PullSet.authors: the authors with the most open pull requests, then everyone else
  draft: boolean
  created: string
  updated: string
  ageDays: number // since it was opened
  quietDays: number // since anything last happened on it
  labels: string[]
  waiting: boolean // a review has been requested and not yet given
  // Known only when the local server holds a GitHub token:
  lines: number | null // added plus deleted
  review: Review | null
  checks: Checks | null
}

export interface PullSet {
  repo: string
  source: 'synthetic' | 'recorded'
  pulls: OpenPull[] // the most recently opened, at most 100
  total: number // every open pull request
  exactTotal: boolean // false: rounded up to a whole page of 100
  detailed: boolean // sizes, reviews, and checks were read
  authors: string[]
  notices: string[]
  at: string
}

export const STALE_DAYS = 30 // quiet for this long: drawn pale and slow
const MAX_GROUPS = 8 // one colour and species each
export const OTHERS = 'everyone else'
const PAGE = 100
const DAY = 86_400_000

interface Json { [key: string]: unknown }
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
// GitHub text is untrusted: one line, bounded, and only ever shown as text.
const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.split('\n')[0].slice(0, max).trim() : '')
const link = (v: unknown) => (typeof v === 'string' && v.startsWith('https://github.com/') ? v : '')
const days = (from: string, now: number) => {
  const at = Date.parse(from)
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / DAY)) : 0
}

type Raw = Omit<OpenPull, 'group' | 'ageDays' | 'quietDays'>

// Shared by every source: ages, author groups, and the notices that say what is and is not shown.
function assemble(
  repo: string, source: PullSet['source'], raw: Raw[], total: number, exactTotal: boolean, detailed: boolean, now: number,
): PullSet {
  const counts = new Map<string, number>()
  for (const p of raw) counts.set(p.author, (counts.get(p.author) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([author]) => author)
  const authors = ranked.length > MAX_GROUPS ? [...ranked.slice(0, MAX_GROUPS - 1), OTHERS] : ranked
  const pulls = raw.map((p) => ({
    ...p,
    group: Math.min(authors.length - 1, Math.max(0, ranked.indexOf(p.author))),
    ageDays: days(p.created, now),
    quietDays: days(p.updated, now),
  }))
  const notices: string[] = []
  if (source === 'synthetic') notices.push('Synthetic demo: these pull requests are fictional and were not read from GitHub.')
  if (total > pulls.length) {
    notices.push(`Only the ${pulls.length} most recently opened of ${exactTotal ? '' : 'about '}${total.toLocaleString('en-US')} open pull requests are drawn.`)
  }
  if (!detailed) {
    notices.push('Diff size, review decisions, and check results need a GitHub token, which only the local server can hold (GITHUB_TOKEN=... pnpm dev). Without it every fish is the same size, and those readings are missing, not passing.')
  }
  if (ranked.length > MAX_GROUPS) {
    notices.push(`Colour and species show the author for the ${MAX_GROUPS - 1} with the most open pull requests; the other ${ranked.length - MAX_GROUPS + 1} authors share one.`)
  }
  notices.push(`"Quiet" means nothing has happened on a pull request for ${STALE_DAYS} days, by GitHub's last-updated time. Merged and closed pull requests are not shown.`)
  notices.push('A pull request is not a living thing: this mapping is a design choice, and says nothing about the quality of the work or of its author.')
  return { repo, source, pulls, total, exactTotal, detailed, authors, notices, at: new Date(now).toISOString() }
}

// GitHub's REST list: one request, no token. `pages` is the last page number it named, or 0 when there is one page.
export function fromRest(repo: string, items: unknown, pages: number, now: number): PullSet {
  const raw = list(items).map((p): Raw => ({
    number: Number(p.number) || 0,
    title: text(p.title),
    url: link(p.html_url),
    author: text(obj(p.user).login, 40) || 'unknown',
    draft: p.draft === true,
    created: text(p.created_at, 32),
    updated: text(p.updated_at, 32),
    labels: list(p.labels).map((l) => text(l.name, 40)).filter(Boolean).slice(0, 5),
    waiting: list(p.requested_reviewers).length + list(p.requested_teams).length > 0,
    lines: null, review: null, checks: null,
  }))
  return assemble(repo, 'recorded', raw, pages > 1 ? pages * PAGE : raw.length, pages <= 1, false, now)
}

const REVIEWS: Record<string, Review> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }
const CHECKS: Record<string, Checks> = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' }

// GitHub's GraphQL answer, relayed by the local server: `{ totalCount, nodes }` of repository.pullRequests.
export function fromGraph(repo: string, data: unknown, now: number): PullSet {
  const raw = list(obj(data).nodes).map((p): Raw => {
    const commit = obj(list(obj(p.commits).nodes)[0]?.commit)
    const state = text(obj(commit.statusCheckRollup).state, 20)
    return {
      number: Number(p.number) || 0,
      title: text(p.title),
      url: link(p.url),
      author: text(obj(p.author).login, 40) || 'unknown',
      draft: p.isDraft === true,
      created: text(p.createdAt, 32),
      updated: text(p.updatedAt, 32),
      labels: list(obj(p.labels).nodes).map((l) => text(l.name, 40)).filter(Boolean).slice(0, 5),
      waiting: Number(obj(p.reviewRequests).totalCount) > 0,
      lines: Math.max(0, (Number(p.additions) || 0) + (Number(p.deletions) || 0)),
      review: REVIEWS[text(p.reviewDecision, 30)] ?? 'none',
      checks: CHECKS[state] ?? 'none',
    }
  })
  const total = Number(obj(data).totalCount)
  return assemble(repo, 'recorded', raw, Number.isFinite(total) ? Math.max(total, raw.length) : raw.length, true, true, now)
}

// The numbers the reading line and the water show.
export function tally(set: PullSet) {
  const of = (test: (p: OpenPull) => boolean) => set.pulls.filter(test).length
  return {
    drawn: set.pulls.length,
    quiet: of((p) => p.quietDays >= STALE_DAYS),
    drafts: of((p) => p.draft),
    waiting: of((p) => p.waiting),
    failing: of((p) => p.checks === 'failing'),
    approved: of((p) => p.review === 'approved'),
  }
}

// Body length, 0..1, from lines changed on a log scale: 10 lines is small, 5,000 is as large as a fish gets.
export const sizeOfDiff = (lines: number | null) =>
  lines === null ? 0.45 : Math.min(1, Math.log2(1 + lines) / Math.log2(5001))

// Reads one repository's open pull requests. The local server's endpoint is tried first, because it can hold a
// token and so read sizes, reviews, and checks; a static build, or a server without a token, falls back to one
// unauthenticated request to GitHub.
export async function fetchPulls(input: string, now = Date.now()): Promise<PullSet> {
  const repos = parseRepos(input)
  if (repos.length > 1) throw new Error('Enter one repository: this view shows the pull requests of a single project.')
  const repo = repos[0]
  const relayed = await fetch(`/api/github/open-pulls?repo=${encodeURIComponent(repo)}`)
    .then(async (r) => ({ status: r.status, body: await r.json() as unknown }))
    .catch(() => null) // no endpoint here, or it did not answer in JSON
  if (relayed?.status === 200) return fromGraph(repo, relayed.body, now)
  if (relayed?.status === 404 && obj(relayed.body).reason === 'not found') throw new Error('Repository not found, or it is private.')
  // No token on the server, or no server: read what GitHub gives anyone.
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${PAGE}&sort=created&direction=desc`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (res.status === 404) throw new Error('Repository not found, or it is private.')
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached (60 requests per hour without a token). Try again later.')
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`)
  const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(res.headers.get('link') ?? '')
  return fromRest(repo, await res.json(), last ? Number(last[1]) : 0, now)
}

// A fictional repository for the offline demo: a small team with a few stuck, failing, and approved pull requests.
export function demoPulls(now = Date.now()): PullSet {
  const ago = (d: number) => new Date(now - d * DAY).toISOString()
  const make = (
    number: number, author: string, title: string, opened: number, quiet: number, lines: number,
    review: Review, checks: Checks, extra: Partial<Raw> = {},
  ): Raw => ({
    number, title, author, url: '', draft: false, created: ago(opened), updated: ago(quiet), labels: [],
    waiting: review === 'review required', lines, review, checks, ...extra,
  })
  const raw = [
    make(214, 'mira', 'Cache coral growth between frames', 2, 0, 180, 'review required', 'passing'),
    make(213, 'mira', 'Fix pump timeout on cold start', 3, 1, 42, 'approved', 'passing', { labels: ['bug'] }),
    make(212, 'tomas', 'Rewrite the tide solver', 5, 0, 2400, 'changes requested', 'failing'),
    make(211, 'tomas', 'Tide solver: split the boundary cases', 6, 2, 610, 'review required', 'failing'),
    make(210, 'aiko', 'Document the heater wiring', 6, 5, 95, 'approved', 'passing', { labels: ['docs'] }),
    make(209, 'aiko', 'Add a feeding schedule editor', 8, 1, 870, 'review required', 'pending'),
    make(208, 'mira', 'Experiment: bioluminescent glow', 9, 3, 1300, 'none', 'passing', { draft: true, waiting: false }),
    make(207, 'dependabot', 'Bump filter-core from 2.3.1 to 2.4.0', 9, 9, 12, 'review required', 'passing', { labels: ['dependencies'] }),
    make(206, 'dependabot', 'Bump kelp-utils from 0.9.0 to 1.0.0', 12, 12, 30, 'review required', 'failing', { labels: ['dependencies'] }),
    make(205, 'tomas', 'Speed up the filter flow rate', 14, 4, 260, 'approved', 'passing'),
    make(204, 'jo', 'Refactor the tank layout', 16, 10, 1900, 'changes requested', 'passing'),
    make(203, 'jo', 'Add a kelp growth model', 21, 20, 740, 'review required', 'passing'),
    make(202, 'aiko', 'Heater threshold: use the calibrated curve', 25, 6, 150, 'review required', 'passing'),
    make(201, 'dependabot', 'Bump salinity-probe from 4.1.0 to 4.2.0', 31, 31, 8, 'review required', 'passing', { labels: ['dependencies'] }),
    make(198, 'sam', 'First attempt at a wave machine', 40, 38, 3100, 'review required', 'failing', { draft: true, waiting: false }),
    make(195, 'jo', 'Cleaner shrimp scheduling', 47, 33, 520, 'review required', 'pending'),
    make(190, 'sam', 'Port the lighting rig to the new driver', 64, 61, 1450, 'changes requested', 'failing'),
    make(183, 'mira', 'Old approach to coral caching', 88, 80, 990, 'none', 'failing', { waiting: false }),
    make(171, 'lee', 'Add a second return pump', 120, 115, 330, 'review required', 'none'),
    make(160, 'lee', 'Substrate vacuum prototype', 170, 160, 2100, 'none', 'none', { draft: true, waiting: false }),
  ]
  return assemble('synthetic/reef-demo', 'synthetic', raw, raw.length, true, true, now)
}

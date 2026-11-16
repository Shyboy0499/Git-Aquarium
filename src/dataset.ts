// Turns repository records into a frozen dataset for replay. Nothing here changes once a replay starts.
import type { EventKind, GitEvent } from './sim'

export interface Dataset {
  source: 'synthetic' | 'recorded'
  repo: string
  branches: string[] // observed snapshot; each becomes a lineage
  events: GitEvent[] // deduplicated, in replay order
  notices: string[] // data boundaries, truncation, and missing records, shown to the user
}

export type RawEvent = Omit<GitEvent, 'tick' | 'lineage'>

export const REPLAY_TICKS = 3600 // the imported window plays in three minutes at 1x
const WARMUP_TICKS = 100
export const MAX_LINEAGES = 8
const PAGE = 100 // records per request, GitHub's maximum
const DAY = 86_400_000
export const PERIODS = [7, 30, 90] // days of history an import can ask for
// The most requests one import may spend: half the unauthenticated hourly allowance, or a small part of a token's 5,000.
export const BUDGET = { open: 30, token: 300 }
const KINDS: EventKind[] = ['COMMIT_OBSERVED', 'PR_OPENED', 'PR_MERGED', 'CI_FAILED', 'CI_PASSED']

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0) // not localeCompare: must not vary by locale

export function freeze(
  source: Dataset['source'], repo: string, branches: string[], raw: RawEvent[], notices: string[] = [],
): Dataset {
  const seen = new Set<string>()
  const valid = raw
    .filter((e) => {
      const key = `${e.kind}:${e.id}` // one effect per unique commit SHA, PR, or workflow run
      if (!e.id || Number.isNaN(Date.parse(e.at)) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order(a.kind, b.kind) || order(a.id, b.id))
  const first = valid.length ? Date.parse(valid[0].at) : 0
  const span = valid.length ? Date.parse(valid[valid.length - 1].at) - first : 0
  if (branches.length > MAX_LINEAGES) {
    notices.push(`Showing the first ${MAX_LINEAGES} of ${branches.length} observed branches as lineages.`)
  }
  const lineages = branches.length ? branches.slice(0, MAX_LINEAGES) : ['unknown']
  const events = valid.map((e) => ({
    ...e,
    tick: WARMUP_TICKS + (span ? Math.floor(((Date.parse(e.at) - first) / span) * REPLAY_TICKS) : 0),
    // An event acts on the lineage of its own branch; a merge acts on the branch it merged into.
    lineage: lineages.indexOf(e.branches[e.kind === 'PR_MERGED' ? 1 : 0]),
  }))
  return { source, repo, branches: lineages, events, notices }
}

// GitHub responses are untrusted: read only the fields we need and check their types.
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const title = (v: unknown) => text(v).split('\n')[0].slice(0, 120)
const link = (v: unknown) => (typeof v === 'string' && v.startsWith('https://github.com/') ? v : null)
const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])

export interface GitHubData {
  repo: unknown // repository metadata, for the default branch
  branches: unknown
  pulls: unknown
  runs: unknown
  commits: Record<string, unknown> // one commit list per lineage branch
  since?: number // start of the requested period, in ms; records before it are outside the question
  cut?: Record<string, number> // sources that stopped early, with the time each one reached back to
  lineages?: string[] // the branches the commit lists were read for, when the caller has already picked them
}

// Which branches become lineages: the default branch, then those with the most pull request and CI activity.
export function pickLineages(api: Pick<GitHubData, 'repo' | 'branches' | 'pulls' | 'runs'>): string[] {
  const main = text((api.repo as any)?.default_branch)
  const names = list(api.branches).map((b) => text(b?.name)).filter((name) => name && name !== main)
  const activity = (name: string) =>
    list(api.pulls).filter((p) => p?.head?.ref === name || p?.base?.ref === name).length +
    list(api.runs).filter((r) => r?.head_branch === name).length
  const score = new Map(names.map((name) => [name, activity(name)]))
  names.sort((a, b) => score.get(b)! - score.get(a)!) // stable: ties keep GitHub's order
  return [...(main ? [main] : []), ...names].slice(0, MAX_LINEAGES)
}

export function fromGitHub(repo: string, api: GitHubData): Dataset {
  const lineages = api.lineages ?? pickLineages(api)
  const observed = list(api.branches).length
  const notices = [
    'Commits replay at their committer timestamp, a proxy rather than a verified push time.',
    'Branches are a current snapshot. A commit counts for the default branch if it is there, otherwise for the first lineage branch it was found on.',
  ]
  if (observed > lineages.length) {
    notices.push(`Showing ${lineages.length} of ${observed} branches as lineages: the default branch and those with the most pull request and CI activity.`)
  }

  // The default branch is read first, so shared history is credited to it and each other branch keeps only its own commits.
  const seen = new Set<string>()
  const commits: RawEvent[] = lineages.flatMap((branch) => list(api.commits[branch]).flatMap((c): RawEvent[] => {
    const sha = text(c?.sha)
    if (!sha || seen.has(sha)) return []
    seen.add(sha)
    return [{
      kind: 'COMMIT_OBSERVED', at: text(c?.commit?.committer?.date), id: sha,
      title: title(c?.commit?.message), url: link(c?.html_url), branches: [branch], group: '',
    }]
  }))

  // Events on a branch that is not a lineage have nobody to act on, so they are left out and counted.
  let elsewhere = 0
  const pulls: RawEvent[] = list(api.pulls).flatMap((p) => {
    const pr = {
      id: String(p?.number ?? ''), title: title(p?.title), url: link(p?.html_url),
      branches: [text(p?.head?.ref), text(p?.base?.ref)], group: '',
    }
    if (!lineages.includes(pr.branches[1])) { elsewhere++; return [] }
    const opened: RawEvent = { ...pr, kind: 'PR_OPENED', at: text(p?.created_at) }
    return p?.merged_at ? [opened, { ...pr, kind: 'PR_MERGED' as EventKind, at: text(p.merged_at) }] : [opened]
  })
  let ignored = 0
  const runs: RawEvent[] = list(api.runs).flatMap((r) => {
    const kind: EventKind | null =
      r?.conclusion === 'success' ? 'CI_PASSED'
      : r?.conclusion === 'failure' || r?.conclusion === 'timed_out' ? 'CI_FAILED'
      : null
    if (!kind) { ignored++; return [] }
    const branch = text(r?.head_branch)
    if (!lineages.includes(branch)) { elsewhere++; return [] }
    return [{
      kind, at: text(r?.updated_at), id: String(r?.id ?? ''), title: title(`${text(r?.name)}: ${r.conclusion}`),
      url: link(r?.html_url), branches: [branch], group: `${r?.workflow_id}@${branch}`,
    }]
  })
  if (api.runs === null) notices.push('GitHub Actions data was unavailable; CI effects are missing, not passing.')
  else if (!runs.length) notices.push('No supported GitHub Actions results on the lineage branches; CI effects are missing, not passing.')
  if (ignored) notices.push(`${ignored} workflow runs with other conclusions (cancelled, skipped, ...) were ignored.`)
  if (elsewhere) notices.push(`${elsewhere} pull requests and workflow runs were on branches that are not shown as lineages; they were left out.`)

  // A source that stopped early is incomplete before the time it reached, so the window starts where every source is complete.
  const since = api.since ?? -Infinity
  const cut = Object.entries(api.cut ?? {})
  const start = Math.max(since, ...cut.map(([, reached]) => reached))
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  if (cut.length) {
    notices.push(`Stopped early, so older records are missing: ${cut.map(([what, reached]) => `${what} (back to ${day(reached)})`).join(', ')}.`)
  }
  const asked = [...commits, ...pulls, ...runs].filter((e) => !(Date.parse(e.at) < since))
  const kept = asked.filter((e) => !(Date.parse(e.at) < start))
  if (kept.length < asked.length) {
    notices.push(`The replay window starts ${day(start)}; ${asked.length - kept.length} older records were left out because another source stopped early.`)
  }
  return freeze('recorded', repo, lineages, kept, notices)
}

// Reads one repository for a chosen period, page by page, until the period is covered or the request budget runs out.
// Requests go through the local server when it holds a token (vite.config.ts), otherwise straight to GitHub's public API.
// ponytail: each branch's commit list repeats the history it shares with the default branch; GitHub's compare
// endpoint would return only a branch's own commits if that waste starts to cost whole imports.
export async function importRepo(
  input: string, days = 30, now = Date.now(), progress: (requests: number) => void = () => {},
): Promise<Dataset> {
  const repo = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1]
  if (!repo) throw new Error('Enter a public repository as owner/repo or a github.com URL.')
  const since = now - days * DAY
  let direct = false, used = 0, left = BUDGET.open, hourly = 60
  const get = async (path: string) => {
    left--
    progress(++used)
    let res = direct ? null : await fetch(`/api/github/repos/${repo}${path}`).catch(() => null)
    if (!res?.headers.get('x-proxied')) { // no local server, or it holds no token
      direct = true
      res = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers: { Accept: 'application/vnd.github+json' } })
    }
    if (res.status === 404) throw new Error('Repository not found, or it is private.')
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      throw new Error(`GitHub rate limit reached${reset ? `; it resets at ${new Date(reset * 1000).toTimeString().slice(0, 5)}` : ''}. Try again later.`)
    }
    if (res.status === 401) throw new Error("GitHub rejected the local server's token.")
    if (!res.ok) throw new Error(`GitHub returned ${res.status}.`)
    if (used === 1) { // the first answer says how many requests this address or token is allowed
      hourly = Number(res.headers.get('x-ratelimit-limit')) || 60
      const remaining = res.headers.get('x-ratelimit-remaining')
      left = Math.min((hourly > 60 ? BUDGET.token : BUDGET.open) - 1, remaining === null ? Infinity : Number(remaining))
    }
    return res.json()
  }

  const iso = new Date(since).toISOString()
  const day = `${iso.slice(0, 19)}Z` // GitHub's search dates take whole seconds

  // One paged list. `date` is the field that says how far back a page reached.
  interface Source { what: string; path: string; date: (r: any) => unknown; rows: any[]; page: number; open: boolean; cut: boolean; failed: boolean }
  const source = (what: string, path: string, date: Source['date']): Source =>
    ({ what, path, date, rows: [], page: 1, open: true, cut: false, failed: false })
  const step = async (s: Source) => {
    if (left <= 0) { s.open = false; s.cut = true; return }
    if (s.page > 10 && s.what.startsWith('workflow runs')) {
      // GitHub answers a filtered run search with at most 1,000 results, so the search starts again from the oldest run it gave.
      s.path = s.path.replace(/created=[^&]+/, `created=${encodeURIComponent(`${day}..${text(s.rows[s.rows.length - 1]?.created_at)}`)}`)
      s.page = 1
    }
    const body = await get(`${s.path}&per_page=${PAGE}&page=${s.page++}`)
    const rows = list(body?.workflow_runs ?? body)
    s.rows.push(...rows)
    if (rows.length < PAGE || Date.parse(text(s.date(rows[rows.length - 1]))) < since) s.open = false
  }
  // Every open source gets its next page before any gets another, so one long list cannot starve the rest.
  const pump = async (sources: Source[]) => {
    while (sources.some((s) => s.open)) await Promise.all(sources.filter((s) => s.open).map(step))
  }
  const optional = (s: Source) => step(s).catch(() => { s.open = false; s.failed = true }) // Actions can be switched off

  const runsOn = (branch: string) =>
    `/actions/runs?status=completed&created=${encodeURIComponent(`>=${day}`)}${branch && `&branch=${encodeURIComponent(branch)}`}`
  const meta = await get('')
  // Sorted by last update: a pull request opened or merged in the period was also updated in it.
  const pulls = source('pull requests', '/pulls?state=all&sort=updated&direction=desc', (p) => p?.updated_at)
  const scout = source('workflow runs', runsOn(''), (r) => r?.updated_at)
  const [branches] = await Promise.all([get(`/branches?per_page=${PAGE}`), step(pulls), optional(scout)])
  const api = { repo: meta, branches, pulls: pulls.rows, runs: scout.rows }
  const lineages = pickLineages(api)
  const commits = lineages.map((b) => source(`commits on ${b}`, `/commits?sha=${encodeURIComponent(b)}&since=${iso}`, (c) => c?.commit?.committer?.date))
  // Runs anywhere else are dropped later, so a busy repository is asked for its lineage branches only.
  const runs = scout.open ? lineages.map((b) => source(`workflow runs on ${b}`, runsOn(b), (r) => r?.updated_at)) : [scout]
  await Promise.all([...commits.map(step), ...runs.filter((s) => s.open).map(optional)])
  await pump([pulls, ...commits, ...runs])

  // A source that was cut off before its first page reached back to now: nothing of it is known.
  const reached = (s: Source) => Math.min(now, ...s.rows.map((r) => Date.parse(text(s.date(r)))).filter(Number.isFinite))
  const dataset = fromGitHub(repo, {
    ...api, since, lineages,
    runs: runs.some((s) => s.failed) ? null : runs.flatMap((s) => s.rows),
    commits: Object.fromEntries(lineages.map((b, i) => [b, commits[i].rows])),
    cut: Object.fromEntries([pulls, ...commits, ...runs].filter((s) => s.cut).map((s) => [s.what, reached(s)])),
  })
  dataset.notices.push(
    `Asked for the last ${days} days, from ${iso.slice(0, 10)}. Read with ${used} GitHub requests; ` +
    `one import may use ${hourly > 60 ? BUDGET.token : BUDGET.open} of the ${hourly.toLocaleString('en')} an hour GitHub allows ${hourly > 60 ? 'this token' : 'without a token'}.`,
  )
  return dataset
}

// A frozen dataset as a file, so a replay can be handed to someone else and reproduced without importing again.
export const FORMAT = 'git-aquarium-dataset'
export const saveDataset = (dataset: Dataset, seed: number) => JSON.stringify({ format: FORMAT, version: 1, seed, dataset })

// A file is untrusted: every field is checked and copied, and the replay clock in it is kept exactly as written.
export function openDataset(json: string): { dataset: Dataset; seed: number } {
  let file: any
  try { file = JSON.parse(json) } catch { throw new Error('That file is not JSON.') }
  const d = file?.dataset
  if (file?.format !== FORMAT || file.version !== 1 || !d) throw new Error('That file is not a Git Aquarium dataset (version 1).')
  const branches = list(d.branches).map(text).filter(Boolean)
  if (!branches.length || branches.length > MAX_LINEAGES) throw new Error(`A dataset needs 1 to ${MAX_LINEAGES} branches.`)
  const raw = list(d.events)
  if (raw.length > 100_000) throw new Error('That dataset has more than 100,000 events.')
  let last = 0
  const events = raw.map((e, i): GitEvent => {
    const ok = KINDS.includes(e?.kind) && text(e.id) && Number.isFinite(Date.parse(text(e.at))) &&
      Number.isInteger(e.tick) && e.tick >= last && Number.isInteger(e.lineage) && e.lineage >= -1 && e.lineage < branches.length
    if (!ok) throw new Error(`Event ${i + 1} in that file is not valid, or is out of replay order.`)
    last = e.tick
    return {
      tick: e.tick, at: e.at, kind: e.kind, id: e.id, title: title(e.title), url: link(e.url),
      branches: list(e.branches).map(text), lineage: e.lineage, group: text(e.group),
    }
  })
  return {
    seed: Number.isInteger(file.seed) ? file.seed : 1,
    dataset: {
      source: d.source === 'recorded' ? 'recorded' : 'synthetic', repo: text(d.repo).slice(0, 140) || 'unnamed',
      branches, events, notices: list(d.notices).map(text).filter(Boolean).slice(0, 50),
    },
  }
}

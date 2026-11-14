// Turns repository records into a frozen dataset for replay. Nothing here changes once a replay starts.
import type { EventKind, GitEvent } from './sim'

export interface Dataset {
  source: 'synthetic' | 'recorded'
  repo: string
  branches: string[] // observed snapshot; each becomes a lineage
  events: GitEvent[] // deduplicated, in replay order
  notices: string[] // data boundaries, truncation, and missing records, shown to the user
}

export type RawEvent = Omit<GitEvent, 'tick'>

export const REPLAY_TICKS = 3600 // the imported window plays in three minutes at 1x
const WARMUP_TICKS = 100
const MAX_LINEAGES = 8
const PAGE = 100 // one page per source keeps an import to four requests

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
  const events = valid.map((e) => ({
    ...e,
    tick: WARMUP_TICKS + (span ? Math.floor(((Date.parse(e.at) - first) / span) * REPLAY_TICKS) : 0),
  }))
  if (branches.length > MAX_LINEAGES) {
    notices.push(`Showing the first ${MAX_LINEAGES} of ${branches.length} observed branches as lineages.`)
  }
  return { source, repo, branches: branches.length ? branches.slice(0, MAX_LINEAGES) : ['unknown'], events, notices }
}

// GitHub responses are untrusted: read only the fields we need and check their types.
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const title = (v: unknown) => text(v).split('\n')[0].slice(0, 120)
const link = (v: unknown) => (typeof v === 'string' && v.startsWith('https://github.com/') ? v : null)
const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])

export function fromGitHub(
  repo: string, api: { branches: unknown; commits: unknown; pulls: unknown; runs: unknown },
): Dataset {
  const notices = [
    'Commits replay at their committer timestamp, a proxy rather than a verified push time.',
    'Branches are a current snapshot; commits are not attributed to a branch.',
  ]
  const commits: RawEvent[] = list(api.commits).map((c) => ({
    kind: 'COMMIT_OBSERVED', at: text(c?.commit?.committer?.date), id: text(c?.sha),
    title: title(c?.commit?.message), url: link(c?.html_url), branches: [], group: '',
  }))
  const pulls: RawEvent[] = list(api.pulls).flatMap((p) => {
    const pr = {
      id: String(p?.number ?? ''), title: title(p?.title), url: link(p?.html_url),
      branches: [text(p?.head?.ref), text(p?.base?.ref)], group: '',
    }
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
    return [{
      kind, at: text(r?.updated_at), id: String(r?.id ?? ''), title: title(`${text(r?.name)}: ${r.conclusion}`),
      url: link(r?.html_url), branches: [branch], group: `${r?.workflow_id}@${branch}`,
    }]
  })
  if (api.runs === null) notices.push('GitHub Actions data was unavailable; CI effects are missing, not passing.')
  else if (!runs.length) notices.push('No supported GitHub Actions results found; CI effects are missing, not passing.')
  if (ignored) notices.push(`${ignored} workflow runs with other conclusions (cancelled, skipped, ...) were ignored.`)

  // A source that filled its page is truncated, so start the window where every source is complete.
  let start = -Infinity
  for (const [name, source, size] of [
    ['commits', commits, list(api.commits).length],
    ['pull requests', pulls, list(api.pulls).length],
    ['workflow runs', runs, list(api.runs).length],
  ] as const) {
    if (size < PAGE) continue
    notices.push(`Only the ${PAGE} most recent ${name} were imported; older ones are missing.`)
    start = Math.max(start, Math.min(...source.map((e) => Date.parse(e.at)).filter(Number.isFinite)))
  }
  const all = [...commits, ...pulls, ...runs]
  const kept = all.filter((e) => !(Date.parse(e.at) < start))
  if (kept.length < all.length) {
    notices.push(
      `The replay window starts ${new Date(start).toISOString().slice(0, 10)}; ` +
      `${all.length - kept.length} older records were left out because another source was truncated.`,
    )
  }
  return freeze('recorded', repo, list(api.branches).map((b) => text(b?.name)).filter(Boolean), kept, notices)
}

// Reads one public repository straight from the browser: GitHub's REST API allows it, so no server or token is needed.
// ponytail: unauthenticated = 60 requests/hour per IP (15 imports); add a token-holding server if that is too few.
export async function importRepo(input: string): Promise<Dataset> {
  const repo = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1]
  if (!repo) throw new Error('Enter a public repository as owner/repo or a github.com URL.')
  const get = async (path: string) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (res.status === 404) throw new Error('Repository not found, or it is private.')
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub rate limit reached (60 unauthenticated requests per hour). Try again later.')
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}.`)
    return res.json()
  }
  const [branches, commits, pulls, runs] = await Promise.all([
    get(`branches?per_page=${PAGE}`),
    get(`commits?per_page=${PAGE}`),
    get(`pulls?state=all&per_page=${PAGE}`),
    get(`actions/runs?status=completed&per_page=${PAGE}`).then((r) => r?.workflow_runs ?? [], () => null),
  ])
  return fromGitHub(repo, { branches, commits, pulls, runs })
}

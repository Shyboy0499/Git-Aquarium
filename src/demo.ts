// Fictional repository history for the offline demo. Nothing here was imported from GitHub.
import { freeze, type Dataset, type RawEvent } from './dataset'
import type { EventKind } from './sim'

const DAY = 86_400_000
const START = Date.UTC(2026, 0, 5)
const WORK = [
  'Add kelp growth model', 'Tune filter flow rate', 'Refactor tank layout', 'Fix heater threshold',
  'Add coral cache', 'Update feeding schedule', 'Document pump wiring', 'Speed up tide solver',
]
const raw: RawEvent[] = []

function add(day: number, kind: EventKind, title: string, branches: string[] = [], group = '', id = `demo-${raw.length}`) {
  raw.push({ kind, at: new Date(START + day * DAY).toISOString(), id, title, url: null, branches, group })
}
function commits(from: number, to: number, perDay: number) {
  for (let day = from; day < to; day += 1 / perDay) add(day, 'COMMIT_OBSERVED', WORK[raw.length % WORK.length])
}
function ci(day: number, pass: boolean, workflow: string, branch: string) {
  add(day, pass ? 'CI_PASSED' : 'CI_FAILED', `${workflow} on ${branch}: ${pass ? 'success' : 'failure'}`,
    [branch], `${workflow}@${branch}`)
}
function pr(day: number, kind: 'PR_OPENED' | 'PR_MERGED', n: number, title: string, head: string) {
  add(day, kind, title, [head, 'main'], '', String(n))
}

// Act 1: steady work, the tank grows.
commits(0, 9, 2)
pr(3, 'PR_OPENED', 1, 'Add coral cache', 'feature/coral-cache')
ci(5, true, 'build', 'main')
// Act 2: three workflows break, work slows, the water turns.
ci(9, false, 'build', 'feature/coral-cache')
ci(10, false, 'test', 'main')
ci(11, false, 'lint', 'fix/pump-timeout')
commits(10, 16, 0.4)
// Act 3: each group recovers on its own, then merges land and activity returns.
ci(16, true, 'test', 'main')
ci(17, true, 'build', 'feature/coral-cache')
ci(18, true, 'lint', 'fix/pump-timeout')
pr(19, 'PR_MERGED', 1, 'Add coral cache', 'feature/coral-cache')
commits(19, 30, 3)
pr(20, 'PR_OPENED', 2, 'Fix pump timeout', 'fix/pump-timeout')
pr(23, 'PR_MERGED', 2, 'Fix pump timeout', 'fix/pump-timeout')
pr(26, 'PR_OPENED', 3, 'Experiment: bioluminescent glow', 'experiment/glow')

export const demo: Dataset = freeze(
  'synthetic', 'synthetic/reef-demo',
  ['main', 'feature/coral-cache', 'fix/pump-timeout', 'experiment/glow'],
  raw,
  ['Synthetic demo: every event here is fictional and was not imported from GitHub.'],
)

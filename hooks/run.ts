import type { Decision, Finding, Run, StepName, StepState, Verdict } from '../types'

export const PLUGIN = 'no-mistakes'
export const PANE = 'no-mistakes'
export const MAX_FIX_ROUNDS = 3
export const CI_POLL_MS = 30_000
export const CI_TIMEOUT_MS = 30 * 60_000
export const CI_GRACE_MS = 2 * 60_000
export const CI_QUIET_MS = 5 * 60_000
export const AGENT_TIMEOUT_MS = 30 * 60_000

// Every agent id a run has recorded, mirrored for the guard's failure path
// (when the state read itself throws); the state is the source.
export const knownAgents = new Set<string>()

export const STEP_ORDER: readonly StepName[] = [
  'rebase',
  'review',
  'test',
  'document',
  'lint',
  'recheck',
  'push',
  'pr',
  'ci',
]

export type RunSeed = Pick<Run, 'id' | 'repo' | 'branch' | 'base' | 'worktree' | 'gitFile' | 'commonDir' | 'intent' | 'localHead'>

export function newRun(seed: RunSeed): Run {
  const steps = {} as Record<StepName, StepState>
  for (const name of STEP_ORDER) steps[name] = { status: 'pending' }
  return { ...seed, head: seed.localHead, remoteHead: '', commands: {}, exclude: [], autofix: false, document: true, agents: [], steps, decisions: [] }
}

const LEGACY_RECHECK: StepState = { status: 'skipped', reason: 'run started before the recheck step existed' }

export function fromStore(run: Run): Run {
  if (run.exclude !== undefined && run.autofix !== undefined && run.document !== undefined && run.steps.recheck !== undefined) return run
  return { ...run, exclude: run.exclude ?? [], autofix: run.autofix ?? false, document: run.document ?? true, steps: { ...run.steps, recheck: run.steps.recheck ?? LEGACY_RECHECK } }
}

const SETTLED = new Set<StepState['status']>(['passed', 'skipped'])

export function currentStep(run: Run): StepName | undefined {
  return STEP_ORDER.find(name => !SETTLED.has(run.steps[name].status))
}

export function setStep(run: Run, name: StepName, state: StepState): Run {
  return { ...run, steps: { ...run.steps, [name]: state } }
}

export function skipRest(run: Run, from: StepName, reason: string): Run {
  let next = run
  for (const name of STEP_ORDER.slice(STEP_ORDER.indexOf(from) + 1)) {
    next = setStep(next, name, { status: 'skipped', reason })
  }
  return next
}

export function decide(run: Run, decision: Decision): Run {
  return { ...run, decisions: [...run.decisions, decision] }
}

export function approvedOrSkipped(run: Run, step: StepName): boolean {
  return run.decisions.some(d => d.step === step && d.verdict !== 'fix')
}

export function fixRounds(run: Run, step: StepName): number {
  return run.decisions.filter(d => d.step === step && d.verdict === 'fix').length
}

export function isAutoRound(run: Run, step: StepName): boolean {
  return run.decisions.findLast(d => d.step === step && d.verdict === 'fix')?.isAuto === true
}

export function autoFixable(run: Run, step: StepName, findings: Finding[]): Finding[] | undefined {
  if (!run.autofix || fixRounds(run, step) >= MAX_FIX_ROUNDS) return undefined
  const blocking = findings.filter(isBlocking)
  return blocking.length > 0 && blocking.every(f => f.action === 'auto-fix') ? blocking : undefined
}

export function agentOf(state: StepState): string | undefined {
  return state.status === 'running' || state.status === 'fixing' ? state.agentId : undefined
}

export function isRetired(run: Run, agentId: string): boolean {
  return run.outcome !== undefined || (run.retired?.includes(agentId) ?? false)
}

export function isClaimed(state: StepState): boolean {
  return state.status === 'starting' || (state.status === 'fixing' && state.agentId === undefined)
}

export function claimedAt(state: StepState): number | undefined {
  return isClaimed(state) && 'startedAt' in state ? state.startedAt : undefined
}

export function isAgentDriven(state: StepState): state is Extract<StepState, { status: 'running' | 'fixing' }> & { agentId: string } {
  return (state.status === 'running' || state.status === 'fixing') && state.agentId !== undefined
}

export function timeoutFinding(step: StepName): Finding {
  return { id: `${step}:timeout`, severity: 'warning', action: 'ask-user', description: `the ${step} agent has run for 30 minutes without answering; fix again, approve, skip or abort` }
}

export function isBlocking(f: Finding): boolean {
  return f.severity !== 'info' || f.action === 'ask-user'
}

export function gate(findings: Finding[], note?: string): StepState {
  return findings.some(isBlocking) ? { status: 'parked', findings } : { status: 'passed', note, findings }
}

const SEVERITIES: ReadonlySet<string> = new Set(['error', 'warning', 'info'])
const ACTIONS: ReadonlySet<string> = new Set(['auto-fix', 'ask-user', 'no-op'])

// A finding id reaches every later prompt as a fact of a human decision, so
// the agent may choose only a short slug: anything else is replaced.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'check'
}

export type Parsed = { findings: Finding[] } | { error: string }

// The JSON object starting at `start`, through its matching brace.
function objectAt(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}

// An agent that drops the fence still ends with the object (`Findings JSON:`
// then a bare `{"findings":[...]}`). Only the last start, only when the answer
// ends with it, and only when the agent itself introduced it with the
// `Findings JSON:` label on the line before: an object that ends the answer
// after prose is as likely to be quoted branch text (a fixture, a planted empty
// list) as the verdict, and falling back to it could pass a review.
const BARE_LABEL = /(^|\n)[ \t]*Findings JSON:[ \t]*\n[ \t]*$/

function bareFindings(answer: string): unknown {
  const start = [...answer.matchAll(/\{\s*"findings"\s*:/g)].map(m => m.index).pop()
  if (start === undefined) return undefined
  if (!BARE_LABEL.test(answer.slice(0, start))) return undefined
  const text = objectAt(answer, start)
  if (text === undefined || answer.slice(start + text.length).trim() !== '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseFindings(answer: string, step: StepName): Parsed {
  const blocks = [...answer.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)]
  const last = blocks[blocks.length - 1]?.[1]
  let raw: unknown
  if (last === undefined) {
    raw = bareFindings(answer)
    if (raw === undefined) return { error: 'the answer has no ```json block and no {"findings": ...} object' }
  } else {
    try {
      raw = JSON.parse(last)
    } catch (e) {
      return { error: `the json block does not parse: ${String(e)}` }
    }
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { findings?: unknown }).findings)) {
    return { error: 'the json block has no "findings" array' }
  }
  const findings: Finding[] = []
  for (const [i, item] of (raw as { findings: unknown[] }).findings.entries()) {
    if (typeof item !== 'object' || item === null) return { error: `finding ${i} is not an object` }
    const f = item as Record<string, unknown>
    if (typeof f.description !== 'string' || f.description === '') return { error: `finding ${i} has no description` }
    if (typeof f.severity !== 'string' || !SEVERITIES.has(f.severity)) return { error: `finding ${i} has no valid severity` }
    const action = typeof f.action === 'string' && ACTIONS.has(f.action) ? f.action : 'ask-user'
    // Every id is unique within the answer, a fallback included: a fallback
    // takes the first number from its position on that no earlier finding holds.
    const taken = (candidate: string) => findings.some(g => g.id === candidate)
    let id = typeof f.id === 'string' && ID.test(f.id) && !taken(f.id) ? f.id : ''
    if (id === '') {
      let n = i + 1
      while (taken(`${step}-${n}`)) n++
      id = `${step}-${n}`
    }
    findings.push({
      id,
      severity: f.severity as Finding['severity'],
      action: action as Finding['action'],
      ...(typeof f.file === 'string' ? { file: f.file } : {}),
      ...(typeof f.line === 'number' ? { line: f.line } : {}),
      description: f.description,
    })
  }
  return { findings }
}

export function statusText(run: Run | null): string | undefined {
  if (!run) return undefined
  if (run.outcome) return `${PLUGIN}: ${run.outcome}`
  const name = currentStep(run)
  if (!name) return `${PLUGIN}: finishing`
  const state = run.steps[name]
  if (state.status === 'parked') return `${PLUGIN}: parked at ${name}`
  if (state.status === 'fixing') return `${PLUGIN}: ${isAutoRound(run, name) ? 'auto-fixing' : 'fixing'} ${name} (round ${state.round})`
  return `${PLUGIN}: ${name}…`
}

export function commitLines(commits: string): string[] {
  return commits.split('\n').filter(line => /^[0-9a-f]{7,} /.test(line))
}

export function report(run: Run): string {
  const followUps = (run.followUps ?? []).map(f => (f.command === undefined ? f.text : `${f.text} ${f.command}`))
  return [run.note ?? '', ...followUps].filter(part => part !== '').join('. ')
}

export function describeVerdict(verdict: Verdict): string {
  return verdict === 'fix' ? 'chose to fix' : verdict === 'approve' ? 'approved as is' : 'skipped the step'
}

import type { Decision, Finding, Run, StepName, StepState } from '../types'
import * as git from './git'
import { io } from './io'
import { ciFixPrompt, commandPrompt, documentPrompt, FIXER_SYSTEM, prBodyPrompt, recheckPrompt, reviewPrompt, REVIEWER_SYSTEM } from './prompts'
import type { PriorApproval } from './run'
import { approvedOrSkipped, CI_GRACE_MS, CI_QUIET_MS, CI_TIMEOUT_MS, commitLines, fixRounds, gate, knownAgents, MAX_FIX_ROUNDS, parseFindings, PLUGIN, priorApprovals, slug } from './run'

export const REVIEWER = `${PLUGIN}:reviewer`
export const FIXER = `${PLUGIN}:fixer`

// dontAsk refuses at once what the mod's tool.check does not allow, instead of
// holding the pipeline on a dialog nobody answers.
export const AGENT_SPECS = [
  {
    name: 'reviewer',
    description: 'Read-only adversarial reviewer the no-mistakes pipeline spawns. Not for direct use.',
    prompt: REVIEWER_SYSTEM,
    tools: ['Read', 'Grep', 'Glob'],
    permissionMode: 'dontAsk',
    omitClaudeMd: true,
  },
  {
    name: 'fixer',
    description: 'Fixer the no-mistakes pipeline spawns inside its disposable worktree. Not for direct use.',
    prompt: FIXER_SYSTEM,
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    permissionMode: 'dontAsk',
  },
] as const

export type StepOutcome = { step: StepState; patch?: Partial<Run>; decision?: Decision; skipRest?: string; reopen?: readonly StepName[] }

export type StepDef = {
  name: StepName
  agent?: typeof REVIEWER | typeof FIXER
  start: (run: Run) => Promise<StepOutcome>
  check: (run: Run, answer: string) => Promise<StepOutcome>
  reopens?: readonly StepName[]
}

export const fixed = (run: Run, name: StepName): StepOutcome => ({ step: { status: 'pending' }, reopen: (STEP_DEFS[name].reopens ?? []).filter(step => !approvedOrSkipped(run, step)) })

export function commitMessage(name: StepName, state: StepState): string {
  if (state.status === 'fixing') return `fix(no-mistakes/${name}): fix round ${state.round}`
  if (name === 'document') return 'docs(no-mistakes): update documentation for the change'
  return `fix(no-mistakes/${name}): make the ${name} check pass`
}

export async function spawn(run: Run, type: string, prompt: string, label: string): Promise<{ agentId: string } | { error: string }> {
  const description = `no-mistakes ${label} (${run.id}/${run.decisions.length})`
  const r = await io().spawn({ prompt, subagentType: type, cwd: run.worktree, description })
  if (r.deny !== undefined) return { error: r.deny }
  // Only core stamps agentId. When a hook above answered the spawn itself, the agent list is the one place the started agent's id can still be read.
  const agentId = r.agentId ?? (await io().agents()).findLast(a => a.description === description)?.id
  if (agentId === undefined) return { error: 'the agent started without an id' }
  knownAgents.add(agentId)
  await io().writeRun(r => (r && !r.agents.includes(agentId) ? { ...r, agents: [...r.agents, agentId] } : r))
  return { agentId }
}

async function running(run: Run, type: string, prompt: string, description: string, patch?: Partial<Run>): Promise<StepOutcome> {
  const startedAt = await io().now()
  const started = await spawn(run, type, prompt, description)
  if ('error' in started) return { step: { status: 'failed', reason: `could not start ${type}: ${started.error}` }, ...(patch ? { patch } : {}) }
  return { step: { status: 'running', agentId: started.agentId, startedAt }, ...(patch ? { patch } : {}) }
}

// A code block no backtick run in the text (a file name the branch chose) can close.
const fenced = (text: string) => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)))
  return `${fence}\n${text}\n${fence}`
}

const failed = (reason: string): StepOutcome => ({ step: { status: 'failed', reason } })

type ParsedAnswer = { findings: Finding[] } | { outcome: StepOutcome }

function answerOf(name: StepName, answer: string): ParsedAnswer {
  const parsed = parseFindings(answer, name)
  return 'error' in parsed ? { outcome: failed(`${name} answer is unreadable (${parsed.error}); fail closed`) } : parsed
}

const notAgentDriven = (name: StepName) => async (): Promise<StepOutcome> => failed(`${name} takes no agent answer`)

const skipped = (reason: string): StepOutcome => ({ step: { status: 'skipped', reason } })

const gateAnswer = (name: StepName) => async (_run: Run, answer: string): Promise<StepOutcome> => {
  const parsed = answerOf(name, answer)
  return 'outcome' in parsed ? parsed.outcome : { step: gate(parsed.findings) }
}

const rebase: StepDef = {
  name: 'rebase',
  async start(run) {
    const r = await git.rebase(run)
    if (r.kind === 'conflict') return failed(`rebase onto origin/${run.base} conflicts; resolve it on your branch and run again:\n${r.detail}`)
    if (r.kind === 'behind') {
      const reason =
        r.how === 'pull'
          ? `origin/${run.branch} has commits your branch lacks (${r.remoteHead.slice(0, 12)}); run git pull --rebase origin ${run.branch}, then run again`
          : `your local ${run.branch} rewrote commits that origin/${run.branch} still has (${r.remoteHead.slice(0, 12)}); push your rewrite first with git push --force-with-lease origin ${run.branch}, then run again`
      return failed(reason)
    }
    if (r.kind === 'error') return failed(r.detail)
    const patch = { head: r.head, remoteHead: r.remoteHead, ...r.config }
    if (r.isEmpty) return { step: { status: 'passed', note: 'no diff against the base', findings: [] }, patch, skipRest: `no diff against origin/${run.base}` }
    return { step: { status: 'passed', note: `rebased onto origin/${run.base}`, findings: [] }, patch }
  },
  check: notAgentDriven('rebase'),
}

async function priorApprovalsOrNone(run: Run): Promise<PriorApproval[]> {
  if (run.recordDir === undefined) return []
  const path = `${run.recordDir}/history.jsonl`
  try {
    return (await io().exists(path)) ? priorApprovals((await io().read(path)).split('\n'), run) : []
  } catch {
    return []
  }
}

const review: StepDef = {
  name: 'review',
  agent: REVIEWER,
  async start(run) {
    const reviewedHead = await git.headOf(run)
    if (reviewedHead === undefined) return failed('cannot read the worktree HEAD')
    const diff = await git.reviewDiff(run)
    if (!diff.ok) return failed(`cannot read the change to review; fail closed: ${diff.reason}`)
    return running(run, REVIEWER, reviewPrompt(run, diff.text, await priorApprovalsOrNone(run)), 'review', { reviewedHead })
  },
  check: gateAnswer('review'),
}

const document: StepDef = {
  name: 'document',
  agent: FIXER,
  async start(run) {
    if (!run.document) return skipped('document: false in .no-mistakes.yaml')
    return running(run, FIXER, documentPrompt(run, await git.diffStat(run)), 'document')
  },
  check: gateAnswer('document'),
}

const recheck: StepDef = {
  name: 'recheck',
  agent: REVIEWER,
  async start(run) {
    const from = run.reviewedHead ?? run.head
    const head = await git.headOf(run)
    if (head === undefined) return failed('cannot read the worktree HEAD')
    if (head === from) return skipped('no commits since the review')
    const commits = await git.pipelineCommits(run, from)
    if (!commits.ok) return failed(`cannot list the pipeline's commits to recheck; fail closed: ${commits.reason}`)
    const diff = await git.reviewDiff(run, from)
    if (!diff.ok) return failed(`cannot read the pipeline's commits to recheck; fail closed: ${diff.reason}`)
    return running(run, REVIEWER, recheckPrompt(run, from, commitLines(commits.text).join('\n'), diff.text, await priorApprovalsOrNone(run)), 'recheck')
  },
  check: gateAnswer('recheck'),
  reopens: ['test', 'lint'],
}

const commandStep = (name: 'test' | 'lint'): StepDef => ({
  name,
  agent: FIXER,
  async start(run) {
    const command = run.commands[name]
    if (command === undefined) {
      const finding: Finding = { id: `${name}:no-command`, severity: 'warning', action: 'ask-user', description: `no ${name} command configured, so no ${name} ran: set commands.${name} in .no-mistakes.yaml on origin/${run.base}; approve to continue without one` }
      return { step: { status: 'parked', findings: [finding] } }
    }
    const prepared = await git.prepare(run)
    if (!prepared.ok) return failed(`${name}: ${prepared.reason}`)
    const patch: Partial<Run> = { prepared: true }
    const ran = await git.runCommand(run, command)
    if (ran.exitCode === 0) return { step: { status: 'passed', note: `${command} exited 0`, findings: [] }, patch }
    return running(run, FIXER, commandPrompt(run, name, command, ran.output, await git.diffStat(run)), name, patch)
  },
  async check(run, answer) {
    const parsed = answerOf(name, answer)
    if ('outcome' in parsed) return parsed.outcome
    const command = run.commands[name]
    if (command === undefined) return failed(`${name}: the configured command disappeared mid-step`)
    const ran = await git.runCommand(run, command)
    const findings = ran.exitCode === 0 ? parsed.findings : [...parsed.findings, { id: `${name}:command`, severity: 'error' as const, action: 'auto-fix' as const, description: `${command} still exits ${ran.exitCode} after the fix round:\n${ran.output.slice(-2000)}` }]
    return { step: gate(findings, `${command} exited 0`) }
  },
})

const push: StepDef = {
  name: 'push',
  async start(run) {
    let patch: Partial<Run> | undefined
    const format = run.commands.format
    if (format !== undefined) {
      const prepared = await git.prepare(run)
      if (!prepared.ok) return failed(`format: ${prepared.reason}`)
      patch = { prepared: true }
      const ran = await git.runCommand(run, format)
      if (ran.exitCode !== 0) return { ...failed(`format command "${format}" exited ${ran.exitCode}:\n${ran.output.slice(-2000)}`), patch }
      const committed = await git.commitAll(run, 'style(no-mistakes): format')
      if (committed.kind === 'error') return { ...failed(`format: ${committed.detail}`), patch }
    }
    const listed = await git.pipelineCommits(run)
    const commits = listed.ok ? listed.text : ''
    const r = await git.push(run)
    if (!r.ok) return { ...failed(`push refused (lease on ${run.remoteHead || 'a new branch'}): ${r.reason}`), patch: { ...patch, commits } }
    const count = commitLines(commits).length
    return { step: { status: 'passed', note: `pushed ${r.head.slice(0, 12)} to origin/${run.branch} with ${count} pipeline commit(s)`, findings: [] }, patch: { ...patch, commits, head: r.head, remoteHead: r.head } }
  },
  check: notAgentDriven('push'),
}

const pr: StepDef = {
  name: 'pr',
  async start(run) {
    const notReady = await git.ghReady(run.repo)
    if (notReady) return { step: { status: 'skipped', reason: notReady } }
    const target = await git.ghRepo(run)
    if ('error' in target) return { step: { status: 'skipped', reason: target.error } }
    const existing = await git.prView(run)
    if (existing) return { step: { status: 'passed', note: `existing PR ${existing.url}`, findings: [] }, patch: { prUrl: existing.url, prNumber: existing.number } }
    const stat = await git.diffStat(run)
    const body = await io().complete({ model: 'sonnet', prompt: prBodyPrompt(run, stat), maxTokens: 2000 })
    const text = `${body.isAnswered ? body.text : `${run.intent}\n\n${fenced(stat)}`}${run.commits ? `\n\n## Commits no-mistakes added\n\n${fenced(run.commits)}` : ''}`
    const title = (run.intent.split('\n')[0] ?? run.branch).slice(0, 70)
    const created = await git.prCreate(run, title, text)
    if ('error' in created) return failed(`gh pr create failed: ${created.error}`)
    return { step: { status: 'passed', note: created.url, findings: [] }, patch: { prUrl: created.url, prNumber: created.number } }
  },
  check: notAgentDriven('pr'),
}

const ci: StepDef = {
  name: 'ci',
  async start(run) {
    if (run.prNumber === undefined) return { step: { status: 'skipped', reason: 'no pull request to watch' } }
    const head = await git.headOf(run)
    if (head === undefined) return failed('cannot read the worktree HEAD')
    let patch: Partial<Run> | undefined
    if (head !== run.remoteHead) {
      const pushed = await git.push(run)
      if (!pushed.ok) return failed(`push of the CI fix refused: ${pushed.reason}`)
      patch = { head: pushed.head, remoteHead: pushed.head }
    }
    return { step: { status: 'running', startedAt: await io().now() }, ...(patch ? { patch } : {}) }
  },
  check: notAgentDriven('ci'),
}

// Must move ci from running to a fixing placeholder atomically: a second poll that overlaps the slow log fetch and spawn must find the claim.
export type ClaimFix = (findings: Finding[], round: number) => Promise<Run | undefined>

export type Polled = { outcome: StepOutcome; isClaimed: boolean }

const polled = (outcome: StepOutcome): Polled => ({ outcome, isClaimed: false })

export async function pollCi(run: Run, claimFix: ClaimFix): Promise<Polled | undefined> {
  const state = run.steps.ci
  if (state.status !== 'running' || run.prNumber === undefined) return undefined
  const pending: StepOutcome = { step: { status: 'parked', findings: [{ id: 'ci:timeout', severity: 'warning', action: 'ask-user', description: `CI still pending after 30 minutes on ${run.remoteHead.slice(0, 12)}` }] } }
  const waited = (await io().now()) - state.startedAt
  const timedOut = waited > CI_TIMEOUT_MS
  const prHead = await git.prHead(run, run.prNumber)
  if (prHead !== run.remoteHead) return timedOut ? polled(pending) : undefined
  const listed = await git.prChecks(run, run.prNumber)
  if ('error' in listed) return polled(failed(listed.error))
  // A skipped check reports nothing about the change.
  const checks = listed.filter(c => c.bucket !== 'skipping')
  const failing = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').map(c => c.name)
  if (failing.length > 0) {
    const round = fixRounds(run, 'ci') + 1
    const issued: string[] = []
    const findings: Finding[] = failing.map(name => {
      const base = `ci:${slug(name)}`
      let id = base
      for (let n = 2; issued.includes(id); n++) id = `${base}-${n}`
      issued.push(id)
      return { id, severity: 'error', action: 'auto-fix', description: `CI check "${name}" failed` }
    })
    if (round > MAX_FIX_ROUNDS) return polled({ step: { status: 'parked', findings } })
    const claimed = await claimFix(findings, round)
    if (!claimed) return undefined
    const startedAt = claimed.steps.ci.status === 'fixing' ? claimed.steps.ci.startedAt : await io().now()
    let step: StepState
    try {
      const log = await git.failedLog(claimed)
      const started = await spawn(claimed, FIXER, ciFixPrompt(claimed, failing, log, await git.diffStat(claimed)), `ci fix ${round}`)
      step = 'error' in started ? { status: 'failed', reason: `could not start the CI fixer: ${started.error}` } : { status: 'fixing', agentId: started.agentId, round, startedAt }
    } catch (e) {
      step = { status: 'failed', reason: `could not start the CI fixer: ${String(e)}` }
    }
    return { outcome: { step }, isClaimed: true }
  }
  const unfinished = checks.filter(c => c.bucket === 'pending')
  if (checks.length > 0 && unfinished.length === 0) return polled({ step: { status: 'passed', note: `${checks.length} check(s) passed`, findings: [] } })
  if (checks.length === 0 && waited > CI_GRACE_MS) {
    if ((await git.workflowCount(run)) === 0) {
      return polled({ step: { status: 'skipped', reason: `no CI: the repository defines no Actions workflow and no check reported within ${Math.round(CI_GRACE_MS / 60_000)} minutes` } })
    }
    if (waited > CI_QUIET_MS) {
      const skipped = listed.length > 0 ? ` (${listed.length} skipped)` : ''
      const finding: Finding = { id: 'ci:no-checks', severity: 'warning', action: 'ask-user', description: `no CI check ran on ${run.remoteHead.slice(0, 12)} within ${Math.round(CI_QUIET_MS / 60_000)} minutes${skipped}: the workflows may not run on pull requests, or path filters skipped them. Approve to continue without CI` }
      return polled({ step: { status: 'parked', findings: [finding] } })
    }
  }
  return timedOut ? polled(pending) : undefined
}

export const STEPS: readonly StepDef[] = [rebase, review, commandStep('test'), document, commandStep('lint'), recheck, push, pr, ci]

export const STEP_DEFS: Record<StepName, StepDef> = Object.fromEntries(STEPS.map(s => [s.name, s])) as Record<StepName, StepDef>

import type { Outcome, Run, StepName, StepState, Verdict } from '../types'
import * as git from './git'
import { io } from './io'
import { fixPrompt, reaskPrompt, UNTRUSTED_NOTE, untrusted } from './prompts'
import { AGENT_TIMEOUT_MS, agentOf, CI_POLL_MS, claimedAt, currentStep, decide, fixRounds, isAgentDriven, isClaimed, isRetired, knownAgents, MAX_FIX_ROUNDS, newRun, parseFindings, PLUGIN, setStep, skipRest, statusText, timeoutFinding } from './run'
import { AGENT_STEPS, commitMessage, FIXER, pollCi, spawn, STEP_DEFS } from './steps'
import type { StepOutcome } from './steps'

let pollTimer: { cancel: () => void } | undefined

// Answers that arrive before their agent's id is written to the run.
const early = new Map<string, { answer: string; reason: string }>()
const EARLY_MAX = 8

async function showStatus(): Promise<void> {
  io().status(statusText(await io().readRun()))
}

export type Owned = 'ours' | 'not-ours' | 'unknown'

// Whether an agent is one this run spawned. A recorded agent stays ours after
// the run ends (it may still be running). The agent list is consulted only
// while a step that spawns is claimed and its agent's id is not yet recorded;
// a lookup that throws then is `unknown`.
export async function ownerOf(run: Run | null, agentId: string): Promise<Owned> {
  if (!run) return 'not-ours'
  if (run.agents.includes(agentId)) return 'ours'
  if (run.outcome) return 'not-ours'
  const name = currentStep(run)
  if (name === undefined) return 'not-ours'
  const state = run.steps[name]
  if (!isClaimed(state) || !(state.status === 'fixing' || AGENT_STEPS.has(name))) return 'not-ours'
  try {
    return (await io().agents()).some(a => a.id === agentId && a.spawnedBy === PLUGIN) ? 'ours' : 'not-ours'
  } catch {
    return 'unknown'
  }
}

export async function startRun(args: string): Promise<string> {
  const active = await io().readRun()
  if (active && !active.outcome) {
    await io().openPane()
    return `A run is already active on ${active.branch} (${statusText(active)}). Finish or abort it from the pane first.`
  }
  if (active) {
    const live = await stillRunning(active)
    if (live.length > 0) return `no-mistakes cannot start: agent(s) of the previous run are still running (${live.join(', ')}); stop them first.`
  }
  const inspected = await git.inspectRepo(await io().cwd())
  if (!inspected.ok) return `no-mistakes cannot start: ${inspected.reason}`
  const { facts } = inspected
  let intent = args.trim()
  if (intent === '') {
    const forked = await io().fork(
      'In two to five sentences, state what the user set out to accomplish in this session and the acceptance criteria that follow from it. Output the statement only.',
    )
    if (!forked.isAnswered) {
      return forked.reason === 'nothing-to-fork'
        ? 'no-mistakes cannot derive the intent from an empty session. Say it: /no-mistakes <what this branch is for>.'
        : `no-mistakes could not derive the intent (${forked.reason}). Say it: /no-mistakes <what this branch is for>.`
    }
    intent = forked.text.trim()
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${facts.head.slice(0, 7)}`
  const dir = await git.runDirectory(facts, id)
  if (!dir.ok) return `no-mistakes cannot create its run directory: ${dir.reason}`
  const added = await git.addWorktree(facts, git.worktreeOf(dir.path))
  if (!added.ok) return `no-mistakes cannot create its worktree: ${added.reason}`
  const { worktree } = added
  const run = newRun({ id, repo: facts.repo, branch: facts.branch, base: facts.base, worktree: worktree.path, gitFile: worktree.gitFile, commonDir: worktree.commonDir, intent, localHead: facts.head })
  const seeded = await io().writeRun(r => (r && !r.outcome ? r : run))
  if (seeded?.id !== id) {
    await git.removeWorktree(run)
    await io().openPane()
    return `A run is already active${seeded ? ` on ${seeded.branch} (${statusText(seeded)})` : ''}. Finish or abort it from the pane first.`
  }
  knownAgents.clear()
  await io().writeSelected(() => [])
  await io().openPane()
  await showStatus()
  await advance()
  const after = await io().readRun()
  // The note can quote the branch (a conflict names its commit subjects), and
  // this text reaches the main session's model, so it goes in as data.
  if (after?.id === id && after.outcome) return `no-mistakes run ${id} ${after.outcome}. ${UNTRUSTED_NOTE}\n${untrusted('run note', after.note ?? '')}`
  return `no-mistakes run ${id} started on ${facts.branch} (base ${facts.base}) in ${worktree.path}. The pane shows its progress.`
}

function apply(run: Run, name: StepName, outcome: StepOutcome): Run {
  let next = outcome.decision ? decide(run, outcome.decision) : run
  next = setStep({ ...next, ...outcome.patch }, name, outcome.step)
  if (outcome.skipRest) next = skipRest(next, name, outcome.skipRest)
  return next
}

type From = (state: StepState) => boolean

// One conditional write: the change lands only while the step is still in
// the state the caller observed, and only once. Every transition goes here,
// so here an agent the step moves away from is retired.
async function claim(name: StepName, from: From, change: (run: Run) => Run): Promise<Run | undefined> {
  let won = false
  const run = await io().writeRun(r => {
    won = false
    if (!r || r.outcome || currentStep(r) !== name || !from(r.steps[name])) return r
    won = true
    const next = change(r)
    const gone = agentOf(r.steps[name])
    return gone !== undefined && gone !== agentOf(next.steps[name]) ? { ...next, retired: [...(next.retired ?? []), gone] } : next
  })
  return won && run ? run : undefined
}

async function settle(name: StepName, outcome: StepOutcome, from: From): Promise<'continue' | 'wait'> {
  const run = await claim(name, from, r => apply(r, name, outcome))
  if (!run) return 'wait'
  const state = run.steps[name]
  await showStatus()
  if (run.abortRequested) {
    await finish('aborted', `aborted at ${name}`)
    return 'wait'
  }
  switch (state.status) {
    case 'failed':
      await finish('failed', `${name} failed: ${state.reason}`)
      return 'wait'
    case 'parked':
      await io().writeSelected(() => state.findings.map(f => f.id))
      await io().notify(`parked at ${name}: ${state.findings.length} finding(s) need your call`)
      return 'wait'
    case 'running':
    case 'fixing':
      ensurePolling()
      if (state.agentId !== undefined) await replayEarly(state.agentId)
      return 'wait'
    default:
      return 'continue'
  }
}

async function replayEarly(agentId: string): Promise<void> {
  const held = early.get(agentId)
  if (!held) return
  early.delete(agentId)
  await onAgentAnswer(agentId, held.answer, held.reason)
}

async function advance(): Promise<void> {
  for (;;) {
    const run = await io().readRun()
    if (!run || run.outcome) return
    const name = currentStep(run)
    if (!name) return finish('passed', run.prUrl ? `PR ${run.prUrl}` : 'every step passed')
    const startedAt = await io().now()
    const claimed = await claim(name, s => s.status === 'pending', r => setStep(r, name, { status: 'starting', startedAt }))
    if (!claimed) return
    ensurePolling()
    let outcome: StepOutcome
    try {
      outcome = await STEP_DEFS[name].start(claimed)
    } catch (e) {
      outcome = { step: { status: 'failed', reason: `${name} could not start: ${String(e)}` } }
    }
    if ((await settle(name, outcome, s => s.status === 'starting')) === 'wait') return
  }
}

// An agent's answer: the mod commits whatever the agent changed in the
// worktree, then the step judges the answer (a fix round re-runs the step).
export async function onAgentAnswer(agentId: string, answer: string, reason: string): Promise<void> {
  const run = await io().readRun()
  if (!run || run.outcome) return
  const name = currentStep(run)
  if (!name) return
  const state = run.steps[name]
  if (isRetired(run, agentId)) return
  if (agentOf(state) !== agentId) {
    if (isClaimed(state) && (await ownerOf(run, agentId)) !== 'not-ours') {
      if (early.size >= EARLY_MAX) early.delete(early.keys().next().value!)
      early.set(agentId, { answer, reason })
    }
    return
  }
  const mine: From = s => agentOf(s) === agentId
  if (reason !== 'answer') {
    await settle(name, { step: { status: 'failed', reason: `the ${name} agent ended by ${reason}` } }, mine)
    return
  }
  let outcome: StepOutcome
  const committed = await git.commitAll(run, commitMessage(name, state))
  // Only the steps whose agent is asked for a findings block are read this way;
  // each of them (review, document, test, lint) fails closed in its check too.
  const parsed = state.status === 'running' && !state.reasked && AGENT_STEPS.has(name) ? parseFindings(answer, name) : undefined
  if (committed.kind === 'error') {
    outcome = { step: { status: 'failed', reason: committed.isSetup ? `${name}: ${committed.detail}` : `${name}: the agent's edits could not be committed: ${committed.detail}` } }
  } else if (parsed && 'error' in parsed) {
    return reask(name, agentId, parsed.error)
  } else {
    try {
      outcome = state.status === 'fixing' ? { step: { status: 'pending' } } : await STEP_DEFS[name].check(run, answer)
    } catch (e) {
      outcome = { step: { status: 'failed', reason: `${name} could not check the answer: ${String(e)}` } }
    }
  }
  if ((await settle(name, outcome, mine)) === 'continue') await advance()
}

// An answer the mod cannot read gets one more chance: the same agent, which
// still holds its work in context, is asked for the findings block alone.
// Its next answer is checked as usual, and an unreadable one fails closed.
async function reask(name: StepName, agentId: string, error: string): Promise<void> {
  const mine: From = s => agentOf(s) === agentId
  const asked = await claim(name, s => mine(s) && s.status === 'running' && !s.reasked, r => {
    const s = r.steps[name]
    return s.status === 'running' ? setStep(r, name, { ...s, reasked: true }) : r
  })
  if (!asked) return
  const sent = await io().send(agentId, reaskPrompt(error)).catch((e: unknown) => ({ isDelivered: false as const, reason: String(e) }))
  if (!sent.isDelivered) await settle(name, { step: { status: 'failed', reason: `${name} answer is unreadable (${error}) and the agent could not be asked again (${sent.reason}); fail closed` } }, mine)
}

export async function toggle(id: string): Promise<void> {
  await io().writeSelected(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
}

export async function press(verdict: Verdict | 'abort'): Promise<void> {
  const run = await io().readRun()
  if (!run || run.outcome) return
  const name = currentStep(run)
  if (!name) return
  const state = run.steps[name]
  if (verdict === 'abort') {
    // A push, PR or spawn may be in flight: removing the worktree under it
    // would lose the effect. The owner of the claim finishes the abort.
    if (isClaimed(state)) {
      await io().writeRun(r => (r && !r.outcome && isClaimed(r.steps[name]) ? { ...r, abortRequested: true } : r))
      io().toast(`${name} is still starting; the run aborts as soon as it settles.`)
      return
    }
    return finish('aborted', `aborted at ${name}`)
  }
  if (state.status !== 'parked') return
  const parked: From = s => s.status === 'parked'
  if (verdict === 'fix') {
    const selected = await io().readSelected()
    const findings = state.findings.filter(f => selected.includes(f.id))
    if (findings.length === 0) return io().toast('Select at least one finding to fix.')
    const round = fixRounds(run, name) + 1
    if (round > MAX_FIX_ROUNDS) return io().toast(`${name} already had ${MAX_FIX_ROUNDS} fix rounds; approve, skip or abort.`)
    const decision = { step: name, findingIds: findings.map(f => f.id), verdict } as const
    const startedAt = await io().now()
    const claimed = await claim(name, parked, r => setStep(decide(r, decision), name, { status: 'fixing', round, startedAt }))
    if (!claimed) return
    ensurePolling()
    let step: StepState
    try {
      const started = await spawn(claimed, FIXER, fixPrompt(claimed, name, findings, await git.diffStat(claimed)), `fix ${name} ${round}`)
      step = 'error' in started ? { status: 'failed', reason: `could not start the fixer: ${started.error}` } : { status: 'fixing', agentId: started.agentId, round, startedAt }
    } catch (e) {
      step = { status: 'failed', reason: `could not start the fixer: ${String(e)}` }
    }
    await settle(name, { step }, isClaimed)
    return
  }
  const decision = { step: name, findingIds: state.findings.map(f => f.id), verdict } as const
  const step: StepState = verdict === 'approve' ? { status: 'passed', note: 'approved by the human', findings: state.findings } : { status: 'skipped', reason: 'skipped by the human' }
  if ((await settle(name, { step, decision }, parked)) === 'continue') await advance()
}

function ensurePolling(): void {
  if (pollTimer) return
  pollTimer = io().every(CI_POLL_MS, () => void tick())
}

function stopPolling(): void {
  pollTimer?.cancel()
  pollTimer = undefined
}

async function stopAgent(agentId: string): Promise<void> {
  await io().stop(agentId).catch(() => undefined)
}

async function tick(): Promise<void> {
  const run = await io().readRun()
  const name = run && !run.outcome ? currentStep(run) : undefined
  if (!run || !name) return stopPolling()
  const state = run.steps[name]
  const now = await io().now()
  if (isAgentDriven(state) && now - state.startedAt > AGENT_TIMEOUT_MS) {
    const { agentId } = state
    // The step is taken from the agent before it is stopped: the stop ends its
    // turn as aborted, and that answer must find the step no longer its own.
    const taken = await claim(name, s => agentOf(s) === agentId, r => setStep(r, name, { status: 'starting', startedAt: now }))
    if (!taken) return
    await stopAgent(agentId)
    let step: StepState
    if ((await stillRunning(taken)).includes(agentId)) {
      step = { status: 'failed', reason: `the ${name} agent ran 30 minutes without answering and could not be stopped; it may still write to the worktree, so the run stops here` }
    } else {
      // What the agent changed is its step's, as if it had answered; left in
      // the tree it would land in a later step's commit, or be put back by prepare.
      const committed = await git.commitAll(taken, commitMessage(name, state))
      step = committed.kind === 'error' ? { status: 'failed', reason: committed.isSetup ? `${name}: ${committed.detail}` : `${name}: the timed-out agent's edits could not be committed: ${committed.detail}` } : { status: 'parked', findings: [timeoutFinding(name)] }
    }
    await settle(name, { step }, isClaimed)
    return
  }
  // A claim whose owner never settled it (the actor died mid-effect).
  const claimed = claimedAt(state)
  if (claimed !== undefined && now - claimed > AGENT_TIMEOUT_MS) {
    await settle(name, { step: { status: 'failed', reason: `${name} was left starting for 30 minutes; the effect may or may not have run` } }, isClaimed)
    return
  }
  if (name === 'ci' && state.status === 'running') {
    const result = await pollCi(run, (findings, round) =>
      claim('ci', s => s.status === 'running', r => setStep(decide(r, { step: 'ci', findingIds: findings.map(f => f.id), verdict: 'fix', isAuto: true }), 'ci', { status: 'fixing', round, startedAt: now })),
    )
    if (!result) return
    const from: From = result.isClaimed ? isClaimed : s => s.status === 'running'
    if ((await settle('ci', result.outcome, from)) === 'continue') await advance()
    return
  }
  if (state.status !== 'running' && state.status !== 'fixing' && !isClaimed(state)) stopPolling()
}

// A step still claimed after a restart lost the actor that owned it; the
// effect may or may not have run, so it fails rather than runs again.
export async function resume(): Promise<void> {
  const run = await io().readRun()
  if (!run) return
  for (const agentId of run.agents) knownAgents.add(agentId)
  if (run.outcome) return
  const name = currentStep(run)
  if (!name) return
  const state = run.steps[name]
  if (isClaimed(state)) {
    await settle(name, { step: { status: 'failed', reason: `the session restarted while ${name} was starting; run /no-mistakes again` } }, isClaimed)
    return
  }
  if (state.status === 'running' || state.status === 'fixing') ensurePolling()
}

async function stillRunning(run: Run): Promise<string[]> {
  const live = new Set(['pending', 'running', 'waiting', 'idle'])
  try {
    return (await io().agents()).filter(a => run.agents.includes(a.id) && live.has(a.status)).map(a => a.id)
  } catch {
    return run.agents
  }
}

async function finish(outcome: Outcome, note: string): Promise<void> {
  stopPolling()
  early.clear()
  // The outcome is claimed first, so two finishes make one cleanup.
  let won = false
  const run = await io().writeRun(r => {
    won = Boolean(r && !r.outcome)
    return won && r ? { ...r, outcome, note } : r
  })
  if (!won || !run) return
  await showStatus()
  let text = note
  if (run.steps.push.status === 'passed' && run.head !== run.localHead) {
    const ff = await git.isAncestor(run, run.localHead, run.head)
    text += `. origin/${run.branch} now has commits your local branch lacks; update it with ${ff ? 'git pull --ff-only' : 'git pull --rebase'}`
  }
  for (const agentId of run.agents) await stopAgent(agentId)
  const running = await stillRunning(run)
  // Edits nobody committed yet (an agent stopped mid-step) are kept as a
  // commit of their own before the worktree goes.
  const wip = running.length === 0 ? await git.commitAll(run, 'wip(no-mistakes): uncommitted edits when the run ended') : { kind: 'clean' as const }
  const pinned = wip.kind === 'error' ? { kind: 'error' as const, detail: wip.detail } : await git.pinHead(run)
  if (pinned.kind === 'pinned') text += `. Commits made in the worktree are kept at ${pinned.ref}; recover them with git branch ${run.branch}-recovered ${pinned.ref}, or drop them with git update-ref -d ${pinned.ref}`
  if (outcome === 'failed') {
    text += `. The worktree is kept for inspection at ${run.worktree}; remove it with git worktree remove ${run.worktree}`
  } else if (pinned.kind === 'error') {
    text += `. The worktree ${run.worktree} is kept because its HEAD could not be pinned: ${pinned.detail}`
  } else if (running.length > 0) {
    text += `. The worktree ${run.worktree} is kept because ${running.length} pipeline agent(s) could not be stopped and may still write to it; remove it with git worktree remove --force ${run.worktree} once they end`
  } else {
    const removed = await git.removeWorktree(run)
    if (!removed.ok) text += `. Could not remove the worktree ${run.worktree}: ${removed.err}`
  }
  await io().writeRun(r => (r && r.id === run.id ? { ...r, note: text } : r))
  await showStatus()
  await io().notify(`run ${outcome}: ${note}`)
}

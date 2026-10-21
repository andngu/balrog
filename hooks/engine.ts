import type { Finding, FollowUp, Outcome, Run, StepName, StepState, Verdict } from '../types'
import * as git from './git'
import { io } from './io'
import { fixPrompt, reaskPrompt, UNTRUSTED_NOTE, untrusted } from './prompts'
import { AGENT_TIMEOUT_MS, agentOf, CI_POLL_MS, claimedAt, currentStep, decide, fixRounds, isAgentDriven, isBlocking, isClaimed, isRetired, knownAgents, MAX_FIX_ROUNDS, newRun, parseFindings, PLUGIN, report, setStep, skipRest, statusText, timeoutFinding } from './run'
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
    return `A run is already active on ${active.branch} (${statusText(active)}). Finish it, or abort it with /no-mistakes-abort, first.`
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
    return `A run is already active${seeded ? ` on ${seeded.branch} (${statusText(seeded)})` : ''}. Finish it, or abort it with /no-mistakes-abort, first.`
  }
  knownAgents.clear()
  await io().writeSelected(() => [])
  await io().openPane()
  await showStatus()
  await advance()
  const after = await io().readRun()
  // The note can quote the branch (a conflict names its commit subjects), and
  // this text reaches the main session's model, so it goes in as data.
  if (after?.id === id && after.outcome) return `no-mistakes run ${id} ${after.outcome}. ${UNTRUSTED_NOTE}\n${untrusted('run note', report(after))}`
  return `no-mistakes run ${id} started on ${facts.branch} (base ${facts.base}) in ${worktree.path}. The pane shows its progress.`
}

const where = (f: Finding) => (f.file === undefined ? '' : ` ${f.file}${f.line === undefined ? '' : `:${f.line}`}`)

// What an agent or the branch wrote reaches the main session's model as data.
export async function statusReport(): Promise<string> {
  const run = await io().readRun()
  if (!run) return 'No run yet. Start one with /no-mistakes [intent].'
  const head = `${statusText(run)} (${run.branch}, worktree ${run.worktree})`
  const name = currentStep(run)
  if (run.outcome) {
    const lines = [run.note ?? '', ...(run.followUps ?? []).map(f => (f.command === undefined ? f.text : `${f.text}\n  ${f.command}`))].filter(line => line !== '')
    return `${head}\nRun ${run.outcome}${name ? ` at ${name}` : ''}. ${UNTRUSTED_NOTE}\n${untrusted('run outcome', lines.join('\n'))}`
  }
  const state = name === undefined ? undefined : run.steps[name]
  if (name === undefined || state?.status !== 'parked') return head
  const selected = await io().readSelected()
  const left = MAX_FIX_ROUNDS - fixRounds(run, name)
  const findings = state.findings.map(f => `${selected.includes(f.id) ? '[x]' : '[ ]'} ${f.id} ${f.severity} ${f.action}${where(f)}\n${f.description.replace(/^/gm, '    ')}`)
  return [
    head,
    `Parked at ${name} on ${state.findings.map(f => f.id).join(', ')}; ${left > 0 ? `${left} of ${MAX_FIX_ROUNDS} fix rounds left` : 'no fix rounds left'}. [x] marks a selected finding.`,
    'Decide with /no-mistakes-fix [ids], /no-mistakes-approve, /no-mistakes-skip or /no-mistakes-abort.',
    `${UNTRUSTED_NOTE}\n${untrusted('findings', findings.join('\n'))}`,
  ].join('\n')
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

async function settle(name: StepName, outcome: StepOutcome, from: From): Promise<'continue' | 'wait' | 'lost'> {
  const run = await claim(name, from, r => apply(r, name, outcome))
  if (!run) return 'lost'
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
      await io().writeSelected(() => state.findings.filter(isBlocking).map(f => f.id))
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
    if ((await settle(name, outcome, s => s.status === 'starting')) !== 'continue') return
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

export type Pressed = { kind: 'done'; text: string } | { kind: 'abort-pending'; text: string } | { kind: 'refused'; reason: string }

const refused = (reason: string): Pressed => ({ kind: 'refused', reason })

const activity = (state: StepState) => (state.status === 'fixing' ? `in fix round ${state.round}` : state.status)

function progress(run: Run | null): string {
  if (!run) return ''
  if (run.outcome) return `The run ${run.outcome}; /no-mistakes-status shows what is left to do.`
  const name = currentStep(run)
  if (!name) return 'The run is finishing.'
  const state = run.steps[name]
  return state.status === 'parked' ? `${name} is parked on ${state.findings.length} finding(s); /no-mistakes-status lists them.` : `${name} is ${activity(state)}.`
}

async function done(what: string): Promise<Pressed> {
  return { kind: 'done', text: `${what} ${progress(await io().readRun())}` }
}

async function lost(name: StepName): Promise<Pressed> {
  return refused(`${name} was decided meanwhile. ${progress(await io().readRun())}`)
}

export async function press(verdict: Verdict | 'abort', select: readonly string[] = []): Promise<Pressed> {
  const run = await io().readRun()
  if (!run) return refused('No run yet. Start one with /no-mistakes [intent].')
  if (run.outcome) return refused(`The run on ${run.branch} already ${run.outcome}; start a new one with /no-mistakes.`)
  const name = currentStep(run)
  if (!name) return refused('The run is finishing; nothing is left to decide.')
  const state = run.steps[name]
  if (verdict === 'abort') {
    // A push, PR or spawn may be in flight: removing the worktree under it
    // would lose the effect. The owner of the claim finishes the abort.
    if (isClaimed(state)) {
      await io().writeRun(r => (r && !r.outcome && isClaimed(r.steps[name]) ? { ...r, abortRequested: true } : r))
      return { kind: 'abort-pending', text: `${name} is still starting; the run aborts as soon as it settles.` }
    }
    await finish('aborted', `aborted at ${name}`)
    return { kind: 'done', text: `Aborted at ${name}; /no-mistakes-status shows what is left to do.` }
  }
  if (state.status !== 'parked') return refused(`${name} is ${activity(state)}, not parked, so there is nothing to ${verdict}; abort works at any time.`)
  const parked: From = s => s.status === 'parked'
  if (verdict === 'fix') {
    const valid = state.findings.map(f => f.id)
    const unknown = select.filter(id => !valid.includes(id))
    if (unknown.length > 0) return refused(`${unknown.join(', ')}: no such finding at ${name}; its findings are ${valid.join(', ')}.`)
    const round = fixRounds(run, name) + 1
    if (round > MAX_FIX_ROUNDS) return refused(`${name} already had ${MAX_FIX_ROUNDS} fix rounds; approve, skip or abort.`)
    // The selection is read here but written only once the claim is won, so a
    // refused press (lost to a concurrent decision) changes nothing.
    const chosen = select.length > 0 ? [...select] : await io().readSelected()
    const findings = state.findings.filter(f => chosen.includes(f.id))
    if (findings.length === 0) return refused(`Select at least one finding of ${name} to fix, in the pane or with /no-mistakes-fix <ids>.`)
    const decision = { step: name, findingIds: findings.map(f => f.id), verdict } as const
    const startedAt = await io().now()
    const claimed = await claim(name, parked, r => setStep(decide(r, decision), name, { status: 'fixing', round, startedAt }))
    if (!claimed) return lost(name)
    if (select.length > 0) await io().writeSelected(() => [...select])
    ensurePolling()
    let step: StepState
    try {
      const started = await spawn(claimed, FIXER, fixPrompt(claimed, name, findings, await git.diffStat(claimed)), `fix ${name} ${round}`)
      step = 'error' in started ? { status: 'failed', reason: `could not start the fixer: ${started.error}` } : { status: 'fixing', agentId: started.agentId, round, startedAt }
    } catch (e) {
      step = { status: 'failed', reason: `could not start the fixer: ${String(e)}` }
    }
    const settled = await settle(name, { step }, isClaimed)
    if (settled === 'lost') return lost(name)
    if (step.status === 'failed') return done(`Could not send ${decision.findingIds.join(', ')} of ${name} to the fixer: ${step.reason}.`)
    return done(`Sent ${decision.findingIds.join(', ')} of ${name} to the fixer, round ${round} of ${MAX_FIX_ROUNDS}.`)
  }
  const decision = { step: name, findingIds: state.findings.map(f => f.id), verdict } as const
  const step: StepState = verdict === 'approve' ? { status: 'passed', note: 'approved by the human', findings: state.findings } : { status: 'skipped', reason: 'skipped by the human' }
  const settled = await settle(name, { step, decision }, parked)
  if (settled === 'lost') return lost(name)
  if (settled === 'continue') await advance()
  return done(verdict === 'approve' ? `Approved ${name} as is.` : `Skipped ${name}.`)
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
  io().invalidate()
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
  const followUps: FollowUp[] = []
  if (run.steps.push.status === 'passed' && run.head !== run.localHead) {
    const ff = await git.isAncestor(run, run.localHead, run.head)
    followUps.push({ text: `origin/${run.branch} has commits your local branch lacks; update it with`, command: ff ? 'git pull --ff-only' : 'git pull --rebase' })
  }
  for (const agentId of run.agents) await stopAgent(agentId)
  const running = await stillRunning(run)
  // Edits nobody committed yet (an agent stopped mid-step) are kept as a
  // commit of their own before the worktree goes.
  const wip = running.length === 0 ? await git.commitAll(run, 'wip(no-mistakes): uncommitted edits when the run ended') : { kind: 'clean' as const }
  const pinned = wip.kind === 'error' ? { kind: 'error' as const, detail: wip.detail } : await git.pinHead(run)
  if (pinned.kind === 'pinned') {
    followUps.push({ text: `Commits made in the worktree are kept at ${pinned.ref}; recover them with`, command: `git branch ${run.branch}-recovered ${pinned.ref}` })
    followUps.push({ text: 'Or drop them with', command: `git update-ref -d ${pinned.ref}` })
  }
  if (outcome === 'failed') {
    followUps.push({ text: 'The worktree is kept for inspection; remove it with', command: `git worktree remove ${run.worktree}` })
  } else if (pinned.kind === 'error') {
    followUps.push({ text: `The worktree ${run.worktree} is kept because its HEAD could not be pinned: ${pinned.detail}` })
  } else if (running.length > 0) {
    followUps.push({ text: `The worktree ${run.worktree} is kept because ${running.length} pipeline agent(s) could not be stopped and may still write to it; once they end, remove it with`, command: `git worktree remove --force ${run.worktree}` })
  } else {
    const removed = await git.removeWorktree(run)
    if (!removed.ok) followUps.push({ text: `Could not remove the worktree ${run.worktree}: ${removed.err}` })
  }
  await io().writeRun(r => (r && r.id === run.id ? { ...r, followUps } : r))
  await showStatus()
  await io().notify(`run ${outcome}: ${note}`)
}

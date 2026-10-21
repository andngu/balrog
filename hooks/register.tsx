import { atom, read, update } from 'claude-code'
import type { Register, ToolCheckResult } from 'claude-code'

import type { Run } from '../types'
import { onAgentAnswer, ownerOf, resume, startRun } from './engine'
import { asCall, isAllowed, judge, writtenPath } from './guard'
import { bind, io } from './io'
import { registerPane } from './pane'
import { knownAgents, PANE, statusText } from './run'
import { AGENT_SPECS, FIXER, REVIEWER } from './steps'

// The state library's scan needs each atom written in the file that reads it.
const runAtom = atom({ plugin: 'no-mistakes', key: 'run' } as const, null)
const selectedAtom = atom({ plugin: 'no-mistakes', key: 'selected' } as const, [])

type Owner = { run: Run; owned: 'ours' | 'unknown' } | undefined

// The run an agent's call belongs to, or undefined when the call is not a
// run agent's and the guards have no say. `unknown` is a call made in a
// spawn window while the agent list could not be read.
async function ownerOfCall(run: Run | null, agentId: string | undefined): Promise<Owner> {
  if (agentId === undefined || !run) return undefined
  const owned = await ownerOf(run, agentId)
  return owned === 'not-ours' ? undefined : { run, owned }
}

// A deny or an ask that stands on a settings rule, a classic hook or a
// permission setting is the user's or their organization's, and nothing here
// turns it into an allow.
const isUsersVerdict = (verdict: ToolCheckResult) => verdict.decision !== 'allow' && (verdict.rule ?? verdict.hook ?? verdict.setting) !== undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    bind({
      run: (argv, init) => $.process.run(argv, init),
      spawn: args => $.agent.spawn(args),
      agents: () => $.agent.list(),
      stop: agentId => $.tool.call({ tool: 'TaskStop', task_id: agentId }),
      home: () => $.env.get('HOME'),
      cacheHome: () => $.env.get('XDG_CACHE_HOME'),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      stat: path => $.fs.stat(path, { resolve: true }),
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      fork: prompt => $.model.fork({ prompt }),
      complete: request => $.model.complete(request),
      cwd: () => $.session.cwd(),
      openPane: () => $.ui.open({ id: PANE, title: 'no-mistakes', rows: 24 }),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      notify: text => $.ui.notify(text),
      readRun: () => read($, runAtom),
      writeRun: change => update($, runAtom, change),
      readSelected: () => read($, selectedAtom),
      writeSelected: change => update($, selectedAtom, change),
    })
    await $.command.register({ name: 'no-mistakes', description: 'Gate this branch: review, test, document, lint, push, PR, CI in a disposable worktree', argumentHint: '[intent]' })
    await $.command.register({ name: 'no-mistakes-status', description: 'Reopen the no-mistakes run pane' })
    for (const spec of AGENT_SPECS) await $.agent.register(spec)
    $.ui.status(statusText(await read($, runAtom)))
    await resume()
    return next(e)
  })

  // The deny half: a run agent never reads or writes outside the worktree or
  // at its .git, and its shell runs nothing but the configured commands,
  // whatever the user's own rules would allow. A guard that fails refuses
  // only an agent the run is known to have spawned.
  on('tool.call', async ($, e, next) => {
    const owner = await ownerOfCall(await read($, runAtom), e.agentId)
    if (!owner) return next(e)
    const call = asCall(e)
    const stat = (path: string) => $.fs.stat(path, { resolve: true })
    const reason = await judge(call, owner.run.worktree, owner.run.commands, stat)
    if (reason !== undefined) return { deny: `no-mistakes: ${reason}` }
    const written = await writtenPath(call, owner.run.worktree, stat)
    const result = await next(e)
    if (written !== undefined && result.deny === undefined && !result.isError) {
      await update($, runAtom, r => (r && r.id === owner.run.id && !r.written?.includes(written) ? { ...r, written: [...(r.written ?? []), written] } : r))
    }
    return result
  }).catch(($, e, next) => (next.called || e.agentId === undefined || !knownAgents.has(e.agentId) ? next(e) : { deny: 'no-mistakes: the guard failed, so the call is refused' }))

  // The allow half: the engine's own verdict comes first and a deny or ask
  // of the user's stands. Only then does a run agent's call inside the worktree, or
  // one of the configured commands, run without an ask. A guard that fails
  // leaves the engine's verdict.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.agentId === undefined || isUsersVerdict(verdict) || e.ceiling !== undefined) return verdict
    const owner = await ownerOfCall(await read($, runAtom), e.agentId)
    if (!owner || owner.owned !== 'ours') return verdict
    const allowed = await isAllowed(asCall(e), owner.run.worktree, owner.run.commands, path => $.fs.stat(path, { resolve: true }))
    return allowed ? { decision: 'allow', reason: 'no-mistakes: inside the run worktree' } : verdict
  }).catch(($, e, next) => next(e))

  on('agent.offer', { agent: REVIEWER }, () => ({ isOffered: false }))
  on('agent.offer', { agent: FIXER }, () => ({ isOffered: false }))

  on('command.run', { command: 'no-mistakes' }, async (_$, e) => ({ text: await startRun(e.args) }))

  on('command.run', { command: 'no-mistakes-status' }, async () => {
    await io().openPane()
    const run = await io().readRun()
    return { text: run ? `${statusText(run)} (${run.branch}, worktree ${run.worktree})` : 'No run yet. Start one with /no-mistakes [intent].' }
  })

  on('turn.complete', async (_$, e, next) => {
    if (e.agentId !== undefined) await onAgentAnswer(e.agentId, e.answer, e.reason)
    return next(e)
  })

  registerPane(on)
}

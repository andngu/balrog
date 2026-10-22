import { atom, read, update } from 'claude-code'
import type { Register, ToolCheckResult } from 'claude-code'

import type { Run } from '../types'
import { onAgentAnswer, ownerOf, press, resume, startRun, statusReport } from './engine'
import { asCall, isAllowed, judge, writtenPath } from './guard'
import { bind, io } from './io'
import { registerPane } from './pane'
import { fromStore, isRetired, knownAgents, PANE, statusText, writeOrDrop } from './run'
import { AGENT_SPECS, FIXER, REVIEWER } from './steps'

// The state library's scan needs each atom written in the file that reads it.
const runAtom = atom({ plugin: 'balrog', key: 'run' } as const, null)
const selectedAtom = atom({ plugin: 'balrog', key: 'selected' } as const, [])

type Engine = Parameters<typeof read>[0]

async function storedRun($: Engine): Promise<Run | null> {
  const run = await read($, runAtom)
  return run && fromStore(run)
}

type Owner = { run: Run; owned: 'ours' | 'unknown' } | undefined

// The run an agent's call belongs to, or undefined when the call is not a
// run agent's and the guards have no say. `unknown` is a call made in a
// spawn window while the agent list could not be read.
async function ownerOfCall(run: Run | null, agentId: string | undefined): Promise<Owner> {
  if (agentId === undefined || !run) return undefined
  const owned = await ownerOf(run, agentId)
  return owned === 'not-ours' ? undefined : { run, owned }
}

const DECISIONS = [
  { name: 'balrog-fix', verdict: 'fix', description: "Send the parked step's selected findings, or the ones named, to the fixer", argumentHint: '[finding ids]' },
  { name: 'balrog-approve', verdict: 'approve', description: 'Approve every finding of the parked step as is' },
  { name: 'balrog-skip', verdict: 'skip', description: 'Skip the parked step' },
  { name: 'balrog-abort', verdict: 'abort', description: 'Abort the balrog run' },
] as const

// A deny or an ask that carries a rule, a hook or a setting is the user's or their organization's.
const isUsersVerdict = (verdict: ToolCheckResult) => verdict.decision !== 'allow' && (verdict.rule ?? verdict.hook ?? verdict.setting) !== undefined

const refused = (result: { deny?: unknown; isError?: unknown }) => result.deny !== undefined || result.isError === true

export const register: Register = on => {
  let recordWrite: Promise<void> = Promise.resolve()
  on('session.start', async ($, e, next) => {
    bind({
      run: (argv, init) => $.process.run(argv, init),
      spawn: args => $.agent.spawn(args),
      agents: () => $.agent.list(),
      stop: agentId => $.tool.call({ tool: 'TaskStop', task_id: agentId }),
      home: () => $.env.get('HOME'),
      cacheHome: () => $.env.get('XDG_CACHE_HOME'),
      read: path => $.fs.read(path),
      exists: path => $.fs.exists(path),
      write: (path, text) => $.fs.write(path, text),
      stat: path => $.fs.stat(path, { resolve: true }),
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      fork: prompt => $.model.fork({ prompt }),
      complete: request => $.model.complete(request),
      cwd: () => $.session.cwd(),
      openPane: () => $.ui.open({ id: PANE, title: 'balrog', rows: 24 }),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      notify: text => $.ui.notify(text),
      invalidate: () => $.ui.invalidate('ui.render'),
      readRun: () => storedRun($),
      writeRun: async change => {
        const run = await update($, runAtom, run => change(run && fromStore(run)))
        if (run?.recordDir !== undefined) await (recordWrite = recordWrite.then(() => writeOrDrop(() => $.fs.write(`${run.recordDir}/latest.json`, JSON.stringify(run)))))
        return run
      },
      readSelected: () => read($, selectedAtom),
      writeSelected: change => update($, selectedAtom, change),
    })
    await $.command.register({ name: 'balrog', description: 'Gate this branch: review, test, document, lint, recheck, push, PR, CI in a disposable worktree', argumentHint: '[intent]' })
    await $.command.register({ name: 'balrog-status', description: 'Reopen the balrog run pane and list what the run needs from you' })
    for (const { verdict: _, ...command } of DECISIONS) await $.command.register(command)
    for (const spec of AGENT_SPECS) await $.agent.register(spec)
    $.ui.status(statusText(await storedRun($)))
    await resume()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const owner = await ownerOfCall(await storedRun($), e.agentId)
    if (!owner) return next(e)
    if (isRetired(owner.run, e.agentId!)) return { deny: 'balrog: this agent\'s step is over, so it may not act in the run any more' }
    const call = asCall(e)
    const stat = (path: string) => $.fs.stat(path, { resolve: true })
    const reason = await judge(call, owner.run.worktree, owner.run.commands, stat)
    if (reason !== undefined) return { deny: `balrog: ${reason}` }
    const written = await writtenPath(call, owner.run.worktree, stat)
    if (written === undefined) return next(e)
    let added = false
    await update($, runAtom, r => {
      if (!r || r.id !== owner.run.id || r.written?.includes(written)) return r
      added = true
      return { ...r, written: [...(r.written ?? []), written] }
    })
    const unrecord = () => update($, runAtom, r => (r && r.id === owner.run.id && added ? { ...r, written: (r.written ?? []).filter(p => p !== written) } : r))
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (err) {
      if (added) await unrecord()
      throw err
    }
    if (added && refused(result)) await unrecord()
    return result
  }).catch(($, e, next) => (next.called || e.agentId === undefined || !knownAgents.has(e.agentId) ? next(e) : { deny: 'balrog: the guard failed, so the call is refused' }))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.agentId === undefined || isUsersVerdict(verdict) || e.ceiling !== undefined) return verdict
    const owner = await ownerOfCall(await storedRun($), e.agentId)
    if (!owner || owner.owned !== 'ours' || isRetired(owner.run, e.agentId)) return verdict
    const allowed = await isAllowed(asCall(e), owner.run.worktree, owner.run.commands, path => $.fs.stat(path, { resolve: true }))
    return allowed ? { decision: 'allow', reason: 'balrog: inside the run worktree' } : verdict
  }).catch(($, e, next) => next(e))

  on('agent.offer', { agent: REVIEWER }, () => ({ isOffered: false }))
  on('agent.offer', { agent: FIXER }, () => ({ isOffered: false }))

  on('command.run', { command: 'balrog' }, async (_$, e) => ({ text: await startRun(e.args) }))

  on('command.run', { command: 'balrog-status' }, async () => {
    await io().openPane()
    return { text: await statusReport() }
  })

  for (const { name, verdict } of DECISIONS) {
    on('command.run', { command: name }, async (_$, e) => {
      const named = e.args.split(/[\s,]+/).filter(id => id !== '')
      if (verdict !== 'fix' && named.length > 0) return { text: `balrog refused: /${name} takes no arguments, so ${named.join(', ')} was not used. Select findings in the pane, or use /balrog-fix <ids>.` }
      const pressed = await press(verdict, named)
      return { text: pressed.kind === 'refused' ? `balrog refused: ${pressed.reason}` : pressed.text }
    })
  }

  on('turn.complete', async (_$, e, next) => {
    if (e.agentId !== undefined) await onAgentAnswer(e.agentId, e.answer, e.reason)
    return next(e)
  })

  registerPane(on)
}

import { expect, test } from 'claude-code/testing'

import type { Reply } from './world'
import { DIFF, FETCH_BASE, PLUGIN, answer, command, complete, isDenied, lastRun, parkReview, pressOnce, start, toolCall, toolCheck, world } from './world'

// The real timer of the test runtime, for work the mocked clock must not see.
declare const setTimeout: (fn: () => void, ms: number) => unknown

test('an answer another agent gives is ignored', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'someone-else', answer([{ id: 'x', severity: 'error', action: 'auto-fix', description: 'nope' }]))
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
})

test('defect 4: a guard that throws denies a known run agent, and finished agents stay guarded', async ($, on) => {
  const w = world($, on)
  await start($)
  w.statThrows = true
  const r = await toolCall($, 'agent-1', { tool: 'Write', file_path: `${lastRun(w).worktree}/a.ts`, content: 'x' })
  expect(isDenied(r)).toBe(true)
  w.statThrows = false
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'bug' }]))
  await w.clock.advance(31 * 60_000)
  const late = await toolCall($, 'agent-1', { tool: 'Bash', command: 'git push origin HEAD:feat' })
  expect(isDenied(late)).toBe(true)
})

test('defect 7: Abort is offered while an agent runs, and the agent later answer is ignored', async ($, on) => {
  const w = world($, on)
  await start($)
  expect(await w.pane('terminal')).toContain('abort=Abort')
  await pressOnce($, 'abort')
  expect(lastRun(w).outcome).toBe('aborted')
  await complete($, 'agent-1', answer([]))
  expect(lastRun(w).outcome).toBe('aborted')
  expect(w.spawns).toHaveLength(1)
})

test('defect 7: a running agent times out into a parked finding', async ($, on) => {
  const w = world($, on)
  await start($)
  await w.clock.advance(29 * 60_000)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running' })
  await w.clock.advance(2 * 60_000)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked', findings: [{ id: 'review:timeout', action: 'ask-user' }] })
  expect(await w.pane('terminal')).toContain('Parked at review')
  await complete($, 'agent-1', answer([]))
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
})

test('defect 7: an answer that lands before the agent id is recorded is not dropped', async ($, on) => {
  const w = world($, on, { instantReview: answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'instant' }]) })
  await start($)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked', findings: [{ id: 'r1' }] })
})

test('item 1: a relative escape from the worktree reaches nothing of the repository', async ($, on) => {
  const w = world($, on)
  await start($)
  const run = lastRun(w)
  expect(run.worktree.startsWith('/home/u/.cache/no-mistakes/')).toBe(true)
  expect(run.worktree.startsWith('/repo')).toBe(false)
  const r = await toolCall($, 'agent-1', { tool: 'Write', file_path: `${run.worktree}/../../refs/heads/main`, content: 'x' })
  expect(isDenied(r)).toBe(true)
  expect((await $.command.run(command('no-mistakes-status'))).text).toContain(run.worktree)
})

test('item 2: the Write placement walks up to the first existing ancestor and refuses a dot-dot tail', async ($, on) => {
  const w = world($, on, { missing: ['new', 'dir', 'file.ts'] })
  await start($)
  const wt = lastRun(w).worktree
  const r = await toolCall($, 'agent-1', { tool: 'Write', file_path: `${wt}/new/dir/file.ts`, content: 'x' })
  expect(r.deny).toBeUndefined()
  expect((await toolCheck($, 'agent-1', 'Write', { file_path: `${wt}/new/dir/file.ts`, content: 'x' })).decision).toBe('allow')
  const escape = await toolCall($, 'agent-1', { tool: 'Write', file_path: `${wt}/new/../../dir/file.ts`, content: 'x' })
  expect(isDenied(escape)).toBe(true)
})

test('item 3: agents the run did not spawn are untouched, the list is read only in the spawn window, and the guard outlives the run', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  w.listThrows = true
  const before = w.lists
  const r = await toolCall($, 'users-own-agent', { tool: 'Bash', command: 'git push origin HEAD:main' })
  expect(r.deny).toBeUndefined()
  expect((await toolCheck($, 'users-own-agent', 'Edit', { file_path: '/repo/a.ts' })).decision).toBe('ask')
  expect(w.lists - before).toBe(0)
  const ours = await toolCall($, 'agent-1', { tool: 'Bash', command: 'git push origin HEAD:main' })
  expect(ours.deny).toContain('no-mistakes')
  w.listThrows = false
  await pressOnce($, 'abort')
  expect(lastRun(w).outcome).toBe('aborted')
  const after = w.lists
  const later = await toolCall($, 'agent-1', { tool: 'Bash', command: 'git push origin HEAD:main' })
  expect(later.deny).toContain('no-mistakes')
  expect(w.lists - after).toBe(0)
})

test('item 3: an answer in the spawn window is held only for an agent the plugin spawned', async ($, on) => {
  const w = world($, on, { instantReview: answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'instant' }]), foreignReview: true })
  await start($)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
})

test('item 4: a claim nobody settles is failed by the tick after the agent timeout', async ($, on) => {
  const w = world($, on)
  let reached: (() => void) | undefined
  const fetching = new Promise<void>(r => { reached = r })
  w.rules.push(async line => (line === FETCH_BASE ? (reached!(), await new Promise<Reply>(() => {})) : undefined))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The fetch never answers, so this call is torn down with the test, rejected.
  void $.command.run(command(PLUGIN, 'add x')).catch(() => undefined)
  await fetching
  expect(lastRun(w).steps.rebase).toMatchObject({ status: 'starting' })
  await w.clock.advance(31 * 60_000)
  const run = lastRun(w)
  expect(run.steps.rebase).toMatchObject({ status: 'failed' })
  expect(run.outcome).toBe('failed')
  expect(run.note).toContain('left starting')
})

test('item 6: a timed-out agent is stopped, and Abort stops every run agent before the worktree goes', async ($, on) => {
  const w = world($, on)
  await start($)
  await w.clock.advance(31 * 60_000)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
  expect(w.stops).toEqual(['agent-1'])
  await pressOnce($, 'fix')
  expect(lastRun(w).steps.review).toMatchObject({ status: 'fixing', agentId: 'agent-2' })
  await pressOnce($, 'abort')
  const run = lastRun(w)
  expect(run.outcome).toBe('aborted')
  expect(w.stops.slice(1)).toContain('agent-2')
  expect(w.calls.lastIndexOf(`git worktree remove --force ${run.worktree}`)).toBeGreaterThan(-1)
})

test('item 6: a worktree is kept, and the note says so, while a run agent could not be stopped', async ($, on) => {
  const w = world($, on)
  w.stopFails = true
  await parkReview($, w)
  await pressOnce($, 'fix')
  await pressOnce($, 'abort')
  const run = lastRun(w)
  expect(run.outcome).toBe('aborted')
  expect(w.stops).toContain('agent-2')
  expect(w.calls.some(c => c.startsWith('git worktree remove'))).toBe(false)
  expect(run.followUps).toEqual([
    { text: `The worktree ${run.worktree} is kept because 1 pipeline agent(s) could not be stopped and may still write to it; once they end, remove it with`, command: `git worktree remove --force ${run.worktree}` },
  ])
})

test('B: the reviewer has Read, Grep and Glob only and the fixer no git tool, both under dontAsk', async ($, on) => {
  const w = world($, on)
  await start($)
  expect(w.specs.reviewer).toEqual({ tools: ['Read', 'Grep', 'Glob'], permissionMode: 'dontAsk' })
  expect(w.specs.fixer).toEqual({ tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], permissionMode: 'dontAsk' })
  expect(w.spawns[0]!.prompt).not.toContain('git -C')
})

test('B: tool.check keeps a deny of the user or their organization even inside the worktree', async ($, on) => {
  const w = world($, on)
  await start($)
  const wt = lastRun(w).worktree
  expect((await toolCheck($, 'agent-1', 'Edit', { file_path: `${wt}/a.ts`, old_string: 'a', new_string: 'b' })).decision).toBe('allow')
  w.coreCheck = { decision: 'deny', reason: 'Edit(**/a.ts) denied', rule: 'Edit(**/a.ts)' }
  expect(await toolCheck($, 'agent-1', 'Edit', { file_path: `${wt}/a.ts`, old_string: 'a', new_string: 'b' })).toMatchObject({ decision: 'deny', rule: 'Edit(**/a.ts)' })
  w.coreCheck = { decision: 'deny', reason: 'blocked by PreToolUse', hook: 'PreToolUse' }
  expect((await toolCheck($, 'agent-1', 'Bash', { command: `cd '${wt}' && npm test` })).decision).toBe('deny')
  w.coreCheck = { decision: 'deny', reason: 'dontAsk: nobody to ask' }
  expect((await toolCheck($, 'agent-1', 'Bash', { command: `cd '${wt}' && npm test` })).decision).toBe('allow')
})

test('B: the shell runs only a configured command spelled exactly; git, .git paths and reads outside are refused', async ($, on) => {
  const w = world($, on, { realPaths: { '/home/u/.cache/no-mistakes/link.ts': '/elsewhere/x.ts' } })
  await start($)
  const wt = lastRun(w).worktree
  const decision = async (agentId: string | undefined, tool: string, input: Record<string, unknown>) => (await toolCheck($, agentId, tool, input)).decision
  expect(await decision('agent-1', 'Bash', { command: `cd '${wt}' && npm test` })).toBe('allow')
  expect(await decision('agent-1', 'Bash', { command: `  cd '${wt}' && npm run lint\n` })).toBe('allow')
  for (const c of ['git status', 'npm test', `cd ${wt} && npm test`, `cd '${wt}' && npm test && git push`, `cd '${wt}' && npm test; git push`, `git -C ${wt} commit -F /home/u/.ssh/id_rsa`, `git -C ${wt} add -A`, `cd '${wt}' && git status`, 'ls -la', `cd '${wt}' && npm`]) {
    expect([c, await decision('agent-1', 'Bash', { command: c })]).toEqual([c, 'ask'])
    expect([c, isDenied(await toolCall($, 'agent-1', { tool: 'Bash', command: c }))]).toEqual([c, true])
  }
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Bash', command: `cd '${wt}' && npm test` }))).toBe(false)
  expect(await decision('agent-1', 'Edit', { file_path: `${wt}/a.ts`, old_string: 'a', new_string: 'b' })).toBe('allow')
  expect(await decision('agent-1', 'Write', { file_path: `${wt}/deep/new/dir/file.ts`, content: 'x' })).toBe('allow')
  expect(await decision('agent-1', 'Read', { file_path: `${wt}/a.ts` })).toBe('allow')
  expect(await decision('agent-1', 'Grep', { pattern: 'x', path: wt })).toBe('allow')
  expect(await decision('agent-1', 'Glob', { pattern: '**/*.ts', path: `${wt}/src` })).toBe('allow')
  expect(await decision('agent-1', 'Grep', { pattern: 'x' })).toBe('ask')
  expect(await decision('agent-1', 'Glob', { pattern: '**' })).toBe('ask')
  expect(await decision('agent-1', 'Grep', { pattern: 'x', path: '/repo' })).toBe('ask')
  for (const path of [`${wt}/.git`, `${wt}/.git/config`, `${wt}/sub/.git/hooks/pre-commit`]) {
    expect([path, await decision('agent-1', 'Write', { file_path: path, content: 'gitdir: /repo/.git' })]).toEqual([path, 'ask'])
    expect([path, await decision('agent-1', 'Read', { file_path: path })]).toEqual([path, 'ask'])
    expect([path, isDenied(await toolCall($, 'agent-1', { tool: 'Write', file_path: path, content: 'x' }))]).toEqual([path, true])
    expect([path, isDenied(await toolCall($, 'agent-1', { tool: 'Read', file_path: path }))]).toEqual([path, true])
  }
  expect(await decision('agent-1', 'Write', { file_path: `${wt}/.github/workflows/ci.yml`, content: 'x' })).toBe('allow')
  expect(await decision('agent-1', 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })).toBe('ask')
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }))).toBe(true)
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Write', file_path: '/home/u/.cache/no-mistakes/link.ts', content: 'x' }))).toBe(true)
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'NotebookEdit', notebook_path: '/tmp/n.ipynb', new_source: 'x' }))).toBe(true)
  expect(await decision('agent-1', 'Read', { file_path: '/etc/passwd' })).toBe('ask')
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Read', file_path: '/repo/a.ts' }))).toBe(true)
  expect(await decision('other-agent', 'Edit', { file_path: `${wt}/a.ts`, old_string: 'a', new_string: 'b' })).toBe('ask')
  expect(await decision(undefined, 'Bash', { command: `cd '${wt}' && npm test` })).toBe('ask')
  w.coreCheck = { decision: 'allow' }
  expect(isDenied(await toolCall($, 'other-agent', { tool: 'Bash', command: 'git push origin HEAD:feat' }))).toBe(false)
  expect(isDenied(await toolCall($, undefined, { tool: 'Bash', command: 'git push origin HEAD:feat' }))).toBe(false)
})

test('B: with no command configured the shell is refused outright and the fixer is told so', async ($, on) => {
  const w = world($, on, { config: '' })
  await start($)
  await complete($, 'agent-1', answer([]))
  await pressOnce($, 'approve')
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
  expect(w.spawns[1]!.prompt).toContain('no command is configured')
  const r = await toolCall($, 'agent-2', { tool: 'Bash', command: 'ls' })
  expect(r.deny).toContain('no shell command is configured')
})

test('E: a call with no agent id, or from an agent whose ownership cannot be settled, keeps the engine verdict', async ($, on) => {
  const w = world($, on, { instantReview: answer([]) })
  await start($)
  const wt = lastRun(w).worktree
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
  expect((await toolCheck($, undefined, 'Edit', { file_path: `${wt}/a.ts` })).decision).toBe('ask')
  w.statThrows = true
  expect((await toolCheck($, 'agent-2', 'Edit', { file_path: `${wt}/a.ts` })).decision).toBe('ask')
  w.statThrows = false
  expect((await toolCheck($, 'agent-2', 'Edit', { file_path: `${wt}/a.ts` })).decision).toBe('allow')
})

test('E: in the spawn window an agent the list cannot vouch for is denied the hard-no class but allowed nothing', async ($, on) => {
  const w = world($, on)
  let release: (() => void) | undefined
  let reached: (() => void) | undefined
  const gate = new Promise<void>(r => { release = r })
  const diffing = new Promise<void>(r => { reached = r })
  w.rules.push(async line => (line === DIFF ? (reached!(), await gate, { stdout: '+x' }) : undefined))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const started = $.command.run(command(PLUGIN, 'add x'))
  await diffing
  const run = lastRun(w)
  expect(run.steps.review).toMatchObject({ status: 'starting' })
  w.listThrows = true
  expect((await toolCheck($, 'maybe-ours', 'Read', { file_path: `${run.worktree}/a.ts` })).decision).toBe('ask')
  w.coreCheck = { decision: 'allow' }
  expect(isDenied(await toolCall($, 'maybe-ours', { tool: 'Bash', command: 'git push origin HEAD:main' }))).toBe(true)
  expect(isDenied(await toolCall($, 'maybe-ours', { tool: 'Read', file_path: `${run.worktree}/a.ts` }))).toBe(false)
  w.listThrows = false
  release!()
  await started
})

test('R4-1: a run agent reads nothing outside the worktree, and Grep or Glob without a path is refused', async ($, on) => {
  const w = world($, on)
  await start($)
  const wt = lastRun(w).worktree
  for (const input of [
    { tool: 'Read', file_path: '/repo/.env.local' },
    { tool: 'Read', file_path: '/home/u/.ssh/id_rsa' },
    { tool: 'Grep', pattern: 'TOKEN', path: '/repo' },
    { tool: 'Grep', pattern: 'TOKEN' },
    { tool: 'Glob', pattern: '**/.env*' },
    { tool: 'Glob', pattern: '*', path: '/repo' },
  ]) {
    expect([input, isDenied(await toolCall($, 'agent-1', input))]).toEqual([input, true])
    expect([input, (await toolCheck($, 'agent-1', input.tool, input)).decision]).toEqual([input, 'ask'])
  }
  expect((await toolCall($, 'agent-1', { tool: 'Grep', pattern: 'x' })).deny).toContain('needs an absolute path under the worktree')
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Read', file_path: `${wt}/a.ts` }))).toBe(false)
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Grep', pattern: 'x', path: wt }))).toBe(false)
  w.coreCheck = { decision: 'allow' }
  expect(isDenied(await toolCall($, 'users-own-agent', { tool: 'Read', file_path: '/repo/.env.local' }))).toBe(false)
})

test('R4-2: a Glob pattern that is absolute or climbs out of its path is refused', async ($, on) => {
  const w = world($, on)
  await start($)
  const wt = lastRun(w).worktree
  for (const pattern of ['/repo/**/.env*', `${wt}/../../**`, '../../../repo/*', 'src/../../x', '~/.ssh/*']) {
    expect([pattern, isDenied(await toolCall($, 'agent-1', { tool: 'Glob', pattern, path: wt }))]).toEqual([pattern, true])
    expect([pattern, (await toolCheck($, 'agent-1', 'Glob', { pattern, path: wt })).decision]).toEqual([pattern, 'ask'])
  }
  expect((await toolCheck($, 'agent-1', 'Glob', { pattern: 'src/**/*.ts', path: wt })).decision).toBe('allow')
})

test('R4-4: an ask that stands on a rule, a hook or a setting of the user stays an ask', async ($, on) => {
  const w = world($, on)
  await start($)
  const wt = lastRun(w).worktree
  for (const verdict of [
    { decision: 'ask' as const, reason: 'Edit asks', rule: 'Edit(**/a.ts)' },
    { decision: 'ask' as const, reason: 'hook asks', hook: 'PreToolUse' },
    { decision: 'ask' as const, reason: 'reads outside', setting: 'permissions.blockReadsOutsideWorkingDirectories' },
  ]) {
    w.coreCheck = verdict
    expect(await toolCheck($, 'agent-1', 'Edit', { file_path: `${wt}/a.ts`, old_string: 'a', new_string: 'b' })).toMatchObject(verdict)
  }
  w.coreCheck = { decision: 'ask' }
  expect((await toolCheck($, 'agent-1', 'Edit', { file_path: `${wt}/a.ts`, old_string: 'a', new_string: 'b' })).decision).toBe('allow')
})

test('R4-9/10: a dangling link and a .git spelled in another case are not places an agent may write', async ($, on) => {
  const w = world($, on, { dangling: ['link'], missing: ['nowhere'] })
  await start($)
  const wt = lastRun(w).worktree
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Write', file_path: `${wt}/link`, content: 'x' }))).toBe(true)
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Write', file_path: `${wt}/link/nowhere`, content: 'x' }))).toBe(true)
  expect((await toolCheck($, 'agent-1', 'Write', { file_path: `${wt}/link`, content: 'x' })).decision).toBe('ask')
  for (const path of [`${wt}/.GIT/config`, `${wt}/.Git`, `${wt}/sub/.gIt/hooks/pre-commit`]) {
    expect([path, isDenied(await toolCall($, 'agent-1', { tool: 'Write', file_path: path, content: 'x' }))]).toEqual([path, true])
    expect([path, (await toolCheck($, 'agent-1', 'Write', { file_path: path, content: 'x' })).decision]).toEqual([path, 'ask'])
  }
})

test('R5-3: a timed-out agent is stopped and its edits are committed under its own step before the park', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([]))
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
  let stoppedFirst = false
  w.rules.push(line => {
    if (line.startsWith('git commit')) stoppedFirst = w.stops.includes('agent-2')
    return undefined
  })
  w.dirty = true
  await w.clock.advance(31 * 60_000)
  const run = lastRun(w)
  expect(run.steps.document).toMatchObject({ status: 'parked', findings: [{ id: 'document:timeout' }] })
  expect(w.calls).toContain('git commit -q -m docs(no-mistakes): update documentation for the change')
  expect(stoppedFirst).toBe(true)
  const before = w.calls.length
  await pressOnce($, 'skip')
  expect(w.calls.slice(before).some(c => c.startsWith('git commit'))).toBe(false)
})

test('R6-3: only the current step\'s agent acts; an agent whose step moved on, and every agent once the run ends, is refused', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([]))
  const wt = lastRun(w).worktree
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
  expect(isDenied(await toolCall($, 'agent-2', { tool: 'Read', file_path: `${wt}/a.ts` }))).toBe(false)
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Read', file_path: `${wt}/a.ts` }))).toBe(true)
  expect(isDenied(await toolCall($, 'agent-1', { tool: 'Write', file_path: `${wt}/a.ts`, content: 'x' }))).toBe(true)
  expect((await toolCheck($, 'agent-1', 'Read', { file_path: `${wt}/a.ts` })).decision).not.toBe('allow')
  await pressOnce($, 'abort')
  expect(lastRun(w).outcome).toBe('aborted')
  expect(isDenied(await toolCall($, 'agent-2', { tool: 'Read', file_path: `${wt}/a.ts` }))).toBe(true)
})

test('R6-3: a timed-out agent that cannot be stopped fails the run, keeps the worktree, and keeps no access', async ($, on) => {
  const w = world($, on)
  w.stopFails = true
  await start($)
  await complete($, 'agent-1', answer([]))
  w.dirty = true
  await w.clock.advance(31 * 60_000)
  const run = lastRun(w)
  expect(run.steps.document).toMatchObject({ status: 'failed', reason: expect.stringContaining('could not be stopped') })
  expect(run.outcome).toBe('failed')
  expect(w.calls.some(c => c.startsWith('git commit'))).toBe(false)
  expect(w.calls.some(c => c.startsWith('git worktree remove'))).toBe(false)
  expect(isDenied(await toolCall($, 'agent-2', { tool: 'Write', file_path: `${run.worktree}/a.ts`, content: 'x' }))).toBe(true)
})

test('R6-4: the aborted turn a timeout stop causes does not fail the step; it parks on the timeout', async ($, on) => {
  const w = world($, on)
  w.stopAborts = true
  await start($)
  await w.clock.advance(31 * 60_000)
  const run = lastRun(w)
  expect(w.stops).toEqual(['agent-1'])
  expect(run.steps.review).toMatchObject({ status: 'parked', findings: [{ id: 'review:timeout' }] })
  expect(run.outcome).toBeUndefined()
})

test('R6-4: an answer racing the timeout never commits at the same time as it', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([]))
  // A commit runs from its `git add -u` to its `git diff --cached --quiet`.
  let open = 0
  let most = 0
  let release: (() => void) | undefined
  const held = new Promise<void>(r => { release = r })
  let hold = false
  w.rules.push(async line => {
    if (line === 'git add -u') {
      most = Math.max(most, ++open)
      if (hold) {
        hold = false
        await held
      }
    }
    if (line === 'git diff --cached --quiet') open--
    return undefined
  })
  await w.clock.advance(29 * 60_000 + 59_000)
  const before = w.calls.filter(c => c === 'git add -u').length
  hold = true
  const notified = w.notifies
  const answered = complete($, 'agent-2', answer([]))
  await new Promise<void>(r => setTimeout(r, 20))
  await w.clock.advance(60_000)
  await new Promise<void>(r => setTimeout(r, 20))
  release!()
  await answered
  // Settled once the park's notification went out, the last thing a park does.
  for (let i = 0; i < 100 && w.notifies === notified; i++) await new Promise<void>(r => setTimeout(r, 5))
  expect(lastRun(w).steps.document).toMatchObject({ status: 'parked', findings: [{ id: 'document:timeout' }] })
  expect(w.calls.filter(c => c === 'git add -u')).toHaveLength(before + 2)
  expect(most).toBe(1)
})

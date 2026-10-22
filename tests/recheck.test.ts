import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import type { World } from './world'
import { AUTOFIX, BUG, EARLIER, EXCLUDING, FIXED, GUIDE, GUIDE_TEXT, OUTSIDE, PLUGIN, PUSH, REBASED, answer, approveAll, command, complete, earlierApprovals, historyLine, lastRun, outside, passTwo, pressOnce, seedHistoryOnWorktreeAdd, showGuide, start, world } from './world'

const RECHECK_DIFF = `git diff --no-ext-diff --no-textconv --no-color --text ${REBASED}...HEAD`
const RECHECK_LOG = `git --attr-source=origin/main log --no-ext-diff --no-textconv --no-color --text --no-show-signature --format=%h %s --stat ${REBASED}..HEAD`
const FIXED_AGAIN = 'dddd4444dddd4444dddd4444dddd4444dddd4444'
const FIXED_THRICE = 'eeee5555eeee5555eeee5555eeee5555eeee5555'
const C1 = { id: 'c1', severity: 'error', action: 'auto-fix', file: 'a.ts', line: 2, description: 'the fix breaks the empty case' } as const

const PIPELINE_LOG: Record<string, string> = {
  [FIXED]: 'cccc333 fix(no-mistakes/test): make the test check pass\n a.ts | 2 +-',
  [FIXED_AGAIN]: 'dddd444 fix(no-mistakes/recheck): fix round 1\n a.ts | 1 +\ncccc333 fix(no-mistakes/test): make the test check pass\n a.ts | 2 +-',
  [FIXED_THRICE]: 'eeee555 fix(no-mistakes/test): make the test check pass\n a.ts | 1 +\ndddd444 fix(no-mistakes/recheck): fix round 1\n a.ts | 1 +\ncccc333 fix(no-mistakes/test): make the test check pass\n a.ts | 2 +-',
}

async function toRecheck($: Engine, w: World, press?: 'approve' | 'skip'): Promise<void> {
  let failing = true
  w.rules.push(line => (line === 'sh -c npm test' ? { exitCode: failing ? 1 : 0, stdout: failing ? '1 failing' : '' } : undefined))
  w.rules.push(line => (line === RECHECK_LOG ? { stdout: PIPELINE_LOG[w.worktreeHead] ?? '' } : undefined))
  w.rules.push(line => (line === RECHECK_DIFF ? { stdout: `diff --git a/a.ts b/a.ts\n+const fixed = ${w.worktreeHead === FIXED ? 1 : 2}` } : undefined))
  await start($)
  await complete($, 'agent-1', answer(press === undefined ? [] : [{ id: 'r1', severity: 'warning', action: 'ask-user', description: 'naming' }]))
  if (press !== undefined) await pressOnce($, press)
  expect(lastRun(w).steps.test).toMatchObject({ status: 'running', agentId: 'agent-2' })
  failing = false
  w.dirty = true
  w.worktreeHead = FIXED
  await complete($, 'agent-2', answer([]))
  expect(lastRun(w).steps.test).toMatchObject({ status: 'passed' })
  await complete($, 'agent-3', answer([]))
  expect(lastRun(w).steps.lint).toMatchObject({ status: 'passed' })
}

test('the recheck reviewer gets the earlier approvals too', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [{ id: 'k1', severity: 'error', file: 'b.ts', description: 'bug' }], approveAll(['k1']))])
  await toRecheck($, w)
  expect(w.spawns[3]!.prompt).toContain('Step "recheck"')
  expect(earlierApprovals(w.spawns[3]!.prompt)).toBe('run-a review/k1 [error] b.ts: bug')
  expect(w.spawns[1]!.prompt).not.toContain(EARLIER)
})

test('the recheck is skipped when the pipeline committed nothing after the review', async ($, on) => {
  const w = world($, on)
  await start($)
  await passTwo($)
  const run = lastRun(w)
  expect(run.reviewedHead).toBe(REBASED)
  expect(run.steps.recheck).toMatchObject({ status: 'skipped', reason: 'no commits since the review' })
  expect(run.steps.push).toMatchObject({ status: 'passed' })
  expect(run.outcome).toBe('passed')
  expect(w.spawns).toHaveLength(2)
  expect(w.calls.some(c => c.includes(`${REBASED}...HEAD`))).toBe(false)
  expect(await w.pane('terminal')).toContain('- recheck  no commits since the review')
})

test('after a test fix the recheck sends the reviewer the pipeline commit and its diff alone, as untrusted data', async ($, on) => {
  const w = world($, on)
  await toRecheck($, w)
  const run = lastRun(w)
  expect(run.reviewedHead).toBe(REBASED)
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-4' })
  expect(w.spawns[3]).toMatchObject({ type: `${PLUGIN}:reviewer`, cwd: run.worktree, description: `no-mistakes recheck (${run.id}/0)` })
  const prompt = w.spawns[3]!.prompt
  expect(prompt).toContain('Step "recheck"')
  expect(prompt).toContain(`The review ran at ${REBASED.slice(0, 12)}`)
  expect(prompt).toMatch(/<(untrusted-\w+) source="commits">\ncccc333 fix\(no-mistakes\/test\): make the test check pass\n<\/\1>/)
  expect(prompt).toMatch(/<(untrusted-\w+) source="diff">[\s\S]*\+const fixed = 1[\s\S]*<\/\1>/)
  expect(prompt).not.toContain('+const x = 1')
  expect(w.calls).toContain(RECHECK_DIFF)
  expect(w.calls).toContain(`git --attr-source=origin/main diff --no-ext-diff --no-textconv --no-color --text --stat ${REBASED}...HEAD`)
  expect(await w.pane('terminal')).toContain('▸ recheck  reviewer working')
  await complete($, 'agent-4', answer([]))
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'passed', findings: [] })
  expect(w.calls).toContain(`${PUSH} ${FIXED}:refs/heads/feat --force-with-lease=refs/heads/feat:`)
  expect(lastRun(w).outcome).toBe('passed')
})

test('R6-D1: the recheck reviewer\'s unreadable answer goes to a fresh reviewer, whose findings park the recheck', async ($, on) => {
  const w = world($, on)
  await toRecheck($, w)
  await complete($, 'agent-4', 'The fix looks right.')
  const run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-5', reasked: true })
  expect(w.spawns[4]).toMatchObject({ type: `${PLUGIN}:reviewer`, cwd: run.worktree, description: `no-mistakes recheck again (${run.id}/0)` })
  expect(w.spawns[4]!.prompt).toMatch(/source="earlier answer">\nThe fix looks right\.\n/)
  await complete($, 'agent-5', answer([{ id: 'c1', severity: 'error', action: 'auto-fix', description: 'the fix broke b' }]))
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'parked', findings: [{ id: 'c1' }] })
})

test('after a review the human approved as is, the recheck reviews the pipeline commits made since', async ($, on) => {
  const w = world($, on)
  await toRecheck($, w, 'approve')
  const run = lastRun(w)
  expect(run.steps.review).toMatchObject({ status: 'passed', note: 'approved by the human' })
  expect(run.reviewedHead).toBe(REBASED)
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-4' })
  expect(w.spawns[3]!.prompt).toContain('+const fixed = 1')
})

test('after a review the human skipped, the recheck still reviews the pipeline commits made since', async ($, on) => {
  const w = world($, on)
  await toRecheck($, w, 'skip')
  const run = lastRun(w)
  expect(run.steps.review).toMatchObject({ status: 'skipped', reason: 'skipped by the human' })
  expect(run.reviewedHead).toBe(REBASED)
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-4' })
  expect(run.steps.push).toMatchObject({ status: 'pending' })
  expect(w.spawns[3]).toMatchObject({ type: `${PLUGIN}:reviewer` })
  expect(w.spawns[3]!.prompt).toContain('+const fixed = 1')
  await complete($, 'agent-4', answer([C1]))
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'parked', findings: [{ id: 'c1' }] })
  await pressOnce($, 'skip')
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'skipped', reason: 'skipped by the human' })
  expect(lastRun(w).steps.push).toMatchObject({ status: 'passed' })
})

test('the recheck diff leaves review.exclude out and the reviewer is told which', async ($, on) => {
  const w = world($, on, { config: EXCLUDING })
  await toRecheck($, w)
  expect(w.calls).toContain(`${RECHECK_DIFF} ${OUTSIDE}`)
  expect(w.calls).not.toContain(RECHECK_DIFF)
  expect(w.spawns[3]!.prompt).toMatch(/\n[^\n]*review\.exclude[^\n]*: package-lock\.json, dist\/\*\n/)
})

test('a blocking recheck finding parks the step before anything is pushed', async ($, on) => {
  const w = world($, on)
  await toRecheck($, w)
  await complete($, 'agent-4', answer([C1]))
  const run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'parked', findings: [{ id: 'c1' }] })
  expect(run.steps.push).toMatchObject({ status: 'pending' })
  expect(run.outcome).toBeUndefined()
  expect(w.notifies).toBe(1)
  expect(w.calls.some(c => c.startsWith('git push'))).toBe(false)
  const drawn = await w.pane('terminal')
  expect(drawn).toContain('Parked at recheck')
  expect(drawn).toMatch(/toggle:c1=\[x\] error +fixable a\.ts:2 the fix breaks the empty case/)
  expect((await $.command.run(command('no-mistakes-status'))).text).toContain('no-mistakes: parked at recheck')
})

test('a recheck fix round re-runs the recheck over the first pipeline commit and the round\'s commit together', async ($, on) => {
  const w = world($, on)
  await toRecheck($, w)
  await complete($, 'agent-4', answer([C1]))
  await pressOnce($, 'fix')
  let run = lastRun(w)
  expect(run.decisions).toEqual([{ step: 'recheck', findingIds: ['c1'], verdict: 'fix' }])
  expect(run.steps.recheck).toMatchObject({ status: 'fixing', agentId: 'agent-5', round: 1 })
  expect(w.spawns[4]).toMatchObject({ type: `${PLUGIN}:fixer`, description: `no-mistakes fix recheck 1 (${run.id}/1)` })
  expect(w.spawns[4]!.prompt).toContain('the fix breaks the empty case')
  w.dirty = true
  w.worktreeHead = FIXED_AGAIN
  await complete($, 'agent-5', 'Fixed.')
  run = lastRun(w)
  expect(w.calls).toContain('git commit -q -m fix(no-mistakes/recheck): fix round 1')
  expect(run.reviewedHead).toBe(REBASED)
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-6' })
  const prompt = w.spawns[5]!.prompt
  expect(w.spawns[5]).toMatchObject({ type: `${PLUGIN}:reviewer` })
  expect(prompt).toMatch(/<(untrusted-\w+) source="commits">\ndddd444 fix\(no-mistakes\/recheck\): fix round 1\ncccc333 fix\(no-mistakes\/test\): make the test check pass\n<\/\1>/)
  expect(prompt).toContain('+const fixed = 2')
  expect(prompt).toContain('the human chose to fix for findings c1')
  expect(w.calls.filter(c => c === RECHECK_DIFF)).toHaveLength(2)
  expect(w.calls.some(c => c.includes(`${FIXED}...HEAD`))).toBe(false)
  await complete($, 'agent-6', answer([]))
  run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'passed' })
  expect(w.calls).toContain(`${PUSH} ${FIXED_AGAIN}:refs/heads/feat --force-with-lease=refs/heads/feat:`)
  expect(run.outcome).toBe('passed')
})

test('under autofix, a recheck that parks on auto-fix findings alone goes to the fixer as the pipeline\'s decision', async ($, on) => {
  const w = world($, on, { config: AUTOFIX })
  await toRecheck($, w)
  await complete($, 'agent-4', answer([C1]))
  const run = lastRun(w)
  expect(run.decisions).toEqual([{ step: 'recheck', findingIds: ['c1'], verdict: 'fix', isAuto: true }])
  expect(run.steps.recheck).toMatchObject({ status: 'fixing', agentId: 'agent-5', round: 1 })
  expect(w.notifies).toBe(0)
  expect(w.spawns[4]!.prompt).toContain('The pipeline chose to fix these findings')
  expect(await w.pane('terminal')).toContain('▸ recheck  auto-fixing (fix round 1)')
  expect((await $.command.run(command('no-mistakes-status'))).text).toContain('no-mistakes: auto-fixing recheck (round 1)')
})

test('a run stored before the recheck step existed loads with it skipped, runs on and reports', async ($, on) => {
  const w = world($, on, { legacy: true, gh: true })
  await start($)
  await passTwo($)
  const run = lastRun(w)
  expect(run.steps.recheck).toBeUndefined()
  expect(run.reviewedHead).toBeUndefined()
  expect(run.steps.push).toMatchObject({ status: 'passed' })
  expect(run.steps.pr).toMatchObject({ status: 'passed' })
  expect(run.steps.ci).toMatchObject({ status: 'running' })
  expect(w.spawns).toHaveLength(2)
  const drawn = await w.pane('terminal')
  expect(drawn).toContain('- recheck  run started before the recheck step existed')
  expect(drawn).toContain('▸ ci       waiting on checks')
  expect((await $.command.run(command('no-mistakes-status'))).text).toContain('no-mistakes: ci…')
  expect(w.completions[w.completions.length - 1]).toContain('- lint: passed\n- recheck: skipped (run started before the recheck step existed)\n- push: passed')
})

test('the PR body prompt lists the recheck between lint and push', async ($, on) => {
  const w = world($, on, { gh: true })
  await toRecheck($, w)
  await complete($, 'agent-4', answer([]))
  expect(lastRun(w).steps.pr).toMatchObject({ status: 'passed' })
  expect(w.completions[w.completions.length - 1]).toContain('- lint: passed\n- recheck: passed\n- push: passed')
})

test('the recheck fails closed when the pipeline\'s commits cannot be listed', async ($, on) => {
  const w = world($, on)
  w.rules.push(line => (line.replace('git --attr-source=origin/main ', 'git ').startsWith('git log') ? { exitCode: 128, stderr: 'fatal: bad revision' } : undefined))
  await toRecheck($, w)
  const run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'failed', reason: expect.stringContaining('cannot list the pipeline\'s commits') })
  expect(run.note).toContain('fatal: bad revision')
  expect(run.outcome).toBe('failed')
  expect(w.spawns).toHaveLength(3)
  expect(w.calls.some(c => c.startsWith('git push'))).toBe(false)
})

test('a recheck fix round runs the test and lint commands again on the round\'s commit, and a failing re-run goes to the fixer, before the recheck reads them', async ($, on) => {
  const w = world($, on)
  let failAgain = false
  w.rules.push(line => (failAgain && line === 'sh -c npm test' ? { exitCode: 1, stdout: '2 failing' } : undefined))
  await toRecheck($, w)
  await complete($, 'agent-4', answer([C1]))
  await pressOnce($, 'fix')
  expect(w.calls.filter(c => c === 'sh -c npm test')).toHaveLength(2)
  expect(w.calls.filter(c => c === 'sh -c npm run lint')).toHaveLength(1)
  failAgain = true
  w.dirty = true
  w.worktreeHead = FIXED_AGAIN
  await complete($, 'agent-5', 'Fixed.')
  let run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'pending' })
  expect(run.steps.test).toMatchObject({ status: 'running', agentId: 'agent-6' })
  expect(run.steps.document).toMatchObject({ status: 'passed' })
  expect(w.calls.filter(c => c === 'sh -c npm test')).toHaveLength(3)
  expect(w.spawns[5]).toMatchObject({ type: `${PLUGIN}:fixer`, description: `no-mistakes test (${run.id}/1)` })
  expect(w.spawns[5]!.prompt).toContain('2 failing')
  expect(await w.pane('terminal')).toContain('▸ test     fixer working')
  failAgain = false
  w.dirty = true
  w.worktreeHead = FIXED_THRICE
  await complete($, 'agent-6', answer([]))
  run = lastRun(w)
  expect(w.calls).toContain('git commit -q -m fix(no-mistakes/test): make the test check pass')
  expect(run.steps.test).toMatchObject({ status: 'passed', note: 'npm test exited 0' })
  expect(run.steps.lint).toMatchObject({ status: 'passed' })
  expect(w.calls.filter(c => c === 'sh -c npm test')).toHaveLength(4)
  expect(w.calls.filter(c => c === 'sh -c npm run lint')).toHaveLength(2)
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-7' })
  expect(w.spawns[6]).toMatchObject({ type: `${PLUGIN}:reviewer` })
  expect(w.spawns[6]!.prompt).toMatch(/<(untrusted-\w+) source="commits">\neeee555 fix\(no-mistakes\/test\): make the test check pass\ndddd444 fix\(no-mistakes\/recheck\): fix round 1\ncccc333 fix\(no-mistakes\/test\): make the test check pass\n<\/\1>/)
  expect(run.decisions).toEqual([{ step: 'recheck', findingIds: ['c1'], verdict: 'fix' }])
  await complete($, 'agent-7', answer([]))
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'passed' })
  expect(w.calls).toContain(`${PUSH} ${FIXED_THRICE}:refs/heads/feat --force-with-lease=refs/heads/feat:`)
  expect(lastRun(w).outcome).toBe('passed')
})

test('a recheck fix round leaves a test step the human approved as it is, and runs lint again', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  lint: npm run lint\n' })
  let failing = true
  w.rules.push(line => (line === 'sh -c npm run lint' ? { exitCode: failing ? 1 : 0, stdout: failing ? '1 problem' : '' } : undefined))
  w.rules.push(line => (line === RECHECK_LOG ? { stdout: PIPELINE_LOG[w.worktreeHead] ?? '' } : undefined))
  await start($)
  await complete($, 'agent-1', answer([]))
  expect(lastRun(w).steps.test).toMatchObject({ status: 'parked', findings: [{ id: 'test:no-command' }] })
  await pressOnce($, 'approve')
  await complete($, 'agent-2', answer([]))
  expect(lastRun(w).steps.lint).toMatchObject({ status: 'running', agentId: 'agent-3' })
  failing = false
  w.dirty = true
  w.worktreeHead = FIXED
  await complete($, 'agent-3', answer([]))
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-4' })
  await complete($, 'agent-4', answer([C1]))
  await pressOnce($, 'fix')
  w.dirty = true
  w.worktreeHead = FIXED_AGAIN
  await complete($, 'agent-5', 'Fixed.')
  const run = lastRun(w)
  expect(run.steps.test).toMatchObject({ status: 'passed', note: 'approved by the human' })
  expect(w.calls.filter(c => c === 'sh -c npm run lint')).toHaveLength(3)
  expect(run.steps.lint).toMatchObject({ status: 'passed' })
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-6' })
  expect(w.spawns[5]).toMatchObject({ type: `${PLUGIN}:reviewer` })
  expect(run.decisions).toEqual([
    { step: 'test', findingIds: ['test:no-command'], verdict: 'approve' },
    { step: 'recheck', findingIds: ['c1'], verdict: 'fix' },
  ])
})

test('the review run again after a review fix round re-stamps the reviewed head, so a recheck with nothing after it is skipped', async ($, on) => {
  const w = world($, on, { config: AUTOFIX })
  await start($)
  await complete($, 'agent-1', answer([BUG]))
  expect(lastRun(w).steps.review).toMatchObject({ status: 'fixing', agentId: 'agent-2', round: 1 })
  w.dirty = true
  w.worktreeHead = FIXED
  await complete($, 'agent-2', 'Fixed.')
  let run = lastRun(w)
  expect(run.steps.review).toMatchObject({ status: 'running', agentId: 'agent-3' })
  expect(run.reviewedHead).toBe(FIXED)
  await complete($, 'agent-3', answer([]))
  await complete($, 'agent-4', answer([]))
  run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'skipped', reason: 'no commits since the review' })
  expect(w.spawns).toHaveLength(4)
  expect(w.calls.some(c => c.includes(`${REBASED}...HEAD`))).toBe(false)
  expect(w.calls).toContain(`${PUSH} ${FIXED}:refs/heads/feat --force-with-lease=refs/heads/feat:`)
  expect(run.outcome).toBe('passed')
})

test('the recheck fails closed when the worktree HEAD cannot be read', async ($, on) => {
  const w = world($, on)
  let broken = false
  w.rules.push((line, cwd) => {
    if (line === 'sh -c npm run lint') broken = true
    return broken && line === 'git rev-parse --verify HEAD' && cwd !== '/repo' ? { exitCode: 128, stderr: 'fatal: bad revision' } : undefined
  })
  await toRecheck($, w)
  const run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'failed', reason: 'cannot read the worktree HEAD' })
  expect(run.outcome).toBe('failed')
  expect(w.spawns).toHaveLength(3)
  expect(w.calls.some(c => c.startsWith('git push'))).toBe(false)
})

test('the recheck reviewer gets the guide before the commits, and the fixers and the PR body writer around it do not', async ($, on) => {
  const w = world($, on, { config: GUIDE, gh: true })
  w.rules.push(showGuide(GUIDE_TEXT))
  await toRecheck($, w)
  const prompt = w.spawns[3]!.prompt
  expect(outside(prompt)).toContain(`docs/REVIEW.md on origin/main. Apply it as the standards of the author's team; the author's intent and the recorded decisions still outrank it:\n${GUIDE_TEXT}`)
  expect(prompt.indexOf(GUIDE_TEXT)).toBeLessThan(prompt.indexOf('source="commits"'))
  await complete($, 'agent-4', answer([C1]))
  await pressOnce($, 'fix')
  w.dirty = true
  w.worktreeHead = FIXED_AGAIN
  await complete($, 'agent-5', 'Fixed.')
  await complete($, 'agent-6', answer([]))
  expect(lastRun(w).steps.pr).toMatchObject({ status: 'passed' })
  expect(w.spawns.map(s => s.prompt.includes(GUIDE_TEXT))).toEqual([true, false, false, true, false, true])
  expect(w.completions[w.completions.length - 1]).not.toContain(GUIDE_TEXT)
})

test('a recheck fix round runs the test command again when the test step passed after a human fix round', async ($, on) => {
  const w = world($, on)
  let tests = 0
  w.rules.push(line => (line === 'sh -c npm test' && ++tests <= 2 ? { exitCode: 1, stdout: '1 failing' } : undefined))
  w.rules.push(line => (line === RECHECK_LOG ? { stdout: PIPELINE_LOG[w.worktreeHead] ?? '' } : undefined))
  await start($)
  await complete($, 'agent-1', answer([]))
  w.dirty = true
  w.worktreeHead = FIXED
  await complete($, 'agent-2', answer([]))
  expect(lastRun(w).steps.test).toMatchObject({ status: 'parked', findings: [{ id: 'test:command' }] })
  await pressOnce($, 'fix')
  w.dirty = true
  await complete($, 'agent-3', 'Fixed.')
  expect(lastRun(w).steps.test).toMatchObject({ status: 'passed', note: 'npm test exited 0' })
  await complete($, 'agent-4', answer([]))
  expect(lastRun(w).steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-5' })
  await complete($, 'agent-5', answer([C1]))
  await pressOnce($, 'fix')
  w.dirty = true
  w.worktreeHead = FIXED_AGAIN
  await complete($, 'agent-6', 'Fixed.')
  const run = lastRun(w)
  expect(run.decisions).toEqual([
    { step: 'test', findingIds: ['test:command'], verdict: 'fix' },
    { step: 'recheck', findingIds: ['c1'], verdict: 'fix' },
  ])
  expect(tests).toBe(4)
  expect(run.steps.test).toMatchObject({ status: 'passed', note: 'npm test exited 0' })
  expect(run.steps.recheck).toMatchObject({ status: 'running', agentId: 'agent-7' })
})

test('the recheck fails closed when git cannot produce the recheck diff', async ($, on) => {
  const w = world($, on)
  w.rules.push(line => (line === RECHECK_DIFF ? { exitCode: 128, stderr: 'fatal: bad object' } : undefined))
  await toRecheck($, w)
  const run = lastRun(w)
  expect(run.steps.recheck).toMatchObject({ status: 'failed', reason: expect.stringContaining('cannot read the pipeline\'s commits to recheck') })
  expect(run.note).toContain('git diff failed: fatal: bad object')
  expect(run.outcome).toBe('failed')
  expect(w.spawns).toHaveLength(3)
  expect(w.calls.some(c => c.startsWith('git push'))).toBe(false)
})

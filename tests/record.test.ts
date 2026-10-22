import { expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import type { PriorFinding } from './world'
import { EARLIER, PLUGIN, answer, approveAll, command, complete, earlierApprovals, historyLine, lastRun, outside, passTwo, pressOnce, say, seedHistoryOnWorktreeAdd, start, world } from './world'

// The real timer of the test runtime, for work the mocked clock must not see.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const PASSED_STEPS = { rebase: 'passed', review: 'passed', test: 'passed', document: 'passed', lint: 'passed', recheck: 'skipped', push: 'passed', pr: 'skipped', ci: 'skipped' }
const statuses = (run: Run) => Object.fromEntries(Object.entries(run.steps).map(([name, step]) => [name, step.status]))

test('every change of the run rewrites latest.json in the record directory with the run as stored', async ($, on) => {
  const w = world($, on)
  await start($)
  const run = lastRun(w)
  expect(run.recordDir).toMatch(/^\/home\/u\/\.cache\/no-mistakes\/repo-[0-9a-f]{8}$/)
  expect(run.worktree).toBe(`${run.recordDir}/${run.id}/wt`)
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'bug' }]))
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
  expect(w.writes.length).toBeGreaterThan(3)
  expect(new Set(w.writes.map(x => x.path))).toEqual(new Set([`${run.recordDir}/latest.json`]))
  expect(w.writes.map(x => JSON.parse(x.text))).toEqual(w.runs)
})

test('a finished run is appended to history.jsonl with its follow-ups and an endedAt time, one line per run', async ($, on) => {
  const w = world($, on)
  await start($)
  await passTwo($)
  const first = lastRun(w)
  expect(first.outcome).toBe('passed')
  expect(first.followUps?.length).toBeGreaterThan(0)
  const history = `${first.recordDir}/history.jsonl`
  const lines = w.files[history]!.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  const held = JSON.parse(lines[0]!)
  expect(typeof held.endedAt).toBe('number')
  expect(held).toEqual({ ...first, endedAt: held.endedAt })
  await $.command.run(command(PLUGIN, 'add y'))
  for (const id of ['agent-3', 'agent-4']) await complete($, id, answer([]))
  const second = lastRun(w)
  expect(second.id).not.toBe(first.id)
  expect(second.outcome).toBe('passed')
  const both = w.files[history]!.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Run)
  expect(both.map(r => r.id)).toEqual([first.id, second.id])
})

test('a run started while the last one cleans up leaves the finished run, not itself, in history.jsonl', async ($, on) => {
  const w = world($, on)
  await start($)
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  let removing!: () => void
  const removal = new Promise<void>(r => { removing = r })
  w.rules.push(async line => {
    if (!line.startsWith('git worktree remove')) return undefined
    removing()
    await held
    return undefined
  })
  const first = passTwo($)
  await removal
  const finished = lastRun(w)
  expect(finished.outcome).toBe('passed')
  await $.command.run(command(PLUGIN, 'add y'))
  expect(lastRun(w).id).not.toBe(finished.id)
  release()
  await first
  const history = `${finished.recordDir}/history.jsonl`
  const lines = w.files[history]!.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Run & { endedAt: number })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ id: finished.id, outcome: 'passed' })
  expect(lines[0]!.followUps?.length).toBeGreaterThan(0)
})

test('a slow record write does not let a later state land in latest.json before an earlier one', async ($, on) => {
  const w = world($, on)
  await start($)
  const settled = (ready: () => boolean) => new Promise<void>((done, fail) => {
    let left = 500
    const look = () => (ready() ? done() : --left > 0 ? setTimeout(look, 2) : fail(new Error('the run did not move on')))
    look()
  })
  let release!: () => void
  w.holdWrite = new Promise<void>(r => { release = r })
  const parking = complete($, 'agent-1', answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'bug' }]))
  await settled(() => lastRun(w).steps.review.status === 'parked')
  const aborting = say($, 'no-mistakes-abort')
  await settled(() => lastRun(w).outcome === 'aborted')
  release()
  await Promise.all([parking, aborting])
  const latest = `${lastRun(w).recordDir}/latest.json`
  expect(w.writes.filter(x => x.path === latest).map(x => JSON.parse(x.text))).toEqual(w.runs)
  expect(JSON.parse(w.files[latest]!)).toEqual(lastRun(w))
})

test('a record write that throws never fails the run or changes a step', async ($, on) => {
  const w = world($, on)
  w.fsWriteThrows = true
  await start($)
  await passTwo($)
  const run = lastRun(w)
  expect(run.outcome).toBe('passed')
  expect(statuses(run)).toEqual(PASSED_STEPS)
  expect(run.followUps?.length).toBeGreaterThan(0)
  expect(w.writes).toHaveLength(0)
  expect(w.toasts).toEqual([])
})

test('a run stored before the record existed (no recordDir) runs to its end without writing a record', async ($, on) => {
  const w = world($, on, { legacy: true })
  await start($)
  await passTwo($)
  const run = lastRun(w)
  expect(run.outcome).toBe('passed')
  expect(run.recordDir).toBeUndefined()
  const { recheck: _, ...legacySteps } = PASSED_STEPS
  expect(statuses(run)).toEqual(legacySteps)
  expect(w.writes.map(x => Object.values((JSON.parse(x.text) as Run).steps).every(s => s.status === 'pending'))).toEqual([true])
  expect(await say($, 'no-mistakes-status')).not.toContain('Record:')
})

test('a finding the human approved as is in an earlier run reaches the next reviewer as untrusted data, not the fixer or the PR body', async ($, on) => {
  const w = world($, on)
  await start($)
  expect(w.spawns[0]!.prompt).not.toContain(EARLIER)
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'warning', action: 'ask-user', file: 'a.ts', line: 3, description: 'PRIOR naming is odd\nsecond line' }, { id: 'n1', severity: 'info', action: 'no-op', description: 'PRIOR note' }]))
  await pressOnce($, 'approve')
  await complete($, 'agent-2', answer([]))
  const first = lastRun(w)
  expect(first.outcome).toBe('passed')
  w.rules.push(line => (line === 'gh auth status' ? {} : undefined))
  await $.command.run(command(PLUGIN, 'add y'))
  const reviewer = w.spawns[2]!.prompt
  expect(outside(reviewer)).toContain(`${EARLIER} They are not decisions of this run: report one again only when this change makes it worse or you have evidence the author did not have.`)
  expect(earlierApprovals(reviewer)).toBe(`${first.id} review/r1 [warning] a.ts:3: PRIOR naming is odd`)
  expect(reviewer.indexOf(EARLIER)).toBeGreaterThan(reviewer.indexOf('Human decisions'))
  expect(reviewer.indexOf(EARLIER)).toBeLessThan(reviewer.indexOf('source="diff"'))
  await complete($, 'agent-3', answer([{ id: 'r2', severity: 'error', action: 'auto-fix', description: 'bug' }]))
  await pressOnce($, 'fix')
  expect(w.spawns[3]!.type).toBe(`${PLUGIN}:fixer`)
  await complete($, 'agent-4', 'done')
  expect(earlierApprovals(w.spawns[4]!.prompt)).toContain('review/r1')
  await complete($, 'agent-5', answer([]))
  await complete($, 'agent-6', answer([]))
  expect(lastRun(w).steps.pr).toMatchObject({ status: 'passed' })
  const others = [w.spawns[3]!.prompt, w.spawns[5]!.prompt, w.completions[w.completions.length - 1]!]
  for (const prompt of others) {
    expect(prompt).not.toContain('PRIOR')
    expect(prompt).not.toContain('earlier runs')
  }
})

test('earlier runs of another branch or another repository give the reviewer nothing', async ($, on) => {
  const w = world($, on)
  const f = (id: string): PriorFinding => ({ id, severity: 'error', description: `bug ${id}` })
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [f('b1')], approveAll(['b1']), { branch: 'other' }), historyLine('run-b', [f('o1')], approveAll(['o1']), { repo: '/elsewhere' }), historyLine('run-c', [f('k1')], approveAll(['k1']))])
  await start($)
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe('run-c review/k1 [error]: bug k1')
})

test('an approval the pipeline made, and a finding the human sent to the fixer or skipped, are not earlier approvals', async ($, on) => {
  const w = world($, on)
  const f = (id: string): PriorFinding => ({ id, severity: 'warning', description: `odd ${id}` })
  const decisions = [{ step: 'review', findingIds: ['a1'], verdict: 'approve', isAuto: true }, { step: 'review', findingIds: ['x1'], verdict: 'fix' }, { step: 'review', findingIds: ['s1'], verdict: 'skip' }, { step: 'review', findingIds: ['k1'], verdict: 'approve' }]
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [f('a1'), f('x1'), f('s1'), f('k1')], decisions)])
  await start($)
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe('run-a review/k1 [warning]: odd k1')
})

test('an informational finding approved with the rest is not an earlier approval', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [{ id: 'i1', severity: 'info', action: 'no-op', description: 'a note' }, { id: 'w1', severity: 'warning', description: 'naming' }], approveAll(['i1', 'w1']))])
  await start($)
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe('run-a review/w1 [warning]: naming')
})

test('a history line that does not parse or holds no run is skipped and the review still runs', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, ['{"id": "run-x", "repo": "/re', 'null', '7', JSON.stringify({ id: 'run-y', repo: '/repo', branch: 'feat', decisions: 'none' }), JSON.stringify({ id: 'run-z', repo: '/repo', branch: 'feat', steps: {}, decisions: approveAll(['z1']) }), historyLine('run-a', [{ id: 'k1', severity: 'error', description: 'bug' }], approveAll(['k1']))])
  await start($)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe('run-a review/k1 [error]: bug')
})

test('a history that cannot be read gives the reviewer no earlier approvals and the review still runs', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [{ id: 'k1', severity: 'error', description: 'bug' }], approveAll(['k1']))])
  w.historyUnreadable = true
  await start($)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
  expect(w.spawns[0]!.prompt).not.toContain(EARLIER)
})

test('a run stored before the record existed (no recordDir) gives the reviewer no earlier approvals', async ($, on) => {
  const w = world($, on, { legacy: true })
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [{ id: 'k1', severity: 'error', description: 'bug' }], approveAll(['k1']))])
  await start($)
  expect(lastRun(w).recordDir).toBeUndefined()
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
  expect(w.spawns[0]!.prompt).not.toContain(EARLIER)
  expect(w.fsPaths.filter(path => path.endsWith('history.jsonl'))).toEqual([])
})

test('the reviewer gets the newest 40 earlier approvals and is told how many there were', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, Array.from({ length: 45 }, (_, i) => historyLine(`run-${i}`, [{ id: `p${i}`, severity: 'warning', description: `finding ${i}` }], approveAll([`p${i}`]))))
  await start($)
  const prompt = w.spawns[0]!.prompt
  expect(outside(prompt)).toContain(' Only the newest 40 of 45 are listed.')
  const listed = earlierApprovals(prompt)!.split('\n')
  expect(listed).toHaveLength(40)
  expect(listed[0]).toBe('run-44 review/p44 [warning]: finding 44')
  expect(listed[39]).toBe('run-5 review/p5 [warning]: finding 5')
})

test('two earlier runs that approved different findings under the same id both reach the reviewer', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, [historyLine('run-old', [{ id: 'r1', severity: 'error', file: 'a.ts', line: 3, description: 'OLD finding' }], approveAll(['r1'])), historyLine('run-new', [{ id: 'r1', severity: 'warning', file: 'b.ts', line: 9, description: 'NEW finding' }], approveAll(['r1']))])
  await start($)
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe('run-new review/r1 [warning] b.ts:9: NEW finding\nrun-old review/r1 [error] a.ts:3: OLD finding')
})

test('the same finding approved in several earlier runs is listed once, from the newest', async ($, on) => {
  const w = world($, on)
  const same = (severity: 'error' | 'warning', rest: string): PriorFinding => ({ id: 'd1', severity, file: 'a.ts', line: 3, description: `same wording\n${rest}` })
  seedHistoryOnWorktreeAdd(w, [historyLine('run-old', [same('error', 'OLD detail')], approveAll(['d1'])), historyLine('run-new', [same('warning', 'NEW detail')], approveAll(['d1']))])
  await start($)
  const prompt = w.spawns[0]!.prompt
  expect(earlierApprovals(prompt)).toBe('run-new review/d1 [warning] a.ts:3: same wording')
  expect(outside(prompt)).not.toContain('are listed')
})

test('a decision naming a step the earlier run does not hold is skipped, and the run\'s other approvals still reach the reviewer', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [{ id: 'k1', severity: 'error', description: 'bug' }], [{ step: 'lint', findingIds: ['l1'], verdict: 'approve' }, ...approveAll(['k1'])])])
  await start($)
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe('run-a review/k1 [error]: bug')
})

test('an earlier approval with a long description is listed with its first 200 characters', async ($, on) => {
  const w = world($, on)
  seedHistoryOnWorktreeAdd(w, [historyLine('run-a', [{ id: 'k1', severity: 'error', description: `${'x'.repeat(200)}TAIL\nsecond line` }, { id: 'k2', severity: 'error', description: 'y'.repeat(200) }], approveAll(['k1', 'k2']))])
  await start($)
  expect(earlierApprovals(w.spawns[0]!.prompt)).toBe(`run-a review/k1 [error]: ${'x'.repeat(200)}...\nrun-a review/k2 [error]: ${'y'.repeat(200)}`)
})

import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import { cells } from '../hooks/fire'
import type { World } from './world'
import { PANE_PROPS, PLUGIN, PUSH, REBASE, answer, command, complete, lastRun, mountPane, outside, parkReview, pressOnce, reply, say, start, world } from './world'

// The real timer of the test runtime, for work the mocked clock must not see.
declare const setTimeout: (fn: () => void, ms: number) => unknown

test('the pane is redrawn on every tick while a step runs, and not once the run has ended', async ($, on) => {
  const w = world($, on)
  await start($)
  const before = w.invalidates
  await w.clock.advance(30_000)
  expect(w.invalidates).toBe(before + 1)
  await pressOnce($, 'abort')
  expect(lastRun(w).outcome).toBe('aborted')
  const after = w.invalidates
  await w.clock.advance(60_000)
  expect(w.invalidates).toBe(after)
})

const rowColour = async ($: Engine, text: string): Promise<unknown> => {
  const ui = await mountPane($, 'terminal')
  const row = (await ui.findAll({ type: 'Text' })).find(found => found.text?.includes(text))
  await ui.unmount()
  return row?.props.color
}

test('a running step shows its clock, and warns before the 30 minute timeout', async ($, on) => {
  const w = world($, on)
  await start($)
  await w.clock.advance(12 * 60_000)
  expect(await w.pane('terminal')).toContain('reviewer working · 12m of 30m')
  expect(await rowColour($, 'reviewer working · 12m')).toBe('claude')
  await w.clock.advance(15 * 60_000)
  expect(await w.pane('terminal')).toContain('reviewer working · 27m of 30m, times out in 3m')
  expect(await rowColour($, 'reviewer working · 27m')).toBe('warning')
})

test('a failed step shows its first line and the last four lines of a longer reason', async ($, on) => {
  const w = world($, on)
  const conflicts = [1, 2, 3, 4, 5, 6].map(n => `CONFLICT ${n}: file${n}.ts`)
  w.rules.push(line => (line === REBASE ? { exitCode: 1, stderr: conflicts.join('\n') } : undefined))
  await start($)
  expect(lastRun(w).steps.rebase).toMatchObject({ status: 'failed' })
  const drawn = (await w.pane('terminal')).split('\n')
  expect(drawn).toContain('…')
  for (const line of conflicts.slice(2)) expect(drawn).toContain(line)
  for (const line of conflicts.slice(0, 2)) expect(drawn).not.toContain(line)
})

test('a parked step keeps its findings once the run ends', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  await pressOnce($, 'abort')
  expect(lastRun(w).outcome).toBe('aborted')
  const lines = (await w.pane('terminal')).split('\n')
  expect(lines).toContain('Run aborted at review')
  expect(lines).toContain('! review   1 finding, 1 blocking')
})

test('a step still running when the run ends reads stopped', async ($, on) => {
  const w = world($, on)
  await start($)
  await pressOnce($, 'abort')
  expect(lastRun(w).outcome).toBe('aborted')
  expect((await w.pane('terminal')).split('\n')).toContain('- review   stopped')
})

test('a running run draws its header, its steps and Abort alone; a parked one adds the call', async ($, on) => {
  const w = world($, on)
  await start($)
  let lines = (await w.pane('terminal')).split('\n')
  expect(lines).toContain('feat → main')
  expect(lines).toContain('add x')
  expect(lines).toContain(lastRun(w).worktree)
  expect(lines).toContain('✓ rebase   rebased onto origin/main')
  expect(lines).toContain('▸ review   reviewer working · <1m of 30m')
  expect(lines).toContain('abort=Abort')
  expect(lines.some(line => line.startsWith('fix='))).toBe(false)

  await complete($, 'agent-1', answer([
    { id: 'r1', severity: 'error', action: 'auto-fix', file: 'a.ts', line: 3, description: 'off by one' },
    { id: 'r2', severity: 'warning', action: 'ask-user', description: 'is a 5s max delay right?' },
    { id: 'r3', severity: 'info', action: 'no-op', description: 'retry count is a literal' },
  ]))
  lines = (await w.pane('terminal')).split('\n')
  expect(lines).toContain('! review   3 findings, 2 blocking')
  expect(lines).toContain('Parked at review · 3 of 3 fix rounds left')
  expect(lines).toContain('toggle:r1=[x] error   fixable a.ts:3 off by one')
  expect(lines).toContain('toggle:r2=[x] warning your call is a 5s max delay right?')
  expect(lines).toContain('toggle:r3=[ ] info    no action retry count is a literal')
  expect(lines).toEqual(expect.arrayContaining(['fix=Fix selected (2)', 'approve=Approve', 'skip=Skip step', 'abort=Abort']))
})

test('Fix selected counts the findings it sends before the press, and the findings carry hotkeys', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([
    { id: 'r1', severity: 'error', action: 'auto-fix', description: 'off by one' },
    { id: 'r2', severity: 'warning', action: 'ask-user', description: 'naming' },
  ]))
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'fix' }))?.text).toBe('Fix selected (2)')
  expect((await ui.find({ key: 'toggle:r1' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'toggle:r2' }))?.props.hotkey).toBe('2')
  await ui.press({ key: 'toggle:r2' })
  expect((await ui.find({ key: 'fix' }))?.text).toBe('Fix selected (1)')
  await ui.press({ key: 'toggle:r1' })
  const fix = await ui.find({ key: 'fix' })
  expect(fix?.text).toBe('Fix selected (0)')
  expect(fix?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('the pane counts the fix rounds left, and says so on Fix once none is', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  for (let round = 1; round <= 3; round++) {
    await pressOnce($, 'fix')
    await complete($, `agent-${2 * round}`, 'Fixed.')
    await complete($, `agent-${2 * round + 1}`, answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'bug' }]))
    if (round === 1) expect(await w.pane('terminal')).toContain('Parked at review · 2 of 3 fix rounds left')
  }
  const drawn = await w.pane('terminal')
  expect(drawn).toContain('Parked at review · no fix rounds left')
  expect(drawn).toContain('fix=Fix selected (no rounds left)')
})

test('the hint about focus shows on an unfocused terminal and nowhere else', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  expect(await w.pane('terminal')).toContain('Keys work after ctrl+x tab focuses the pane.')
  expect(await w.pane('terminal', { isFocused: true })).not.toContain('ctrl+x tab')
  expect(await w.pane('desktop')).not.toContain('ctrl+x tab')
})

test('/balrog-status reopens the pane and reports the run', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(command('balrog-status'))).text).toContain('No run yet')
  await $.command.run(command(PLUGIN, 'add x'))
  const text = (await $.command.run(command('balrog-status'))).text
  expect(text).toContain('balrog: review…')
  expect(text).toContain(lastRun(w).worktree)
  expect(text?.split('\n').pop()).toBe(`Record: ${lastRun(w).recordDir}/latest.json`)
})

const holdPush = async ($: Engine, w: World): Promise<{ release: () => Promise<void> }> => {
  let open: (() => void) | undefined
  let reached: (() => void) | undefined
  const gate = new Promise<void>(r => { open = r })
  const pushing = new Promise<void>(r => { reached = r })
  w.rules.push(async line => (line.startsWith(PUSH) ? (reached!(), await gate, {}) : undefined))
  await start($)
  await complete($, 'agent-1', answer([]))
  const last = complete($, 'agent-2', answer([]))
  await pushing
  expect(lastRun(w).steps.push).toMatchObject({ status: 'starting' })
  return { release: async () => { open!(); await last } }
}

test('the pane toasts a refused press, and stays quiet on a press that is carried out', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  await pressOnce($, 'toggle:r1')
  await pressOnce($, 'fix')
  expect(w.toasts).toEqual(['Select at least one finding of review to fix, in the pane or with /balrog-fix <ids>.'])
  await pressOnce($, 'approve')
  expect(lastRun(w).steps.review).toMatchObject({ status: 'passed' })
  expect(w.toasts).toHaveLength(1)
})

test('the pane toasts that an abort waits for a starting step', async ($, on) => {
  const w = world($, on)
  const push = await holdPush($, w)
  await pressOnce($, 'abort')
  expect(w.toasts).toEqual(['push is still starting; the run aborts as soon as it settles.'])
  await push.release()
  expect(lastRun(w).outcome).toBe('aborted')
})

test('/balrog-abort while a step is starting says the run aborts once it settles', async ($, on) => {
  const w = world($, on)
  const push = await holdPush($, w)
  expect(await say($, 'balrog-abort')).toBe('push is still starting; the run aborts as soon as it settles.')
  expect(lastRun(w)).toMatchObject({ abortRequested: true })
  expect(lastRun(w).outcome).toBeUndefined()
  await push.release()
  expect(lastRun(w).outcome).toBe('aborted')
})

test('a chat approve that loses to a concurrent skip says the step was decided meanwhile and records one decision', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  const texts = await Promise.all([say($, 'balrog-approve'), say($, 'balrog-skip')])
  expect(texts.filter(t => t.startsWith('balrog refused: review was decided meanwhile.'))).toHaveLength(1)
  expect(lastRun(w).decisions).toHaveLength(1)
})

test('/balrog-fix once the three fix rounds are spent is refused and spawns nothing', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  for (let round = 1; round <= 3; round++) {
    await pressOnce($, 'fix')
    await complete($, `agent-${2 * round}`, 'Fixed.')
    await complete($, `agent-${2 * round + 1}`, answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'bug' }]))
  }
  const spawned = w.spawns.length
  expect(await say($, 'balrog-fix', 'r1')).toBe('balrog refused: review already had 3 fix rounds; approve, skip or abort.')
  expect(w.spawns).toHaveLength(spawned)
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
})

test('/balrog-fix whose fixer cannot start says it could not send the findings, and the run fails', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  w.spawnThrows = 'balrog fix review'
  expect(await say($, 'balrog-fix', 'r1')).toContain('Could not send r1 of review to the fixer: could not start the fixer:')
  expect(lastRun(w).outcome).toBe('failed')
  expect(w.spawns).toHaveLength(1)
})

test('/balrog-status after a failed run gives the note and the follow-ups only as untrusted data', async ($, on) => {
  const w = world($, on)
  await start($)
  w.listThrows = true
  await complete($, 'agent-1', answer([]))
  const run = lastRun(w)
  expect(run.outcome).toBe('failed')
  expect(run.followUps?.length).toBeGreaterThan(0)
  const text = await say($, 'balrog-status')
  expect(text).toContain('Run failed at document.')
  const open = /<(untrusted-[a-z0-9]+) source="run outcome">\n/.exec(text)
  expect(open).not.toBeNull()
  const close = text.indexOf(`</${open![1]}>`)
  const body = text.slice(open!.index, close)
  const outside = text.slice(0, open!.index) + text.slice(close)
  for (const line of [run.note!, ...(run.followUps ?? []).map(f => f.text)]) {
    expect(body).toContain(line)
    expect(outside).not.toContain(line)
  }
  expect(body).not.toContain('Record:')
  expect(text.split('\n').pop()).toBe(`Record: ${run.recordDir}/latest.json`)
})

const THREE = [
  { id: 'r1', severity: 'error', action: 'auto-fix', file: 'a.ts', line: 3, description: 'off by one' },
  { id: 'r2', severity: 'warning', action: 'ask-user', description: 'naming' },
  { id: 'r3', severity: 'info', action: 'no-op', description: 'retry count is a literal' },
]

test('/balrog-fix with ids sends exactly those findings to one fixer', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer(THREE))
  const text = await say($, 'balrog-fix', 'r2, r3')
  expect(text).toContain('Sent r2, r3 of review to the fixer, round 1 of 3.')
  const run = lastRun(w)
  expect(run.decisions).toEqual([{ step: 'review', findingIds: ['r2', 'r3'], verdict: 'fix' }])
  expect(run.steps.review).toMatchObject({ status: 'fixing', agentId: 'agent-2', round: 1 })
  expect(w.spawns).toHaveLength(2)
  expect(w.spawns[1]!.prompt).toContain('retry count is a literal')
  expect(w.spawns[1]!.prompt).not.toContain('off by one')
})

test('/balrog-fix with ids that loses to a concurrent approve leaves the selection as it was', async ($, on) => {
  const w = world($, on)
  const selections: (readonly string[])[] = []
  on('state.set', { plugin: PLUGIN, key: 'selected' }, (_$, e, next) => {
    selections.push(e.value)
    return next(e)
  })
  await start($)
  await complete($, 'agent-1', answer(THREE))
  expect(selections.at(-1)).toEqual(['r1', 'r2'])
  const parked = selections.length
  const [approved, fixed] = await Promise.all([say($, 'balrog-approve'), say($, 'balrog-fix', 'r2 r3')])
  expect(approved).toContain('Approved review as is.')
  expect(fixed).toContain('balrog refused: review was decided meanwhile.')
  expect(selections).toHaveLength(parked)
  expect(lastRun(w).decisions).toEqual([{ step: 'review', findingIds: ['r1', 'r2', 'r3'], verdict: 'approve' }])
})

test('/balrog-fix with an unknown id, or with nothing selected, refuses and changes nothing', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer(THREE))
  const text = await say($, 'balrog-fix', 'r1 nope')
  expect(text).toContain('balrog refused: nope: no such finding at review; its findings are r1, r2, r3.')
  expect(lastRun(w).decisions).toEqual([])
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
  expect(w.spawns).toHaveLength(1)
  const drawn = await w.pane('terminal')
  expect(drawn).toContain('toggle:r2=[x] warning')
  expect(drawn).toContain('toggle:r3=[ ] info')

  await pressOnce($, 'toggle:r1')
  await pressOnce($, 'toggle:r2')
  expect(await say($, 'balrog-fix')).toContain('balrog refused: Select at least one finding of review to fix')
  expect(lastRun(w).decisions).toEqual([])
  expect(w.spawns).toHaveLength(1)
})

test('/balrog-approve records the decision the pane\'s Approve records and moves on', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'warning', action: 'ask-user', description: 'naming' }]))
  const text = await say($, 'balrog-approve')
  expect(text).toBe('Approved review as is. The run continues in the background; /balrog-status shows where it is.')
  const run = lastRun(w)
  expect(run.decisions).toEqual([{ step: 'review', findingIds: ['r1'], verdict: 'approve' }])
  expect(run.steps.review).toMatchObject({ status: 'passed', note: 'approved by the human', findings: [{ id: 'r1' }] })
  for (let i = 0; i < 500 && lastRun(w).steps.document.status !== 'running'; i++) await new Promise<void>(done => setTimeout(done, 2))
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
})

test('/balrog-approve replies while the next step is still starting', async ($, on) => {
  const w = world($, on)
  let open: (() => void) | undefined
  let reached: (() => void) | undefined
  const gate = new Promise<void>(r => { open = r })
  const testing = new Promise<void>(r => { reached = r })
  w.rules.push(async line => (line === 'sh -c npm test' ? (reached!(), await gate, {}) : undefined))
  await parkReview($, w)
  const reply = say($, 'balrog-approve')
  await testing
  const early = await Promise.race([reply, new Promise<string>(r => setTimeout(() => r('no reply yet'), 50))])
  const testStep = lastRun(w).steps.test
  open!()
  expect(early).toBe('Approved review as is. The run continues in the background; /balrog-status shows where it is.')
  expect(testStep).toMatchObject({ status: 'starting' })
  await reply
})

test('/balrog-abort ends the run and removes the worktree; later decisions are refused', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  expect(await say($, 'balrog-abort')).toBe('Aborted at review; /balrog-status shows what is left to do.')
  const run = lastRun(w)
  expect(run.outcome).toBe('aborted')
  expect(w.calls).toContain(`git worktree remove --force ${run.worktree}`)
  expect(await say($, 'balrog-skip')).toBe('balrog refused: The run on feat already aborted; start a new one with /balrog.')
  expect(await say($, 'balrog-status')).toContain('Run aborted at review.')
})

test('/balrog-approve, skip and abort refuse named findings instead of dropping them', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  for (const name of ['balrog-approve', 'balrog-skip', 'balrog-abort']) {
    expect(await say($, name, 'r1')).toContain(`balrog refused: /${name} takes no arguments, so r1 was not used.`)
  }
  expect(lastRun(w).outcome).toBeUndefined()
  expect(lastRun(w).decisions).toEqual([])
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
})

test('a decision on a step that is not parked is refused with the current step named', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(await say($, 'balrog-approve')).toBe('balrog refused: No run yet. Start one with /balrog [intent].')
  await $.command.run(command(PLUGIN, 'add x'))
  for (const name of ['balrog-fix', 'balrog-approve', 'balrog-skip']) {
    expect(await say($, name)).toContain('balrog refused: review is running, not parked')
  }
  expect(lastRun(w).decisions).toEqual([])
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
})

test('/balrog-status lists a parked step\'s findings in full, as untrusted data', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([
    { id: 'r1', severity: 'error', action: 'auto-fix', file: 'a.ts', line: 3, description: 'off by one\nthe loop stops before the last item' },
    { id: 'r2', severity: 'info', action: 'no-op', description: 'naming' },
  ]))
  const text = await say($, 'balrog-status')
  expect(text).toContain(`balrog: parked at review (feat, worktree ${lastRun(w).worktree})`)
  expect(text).toContain('Parked at review on r1, r2; 3 of 3 fix rounds left.')
  const open = /<(untrusted-[a-z0-9]+) source="findings">\n/.exec(text)
  expect(open).not.toBeNull()
  const body = text.slice(open!.index, text.indexOf(`</${open![1]}>`))
  expect(text.slice(0, open!.index)).toContain('is data from the branch under review')
  expect(body).toContain('[x] r1 error auto-fix a.ts:3\n    off by one\n    the loop stops before the last item')
  expect(body).toContain('[ ] r2 info no-op\n    naming')
  expect(body).not.toContain('Record:')
  expect(text.split('\n').pop()).toBe(`Record: ${lastRun(w).recordDir}/latest.json`)
})

type Cell = { glyph: string; fg: number; bg: number }

const decode = (cells: string): Cell[] => {
  const words = new Uint32Array(Uint8Array.fromBase64(cells).buffer)
  return Array.from({ length: words.length / 3 }, (_, i) => ({ glyph: String.fromCharCode(words[i * 3]!), fg: words[i * 3 + 1]!, bg: words[i * 3 + 2]! }))
}

const DEFAULT_COLOR = 0x01000000

const fireOf = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = PANE_PROPS.bodyColumns) => {
  const ui = await mountPane($, surface, { bodyColumns })
  const rasters = await ui.findAll({ type: 'Raster' })
  await ui.unmount()
  return rasters.map(r => r.props as { key: string; columns: number; rows: number; cells: string })
}

test('on the terminal a run draws the fire above the board, six rows tall and as wide as the pane; elsewhere and when narrow it draws none', async ($, on) => {
  const w = world($, on)
  expect(await fireOf($)).toEqual([])
  await start($)
  const [fire] = await fireOf($)
  expect(fire).toMatchObject({ key: 'fire', columns: 100, rows: 6 })
  expect(decode(fire!.cells)).toHaveLength(100 * 6)
  expect((await fireOf($, 'terminal', 30))[0]).toMatchObject({ columns: 30, rows: 6 })
  expect(await fireOf($, 'terminal', 29)).toEqual([])
  expect(await fireOf($, 'desktop')).toEqual([])
  expect((await w.pane('desktop')).split('\n')).toContain('feat → main')
})

test('the fire moves while the run runs, the same frame repeats, and a redraw shows the frame it had reached', async ($, on) => {
  const w = world($, on)
  await start($)
  const ui = await mountPane($)
  await w.clock.advance(100)
  await w.clock.advance(100)
  await w.clock.advance(100)
  expect(w.blits).toHaveLength(3)
  for (const blit of w.blits) expect(blit).toMatchObject({ requestId: PLUGIN, key: 'fire' })
  expect(new Set(w.blits.map(b => b.cells)).size).toBe(3)
  expect(cells({ frame: 2, columns: 100, rows: 6 }) === cells({ frame: 2, columns: 100, rows: 6 })).toBe(true)
  await w.clock.advance(30_000)
  const drawn = (await ui.find({ type: 'Raster' }))?.props.cells
  await ui.unmount()
  // The engine's 30 second redraw falls a few ticks before the clock stops.
  expect(w.blits.findIndex(b => b.cells === drawn)).toBeGreaterThan(w.blits.length - 10)
})

test('the figure rises in the first second and then stands in the flames', async ($, on) => {
  const w = world($, on)
  await start($)
  const [first] = await fireOf($)
  const ui = await mountPane($, 'terminal')
  await w.clock.advance(1_500)
  await ui.unmount()
  const eyes = (cells: string) => decode(cells).filter(c => c.fg === 0xffd27a || c.bg === 0xffd27a).length
  expect(eyes(first!.cells)).toBe(0)
  const standing = w.blits.slice(-5).map(b => eyes(b.cells))
  expect(standing).toEqual([2, 2, 2, 2, 2])
})

test('once the run ends the fire banks to still, dim embers and the blits stop', async ($, on) => {
  const w = world($, on)
  await start($)
  const ui = await mountPane($, 'terminal')
  await w.clock.advance(500)
  await ui.press({ key: 'abort' })
  expect(lastRun(w).outcome).toBe('aborted')
  await w.clock.advance(200)
  const settled = w.blits.length
  await w.clock.advance(10_000)
  expect(w.blits).toHaveLength(settled)
  const ended = (await ui.find({ type: 'Raster' }))?.props as { rows: number; cells: string }
  await ui.unmount()
  expect(ended.rows).toBe(2)
  expect((await fireOf($))[0]?.cells === ended.cells).toBe(true)
  const colors = decode(ended.cells).flatMap(c => [c.fg, c.bg]).filter(c => c !== DEFAULT_COLOR)
  expect(colors.length).toBeGreaterThan(0)
  for (const c of colors) expect(Math.max(c >> 16, (c >> 8) & 0xff, c & 0xff)).toBeLessThan(0x80)
})

test('a refused blit puts the fire out until the pane is drawn again, and closing the pane is one', async ($, on) => {
  const w = world($, on)
  await start($)
  const ui = await mountPane($)
  w.blitRefused = 'nothing of balrog is mounted there'
  await w.clock.advance(100)
  expect(w.blits).toHaveLength(1)
  w.blitRefused = undefined
  await w.clock.advance(5_000)
  expect(w.blits).toHaveLength(1)
  await ui.unmount()
  const again = await mountPane($)
  await w.clock.advance(300)
  expect(w.blits).toHaveLength(4)
  await again.unmount()
  await w.clock.advance(5_000)
  expect(w.blits).toHaveLength(5)
})

test('a parked step banks the fire to two rows so its findings keep the room', async ($, on) => {
  const w = world($, on)
  await parkReview($, w)
  expect((await fireOf($))[0]).toMatchObject({ key: 'fire', rows: 2, columns: 100 })
})

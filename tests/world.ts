import type { CommandRunInput, On, ProcessRunResult, RenderPropsOf, RenderSurface, ToolCheckResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'

import type { Run } from '../types'

export const PLUGIN = 'balrog'

export const HEAD = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
export const REBASED = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'
export const FIXED = 'cccc3333cccc3333cccc3333cccc3333cccc3333'
export const HOOKS_OFF = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false'
export const DIFF = 'git diff --no-ext-diff --no-textconv --no-color --text origin/main...HEAD'
export const REBASE = 'git rebase --no-update-refs --no-autostash origin/main'
export const PUSH = 'git push --no-follow-tags --recurse-submodules=no origin'
export const GIT_FILE = 'gitdir: /repo/.git/worktrees/wt\n'
export const FETCH_BASE = 'git fetch --no-tags --no-recurse-submodules origin +refs/heads/main:refs/remotes/origin/main'
export const CONFIG = 'commands:\n  test: "npm test"\n  lint: npm run lint\n'

export type Spawned = { type: string; prompt: string; description: string; cwd: string | undefined }

export type Reply = Partial<ProcessRunResult>
export type Rule = (line: string, cwd: string | undefined) => Reply | undefined | Promise<Reply | undefined>

export const reply = (r: Reply): ProcessRunResult => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r })

export const answer = (findings: unknown[]) => `Done.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``

export const PANE_PROPS: RenderPropsOf['Pane'] = { title: 'balrog', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

export const SURFACES = ['terminal', 'desktop'] as const

export type World = {
  calls: string[]
  raw: string[]
  spawns: Spawned[]
  runs: Run[]
  rules: Rule[]
  clock: ReturnType<typeof mock.clock>
  worktreeHead: string
  pushed: string
  dirty: boolean
  gitFile: string
  listThrows: boolean
  lists: number
  notifies: number
  invalidates: number
  blits: { requestId: string; key: string; cells: string }[]
  blitRefused: string | undefined
  stops: string[]
  stopFails: boolean
  status: Record<string, 'running' | 'completed' | 'killed'>
  foreign: Set<number>
  spawnThrows: string | undefined
  specs: Record<string, { tools?: readonly string[]; permissionMode?: string }>
  coreCheck: ToolCheckResult
  statThrows: boolean
  completions: string[]
  stdins: Record<string, string>
  ran: string[]
  recordFails: boolean
  toasts: string[]
  stopAborts: boolean
  writeFails: 'deny' | 'error' | 'throw' | undefined
  files: Record<string, string>
  writes: { path: string; text: string }[]
  fsWriteThrows: boolean
  historyUnreadable: boolean
  fsPaths: string[]
  holdWrite: Promise<void> | undefined
  pane: (surface: RenderSurface, props?: Partial<typeof PANE_PROPS>) => Promise<string>
}

export type Options = { dangling?: string[]; branch?: string; gh?: boolean; config?: string; branchConfig?: string; realPaths?: Record<string, string>; missing?: string[]; instantReview?: string; foreignReview?: true; origin?: string; legacy?: true }

export const plain = (line: string) => line.replace(/^git( -c \S+)+ /, 'git ')

export const HOST_ALLOWS = new Set(['TaskStop'])

// The terminal drawings of the pane a test holds, which the world's blit answer needs and the kit does not report.
let terminalPanes = 0

export async function mountPane($: Engine, surface: RenderSurface = 'terminal', props: Partial<typeof PANE_PROPS> = {}) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: { ...PANE_PROPS, ...props } })
  if (surface !== 'terminal') return ui
  terminalPanes++
  return { ...ui, unmount: () => ((terminalPanes -= 1), ui.unmount()) }
}

export function world($: Engine, on: On, options: Options = {}): World {
  terminalPanes = 0
  const w: World = {
    calls: [],
    raw: [],
    spawns: [],
    runs: [],
    rules: [],
    clock: mock.clock(on),
    worktreeHead: REBASED,
    pushed: '',
    dirty: false,
    gitFile: GIT_FILE,
    listThrows: false,
    lists: 0,
    notifies: 0,
    invalidates: 0,
    blits: [],
    blitRefused: undefined,
    stops: [],
    stopFails: false,
    status: {},
    foreign: new Set(),
    spawnThrows: undefined,
    specs: {},
    coreCheck: { decision: 'ask' },
    statThrows: false,
    completions: [],
    stdins: {},
    ran: [],
    recordFails: false,
    toasts: [],
    stopAborts: false,
    writeFails: undefined,
    files: {},
    writes: [],
    fsWriteThrows: false,
    historyUnreadable: false,
    fsPaths: [],
    holdWrite: undefined,
    pane: async (surface, props) => {
      const ui = await mountPane($, surface, props)
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      const buttons = (await ui.findAll({ type: 'Button' })).map(found => `${found.key ?? ''}=${found.text}`)
      await ui.unmount()
      return [...texts, ...buttons].join('\n')
    },
  }
  const branch = options.branch ?? 'feat'
  const config = options.config ?? CONFIG
  const base: Rule[] = [
    line => (line === 'git rev-parse --show-toplevel' ? { stdout: '/repo' } : undefined),
    line => (line === 'git symbolic-ref --short HEAD' ? { stdout: branch } : undefined),
    (line, cwd) => (line === 'git rev-parse --verify HEAD' ? { stdout: cwd === '/repo' ? HEAD : w.worktreeHead } : undefined),
    line => (line === 'git symbolic-ref --short refs/remotes/origin/HEAD' ? { stdout: 'origin/main' } : undefined),
    line => (line === 'git rev-parse --git-common-dir' ? { stdout: '/repo/.git' } : undefined),
    line => (line === 'git ls-remote --exit-code origin refs/heads/feat' ? (w.pushed ? { stdout: `${w.pushed}\trefs/heads/feat\n` } : { exitCode: 2 }) : undefined),
    line => {
      const m = /^git rev-list --count (\S+)\.\.(\S+)$/.exec(line)
      return m ? { stdout: m[1] === m[2] ? '0' : '2' } : line.startsWith('git rev-list --count') ? { stdout: '2' } : undefined
    },
    line => (line === 'git diff --cached --quiet' ? { exitCode: w.dirty ? 1 : 0 } : undefined),
    line => (line.startsWith('git diff --quiet') ? { exitCode: 1 } : undefined),
    line => (line.replace('git --attr-source=origin/main ', 'git ').startsWith('git diff') && line.includes('--stat') ? { stdout: ' a.ts | 2 +-' } : undefined),
    line => (line === DIFF ? { stdout: 'diff --git a/a.ts b/a.ts\n+const x = 1' } : undefined),
    line => {
      if (line.startsWith('git commit')) w.dirty = false
      return undefined
    },
    line => (line === 'git show origin/main:.balrog.yaml' ? (config === '' ? { exitCode: 128, stderr: 'path does not exist' } : { stdout: config }) : undefined),
    line => (line.startsWith('git merge-base --is-ancestor') ? {} : undefined),
    line => {
      const m = /^git push --no-follow-tags --recurse-submodules=no origin ([0-9a-f]+):refs\/heads\//.exec(line)
      if (m) w.pushed = m[1]!
      return undefined
    },
    line => (line === 'sh -c npm test' || line === 'sh -c npm run lint' ? {} : undefined),
    line => (line === 'gh auth status' ? (options.gh ? {} : { exitCode: 1, stderr: 'You are not logged into any GitHub hosts' }) : undefined),
    line => (line === 'git remote get-url origin' ? { stdout: options.origin ?? 'git@github.com:o/r.git' } : undefined),
    line => (line === 'gh pr view 7 --json headRefOid --repo o/r' ? { stdout: JSON.stringify({ headRefOid: w.pushed }) } : undefined),
    line => (line.startsWith('gh pr list') ? { stdout: '[]' } : undefined),
    line => (line.startsWith('gh pr view') ? { exitCode: 1, stderr: 'no pull requests found' } : undefined),
    line => (line.startsWith('gh pr create') ? { stdout: 'https://github.com/o/r/pull/7' } : undefined),
    line => (line.startsWith('gh pr checks') ? { stdout: '[]' } : undefined),
    line => (line.startsWith('gh run list') ? { stdout: '[]' } : undefined),
  ]
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => {
    const spec = e as unknown as { tools?: readonly string[]; permissionMode?: string }
    w.specs[e.name] = { tools: spec.tools, permissionMode: spec.permissionMode }
    return { value: { agent: `${PLUGIN}:${e.name}` } }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  // From Claude Code 2.1.307 the kit holds the mod's own `$.tool.call` to this verdict.
  on('tool.check', (_$, e) => (HOST_ALLOWS.has(e.tool) ? { decision: 'allow' as const } : w.coreCheck))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.notify', () => {
    w.notifies++
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('ui.invalidate', (_$, e, next) => {
    w.invalidates++
    return next(e)
  })
  // The kit has no implementation behind a blit, so the world answers as the host does.
  on('ui.blit', (_$, e) => {
    if ('cells' in e) w.blits.push({ requestId: e.requestId, key: e.key, cells: e.cells })
    const deny = w.blitRefused ?? (terminalPanes === 0 ? 'nothing of balrog is mounted there' : undefined)
    return { value: deny === undefined ? {} : { deny } }
  })
  on('fs.exists', (_$, e) => {
    w.fsPaths.push(e.path)
    return { value: e.path in w.files || (!e.path.endsWith('/history.jsonl') && options.branchConfig !== undefined) }
  })
  // The host rejects a read of a file that does not exist.
  on('fs.read', (_$, e) => {
    w.fsPaths.push(e.path)
    if (w.historyUnreadable && e.path.endsWith('/history.jsonl')) throw new Error(`EACCES: ${e.path}`)
    if (e.path in w.files) return { value: w.files[e.path]! }
    if (e.path.endsWith('/.git')) return { value: w.gitFile }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', async (_$, e) => {
    if (w.fsWriteThrows) throw new Error('disk full')
    const held = w.holdWrite
    w.holdWrite = undefined
    await held
    w.writes.push({ path: e.path, text: e.text })
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    if (w.statThrows) throw new Error('stat exploded')
    const real = options.realPaths?.[e.path] ?? e.path
    if (real === 'ENOENT' || options.missing?.includes(e.path.split('/').pop() ?? '')) return { deny: 'ENOENT' }
    if (options.dangling?.includes(e.path.split('/').pop() ?? '')) return { value: { kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true } }
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: real !== e.path, realPath: real } }
  })
  on('tool.call', (_$, e) => {
    w.ran.push(e.tool)
    if (e.tool === 'Write' && w.writeFails !== undefined) {
      // A throw before any await: the hook above sees it thrown, not rejected.
      if (w.writeFails === 'throw') throw new Error('write exploded')
      return w.writeFails === 'deny' ? { deny: 'refused downstream' } : { result: 'disk full', isError: true }
    }
    if (e.tool === 'TaskStop') {
      const id = String((e as unknown as { task_id?: string }).task_id)
      w.stops.push(id)
      if (!w.stopFails) w.status[id] = 'killed'
      // As the engine does: a stopped agent's turn ends, as aborted.
      if (w.stopAborts) return $.turn.complete({ agentId: id, answer: '', reason: 'aborted', durationMs: 1, isAborted: true, turnId: `stop-${id}` }).then(() => ({ result: 'ran' }))
    }
    return { result: 'ran' }
  })
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('model.complete', (_$, e) => {
    w.completions.push(e.prompt)
    return { value: { isAnswered: true, text: 'PR body', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.complete', (_$, e) => {
    if (e.agentId !== undefined && w.status[e.agentId] === 'running') w.status[e.agentId] = 'completed'
    return { text: e.answer }
  })
  on('agent.spawn', async (_$, e) => {
    const raw = e as unknown as Record<string, unknown>
    if (w.spawnThrows !== undefined && e.description.startsWith(w.spawnThrows)) {
      w.spawnThrows = undefined
      throw new Error('spawn exploded')
    }
    w.spawns.push({ type: String(raw.subagent_type ?? raw.subagentType), prompt: e.prompt, description: e.description, cwd: e.cwd })
    w.status[`agent-${w.spawns.length}`] = 'running'
    if (options.foreignReview) w.foreign.add(w.spawns.length)
    if (options.instantReview !== undefined && e.description.startsWith('balrog review')) {
      await $.turn.complete({ agentId: `agent-${w.spawns.length}`, answer: options.instantReview, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
    }
    return { model: 'test' }
  })
  on('agent.list', () => {
    w.lists++
    if (w.listThrows) throw new Error('agent list is unavailable')
    return {
      value: w.spawns.map((s, i) => ({
        id: `agent-${i + 1}`,
        description: s.description,
        type: s.type,
        status: w.status[`agent-${i + 1}`] ?? ('running' as const),
        ...(w.foreign.has(i + 1) ? {} : { spawnedBy: PLUGIN }),
      })),
    }
  })
  on('process.run', async (_$, e) => {
    const raw = e.argv.join(' ')
    const line = plain(raw)
    w.raw.push(raw)
    w.calls.push(line)
    if (e.init?.stdin !== undefined) w.stdins[line] = e.init.stdin
    for (const rule of [...w.rules, ...base]) {
      const r = await rule(line, e.init?.cwd)
      if (r) return { value: reply(r) }
    }
    return { value: reply({}) }
  })
  on('state.set', { plugin: PLUGIN, key: 'run' }, (_$, e, next) => {
    if (w.recordFails && e.value?.written?.length) return { deny: 'the state store is full' }
    const value = options.legacy && e.value ? (({ exclude: _, autofix: __, document: ___, guide: ____, reviewedHead: _____, recordDir: _______, steps: { recheck: ______, ...steps }, ...rest }) => ({ ...rest, steps }) as Run)(e.value) : e.value
    if (value) w.runs.push(value)
    return next({ ...e, value })
  })
  return w
}

export const lastRun = (w: World): Run => w.runs[w.runs.length - 1]!

export const command = (name: string, args = ''): CommandRunInput => ({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

export async function start($: Engine, intent = 'add x'): Promise<string | undefined> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return (await $.command.run(command(PLUGIN, intent))).text
}

export const complete = ($: Engine, agentId: string, text: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ agentId, answer: text, reason, durationMs: 1, isAborted: reason === 'aborted', turnId: `turn-${agentId}` })

export const passTwo = async ($: Engine): Promise<void> => {
  for (const id of ['agent-1', 'agent-2']) await complete($, id, answer([]))
}

export const toolCall = ($: Engine, agentId: string | undefined, input: Record<string, unknown>) =>
  $.tool.call({ ...input, ...(agentId === undefined ? {} : { agentId }) } as unknown as Parameters<typeof $.tool.call>[0])

export const toolCheck = ($: Engine, agentId: string | undefined, tool: string, input: Record<string, unknown>) =>
  $.tool.check({ tool, input, ...(agentId === undefined ? {} : { agentId }) } as unknown as Parameters<typeof $.tool.check>[0])

export const isDenied = (r: { deny?: string; isError?: boolean }) => r.deny !== undefined || r.isError === true

export const PR_RULES: Rule[] = [
  line => (line === 'gh pr list --head feat --state open --json url,number,isCrossRepository --limit 10 --repo o/r' ? { stdout: '[{"url":"https://github.com/o/r/pull/7","number":7,"isCrossRepository":false}]' } : undefined),
]

export const say = async ($: Engine, name: string, args = ''): Promise<string> => (await $.command.run(command(name, args))).text ?? ''

export const seedHistoryOnWorktreeAdd = (w: World, lines: string[]): void => {
  w.rules.push(line => {
    const made = /^git worktree add --detach (\S+)\/[^/]+\/wt /.exec(line)
    if (made) w.files[`${made[1]}/history.jsonl`] = `${lines.join('\n')}\n`
    return undefined
  })
}

export type PriorFinding = { id: string; severity: 'error' | 'warning' | 'info'; action?: string; file?: string; line?: number; description: string }

export const historyLine = (id: string, findings: PriorFinding[], decisions: Record<string, unknown>[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, repo: '/repo', branch: 'feat', steps: { review: { status: 'passed', findings: findings.map(f => ({ action: 'ask-user', ...f })) } }, decisions, outcome: 'passed', endedAt: 1, ...over })

export const approveAll = (ids: string[]) => [{ step: 'review', findingIds: ids, verdict: 'approve' }]

export const EARLIER = 'Findings the author approved as is in earlier runs of this branch.'

export const earlierApprovals = (prompt: string): string | undefined => /<(untrusted-\w+) source="earlier approvals">\n([\s\S]*?)\n<\/\1>/.exec(prompt)?.[2]

export const REMOTE = 'dddd4444dddd4444dddd4444dddd4444dddd4444'

export const parkReview = async ($: Engine, w: World): Promise<void> => {
  await start($)
  await complete($, 'agent-1', answer([{ id: 'r1', severity: 'error', action: 'auto-fix', description: 'bug' }]))
  expect(lastRun(w).steps.review).toMatchObject({ status: 'parked' })
}

export const pressTwice = async ($: Engine, key: string): Promise<void> => {
  const ui = await mountPane($, 'terminal')
  await Promise.all([ui.press({ key }), ui.press({ key })])
  await ui.unmount()
}

export const pressOnce = async ($: Engine, key: string): Promise<void> => {
  const ui = await mountPane($, 'terminal')
  await ui.press({ key })
  await ui.unmount()
}

export const outside = (prompt: string) => prompt.replace(/<(untrusted-\w+)[\s\S]*?<\/\1>/g, '')

export const EXCLUDING = `${CONFIG}review:\n  exclude:\n    - package-lock.json\n    - "dist/*"\n`
export const OUTSIDE = '-- . :(exclude)package-lock.json :(exclude)dist/*'

export const GUIDE_TEXT = 'Every migration has a down migration.'
export const GUIDE = `${CONFIG}review:\n  guide: docs/REVIEW.md\n`
export const GUIDE_SHA = 'eeee5555eeee5555eeee5555eeee5555eeee5555'
export const LS_GUIDE = 'git --literal-pathspecs ls-tree -z --full-tree origin/main -- docs/REVIEW.md'
export const entryOf = (mode: string, kind: string, sha: string, path = 'docs/REVIEW.md') => ({ stdout: `${mode} ${kind} ${sha}\t${path}\0` })
export const showGuide = (text: string) => (line: string) =>
  line === LS_GUIDE ? entryOf('100644', 'blob', GUIDE_SHA) : line === `git cat-file blob ${GUIDE_SHA}` ? { stdout: text } : undefined

export const AUTOFIX = `${CONFIG}autofix: true\n`
export const BUG = { id: 'r1', severity: 'error', action: 'auto-fix', description: 'off by one' } as const

import type { CommandName, Commands, Config, Guide, Run } from '../types'
import { io } from './io'

type Ran = { ok: boolean; code: number; out: string; err: string }

async function exec(argv: readonly string[], cwd: string, stdin?: string): Promise<Ran> {
  try {
    const r = await io().run(argv, { cwd, timeoutMs: 600_000, ...(stdin === undefined ? {} : { stdin }) })
    return { ok: r.exitCode === 0, code: r.exitCode, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (e) {
    return { ok: false, code: -1, out: '', err: String(e) }
  }
}

// Every git the mod runs has the two config keys that execute repository code
// pinned off, so a branch's husky hooksPath or a crafted gitdir's fsmonitor
// runs nothing, in the worktree and in the user's repository alike; and
// submodule.recurse, so no checkout, rebase or push reaches into a submodule.
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false']

export const git = (cwd: string, ...args: string[]) => exec(['git', ...HOOKS_OFF, ...args], cwd)

export const gh = (cwd: string, args: string[], stdin?: string) => exec(['gh', ...args], cwd, stdin)

// git's own words for a signer that did not sign (gpg, gpgsm, ssh-keygen);
// a bare /sign/ would take a commit subject like "Redesign" for one.
const SIGNING = /gpg failed to sign|failed to sign the data|cannot run (gpg|gpgsm|ssh-keygen)|signingkey|ssh signing|failed to write commit object/i

// A commit git refuses for the user's own setup rather than for anything the
// run did: no identity, or signing that is on and does not work.
function setupProblem(err: string): string | undefined {
  if (/tell me who you are|unable to auto-detect email|empty ident name|identity unknown/i.test(err)) {
    return 'git identity not set, so git cannot commit: run git config --global user.name "<name>" and git config --global user.email "<email>", then run again'
  }
  if (SIGNING.test(err)) {
    const line = err.split(/[\r\n]+/).find(l => SIGNING.test(l)) ?? err.split('\n')[0]
    return `commit signing failed (commit.gpgsign is on and the signer did not sign): ${line?.trim().replace(/[:.]+$/, '')}. Make a signed git commit work in a terminal, then run again`
  }
  return undefined
}

export type RepoFacts = { repo: string; commonDir: string; branch: string; head: string; base: string }

export type Inspected = { ok: true; facts: RepoFacts } | { ok: false; reason: string }

async function realPathOf(path: string): Promise<string | undefined> {
  try {
    return (await io().stat(path)).realPath?.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

const absolute = (path: string, from: string) => (path.startsWith('/') ? path : `${from}/${path}`)

export async function inspectRepo(cwd: string): Promise<Inspected> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel')
  if (!top.ok) return { ok: false, reason: `${cwd} is not inside a git repository (${top.err || 'git rev-parse failed'}).` }
  const repo = top.out
  const branch = await git(repo, 'symbolic-ref', '--short', 'HEAD')
  if (!branch.ok) {
    return { ok: false, reason: 'HEAD is detached. Check out a feature branch first: git switch -c <branch>.' }
  }
  const head = await git(repo, 'rev-parse', '--verify', 'HEAD')
  if (!head.ok) {
    return { ok: false, reason: 'The branch has no commit yet. Commit your work first: git add -A && git commit -m "<message>".' }
  }
  const base = await defaultBranch(repo)
  if (!base) {
    return { ok: false, reason: 'No origin default branch found. Add the remote and fetch it: git remote add origin <url> && git fetch origin.' }
  }
  if (branch.out === base) {
    return { ok: false, reason: `You are on ${base}, the default branch. Move the work to a feature branch: git switch -c <branch>.` }
  }
  const common = await git(repo, 'rev-parse', '--git-common-dir')
  const commonDir = common.ok ? await realPathOf(absolute(common.out, repo)) : undefined
  if (commonDir === undefined) return { ok: false, reason: `cannot place the repository's git dir (${common.err || 'stat failed'}).` }
  return { ok: true, facts: { repo, commonDir, branch: branch.out, head: head.out, base } }
}

async function defaultBranch(repo: string): Promise<string | undefined> {
  const ref = await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  if (ref.ok) return ref.out.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    const r = await git(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`)
    if (r.ok) return candidate
  }
  return undefined
}

function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

// The run's directory holds the worktree alone, under a per-user cache root
// the mod keeps at mode 0700: no other local user can pre-create or swap a
// path there, and a relative escape from the worktree reaches nothing of the
// user's repository.
export async function runDirectory(facts: RepoFacts, runId: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const cache = (await io().cacheHome()) || `${(await io().home()) ?? ''}/.cache`
  if (!cache.startsWith('/')) return { ok: false, reason: 'neither XDG_CACHE_HOME nor HOME names an absolute directory' }
  const root = `${cache.replace(/\/$/, '')}/no-mistakes`
  const made = await exec(['mkdir', '-p', '-m', '0700', root], '/')
  if (!made.ok) return { ok: false, reason: `cannot create ${root}: ${made.err}` }
  const closed = await exec(['chmod', '0700', root], '/')
  if (!closed.ok) return { ok: false, reason: `cannot set ${root} to mode 0700: ${closed.err}` }
  const name = facts.repo.split('/').pop() || 'repo'
  return { ok: true, path: `${root}/${name}-${hashOf(facts.repo)}/${runId}` }
}

export const worktreeOf = (runDir: string) => `${runDir}/wt`

export type Worktree = { path: string; gitFile: string; commonDir: string }

export async function addWorktree(facts: RepoFacts, path: string): Promise<{ ok: true; worktree: Worktree } | { ok: false; reason: string }> {
  const r = await git(facts.repo, 'worktree', 'add', '--detach', path, facts.head)
  if (!r.ok) return { ok: false, reason: r.err || 'git worktree add failed' }
  let gitFile: string
  try {
    gitFile = await io().read(`${path}/.git`)
  } catch (e) {
    return { ok: false, reason: `cannot read ${path}/.git: ${String(e)}` }
  }
  return { ok: true, worktree: { path, gitFile, commonDir: facts.commonDir } }
}

export async function removeWorktree(run: Run): Promise<Ran> {
  const removed = await git(run.repo, 'worktree', 'remove', '--force', run.worktree)
  if (removed.ok) await exec(['rmdir', run.worktree.replace(/\/[^/]*$/, '')], '/')
  return removed
}

// The worktree is the one place an agent writes, so before git reads it the
// mod checks that `.git` still points where the mod left it: a rewritten
// gitdir would make an in-worktree commit land on the user's branch, or load
// a config of the agent's making.
export async function intact(run: Run): Promise<string | undefined> {
  let file: string | undefined
  try {
    file = await io().read(`${run.worktree}/.git`)
  } catch {
    file = undefined
  }
  if (file !== run.gitFile) return `${run.worktree}/.git was modified; the mod runs no git there any more`
  const common = await exec(['git', ...HOOKS_OFF, 'rev-parse', '--git-common-dir'], run.worktree)
  const real = common.ok ? await realPathOf(absolute(common.out, run.worktree)) : undefined
  if (real !== run.commonDir) return `the worktree no longer belongs to ${run.commonDir} (${common.ok ? real : common.err})`
  return undefined
}

async function wt(run: Run, ...args: string[]): Promise<Ran> {
  const broken = await intact(run)
  if (broken !== undefined) return { ok: false, code: -1, out: '', err: broken }
  return git(run.worktree, ...args)
}

export type Pinned = { kind: 'reachable' } | { kind: 'pinned'; ref: string } | { kind: 'error'; detail: string }

export const recoveryRef = (run: Run) => `refs/no-mistakes/recover/${run.id}`

// Commits the worktree made beyond the rebased head (the pipeline's own
// fixes) survive its removal under a ref of their own.
export async function pinHead(run: Run): Promise<Pinned> {
  const head = await headOf(run)
  if (head === undefined) return { kind: 'error', detail: 'cannot read the worktree HEAD' }
  const beyond = await wt(run, 'rev-list', '--count', `${run.head}..${head}`)
  if (!beyond.ok) return { kind: 'error', detail: beyond.err || 'git rev-list failed' }
  if (beyond.out === '0') return { kind: 'reachable' }
  const ref = recoveryRef(run)
  const r = await git(run.repo, 'update-ref', ref, head)
  return r.ok ? { kind: 'pinned', ref } : { kind: 'error', detail: r.err || 'git update-ref failed' }
}

// Fetch and push run in the main repository, not the worktree: the refs are
// shared, and a relative remote URL (`../origin.git`) resolves against the
// directory git runs in. Only the two refs the run needs are fetched, never
// with --prune: the user's other remote-tracking refs are theirs.
async function fetchRefs(run: Run): Promise<{ ok: true; remoteHead: string } | { ok: false; detail: string }> {
  const probe = await git(run.repo, 'ls-remote', '--exit-code', 'origin', `refs/heads/${run.branch}`)
  if (!probe.ok && probe.code !== 2) return { ok: false, detail: `git ls-remote origin failed: ${probe.err}` }
  const remoteHead = probe.ok ? (/^[0-9a-f]{40}/.exec(probe.out)?.[0] ?? '') : ''
  const specs = [`+refs/heads/${run.base}:refs/remotes/origin/${run.base}`]
  if (remoteHead !== '') specs.push(`+refs/heads/${run.branch}:refs/remotes/origin/${run.branch}`)
  const fetched = await git(run.repo, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', ...specs)
  if (!fetched.ok) return { ok: false, detail: `git fetch origin failed: ${fetched.err}` }
  return { ok: true, remoteHead }
}

// `pull`: origin/<branch> holds commits the local branch has no version of.
// `rewritten`: every remote-only commit has a local patch twin, so the local
// branch is a rewrite the user has not pushed yet.
export type Behind = 'pull' | 'rewritten'

export type Rebased =
  | { kind: 'rebased'; head: string; remoteHead: string; isEmpty: boolean; config: Pick<Run, 'commands' | 'exclude' | 'autofix' | 'document' | 'guide'> }
  | { kind: 'behind'; remoteHead: string; how: Behind }
  | { kind: 'conflict'; detail: string }
  | { kind: 'error'; detail: string }

async function howBehind(run: Run, remoteHead: string): Promise<Behind> {
  const unmatched = await wt(run, 'rev-list', '--count', '--cherry-pick', '--right-only', `HEAD...${remoteHead}`)
  return unmatched.ok && unmatched.out === '0' ? 'rewritten' : 'pull'
}

export async function rebase(run: Run): Promise<Rebased> {
  const remote = await fetchRefs(run)
  if (!remote.ok) return { kind: 'error', detail: remote.detail }
  const remoteHead = remote.remoteHead
  // Checked before the rebase rewrites the commits: afterwards nothing of
  // origin/<branch> is an ancestor of HEAD even when the branch was up to date.
  if (remoteHead !== '' && !(await isAncestor(run, remoteHead, 'HEAD'))) return { kind: 'behind', remoteHead, how: await howBehind(run, remoteHead) }
  // Pinned against the user's rebase.updateRefs and rebase.autoStash: either
  // would move the user's other branches or their stash from the worktree.
  const rebased = await wt(run, 'rebase', '--no-update-refs', '--no-autostash', `origin/${run.base}`)
  if (!rebased.ok) {
    // A stop with unmerged paths is a conflict whatever the output says.
    const unmerged = await wt(run, 'ls-files', '--unmerged')
    await wt(run, 'rebase', '--abort')
    const detail = rebased.err || rebased.out
    const setup = unmerged.ok && unmerged.out === '' ? setupProblem(detail) : undefined
    return setup === undefined ? { kind: 'conflict', detail: detail.slice(0, 2000) } : { kind: 'error', detail: setup }
  }
  const head = await headOf(run)
  if (head === undefined) return { kind: 'error', detail: 'cannot read HEAD after rebase' }
  const count = await wt(run, 'rev-list', '--count', `origin/${run.base}..HEAD`)
  const changed = await wt(run, 'diff', '--quiet', `origin/${run.base}`, 'HEAD')
  const isEmpty = count.out === '0' || changed.ok
  const config = parseConfig(await showOnBase(run, '.no-mistakes.yaml'))
  if ('error' in config) return { kind: 'error', detail: `.no-mistakes.yaml on origin/${run.base}: ${config.error}` }
  const { guide: path, ...settings } = config
  const guide = path === undefined ? undefined : await readGuide(run, path)
  if (guide !== undefined && 'error' in guide) return { kind: 'error', detail: guide.error }
  return { kind: 'rebased', head, remoteHead, isEmpty, config: { ...settings, guide } }
}

async function readGuide(run: Run, path: string): Promise<Guide | { error: string }> {
  const unread = (r: Ran) => ({ error: `review.guide names ${path}, which git could not read from origin/${run.base}: ${r.err || `exit ${r.code}`}` })
  // ls-tree gives the mode, so a symlink is refused before cat-file, which also skips the textconv `git show` would run.
  const listed = await wt(run, '--literal-pathspecs', 'ls-tree', '-z', '--full-tree', `origin/${run.base}`, '--', path)
  if (!listed.ok) return unread(listed)
  const entry = listed.out.split('\0').map(line => /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line)).find(m => m?.[4] === path)
  if (!entry) return { error: `review.guide names ${path}, which origin/${run.base} does not have` }
  const [, mode = '', kind = '', sha = ''] = entry
  if (mode === '120000') return { error: `review.guide names ${path}, which is a symbolic link on origin/${run.base}, not a file` }
  if (kind !== 'blob') return { error: `review.guide names ${path}, which is a ${kind === 'commit' ? 'submodule' : kind} on origin/${run.base}, not a file` }
  const blob = await wt(run, 'cat-file', 'blob', sha)
  if (!blob.ok) return unread(blob)
  const text = blob.out
  if (text.length > GUIDE_LIMIT) return { error: `review.guide names ${path}, which has ${text.length.toLocaleString('en-US')} characters on origin/${run.base}; the limit is ${GUIDE_LIMIT.toLocaleString('en-US')}` }
  return { path, text }
}

export async function headOf(run: Run): Promise<string | undefined> {
  const r = await wt(run, 'rev-parse', '--verify', 'HEAD')
  return r.ok ? r.out : undefined
}

export async function push(run: Run): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const remote = await fetchRefs(run)
  if (!remote.ok) return { ok: false, reason: remote.detail }
  if (remote.remoteHead !== run.remoteHead) {
    return { ok: false, reason: `origin/${run.branch} moved to ${remote.remoteHead.slice(0, 12) || 'nothing'} since the run read it (${run.remoteHead.slice(0, 12) || 'no branch'}); it has commits this run never saw. Pull them into your branch and run again` }
  }
  const head = await headOf(run)
  if (head === undefined) return { ok: false, reason: 'cannot read the worktree HEAD' }
  if (!(await isAncestor(run, run.head, head))) {
    return { ok: false, reason: `the worktree HEAD ${head.slice(0, 12)} does not descend from the reviewed head ${run.head.slice(0, 12)}; history was rewritten, nothing is pushed` }
  }
  const r = await git(
    run.repo,
    'push',
    '--no-follow-tags',
    '--recurse-submodules=no',
    'origin',
    `${head}:refs/heads/${run.branch}`,
    `--force-with-lease=refs/heads/${run.branch}:${run.remoteHead}`,
  )
  return r.ok ? { ok: true, head } : { ok: false, reason: (r.err || r.out).slice(0, 2000) }
}

// External diff and textconv drivers are config-defined commands; neither is
// wanted for text the reviewer reads. `--text` because the branch's own
// .gitattributes can mark code `-diff` and hide it as "Binary files differ".
const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--text']

const DIFF_CAP = 120_000
const GUIDE_LIMIT = 30_000

// `--text` does not reach a stat, so a stat reads attributes from
// origin/<base>: a `-diff` the branch adds cannot show its code as "Bin". Git
// before 2.40 has no --attr-source and reads the branch's.
async function withBaseAttributes(run: Run, ...args: string[]): Promise<Ran> {
  const based = await wt(run, `--attr-source=origin/${run.base}`, ...args)
  return based.ok ? based : wt(run, ...args)
}

// git's default pathspec glob lets `*` cross `/`, so `dist/*` also drops `dist/a/b.js`.
function outsideExcluded(run: Run): string[] {
  return run.exclude.length === 0 ? [] : ['--', '.', ...run.exclude.map(pattern => `:(exclude)${pattern}`)]
}

export async function diffStat(run: Run): Promise<string> {
  const r = await withBaseAttributes(run, ...DIFF, '--stat', `origin/${run.base}...HEAD`, ...outsideExcluded(run))
  return r.out
}

// The change under review, as text the reviewer is handed: the stat, then the
// patch cut at DIFF_CAP characters with a note saying so.
export async function reviewDiff(run: Run): Promise<string> {
  const stat = await diffStat(run)
  const patch = await wt(run, ...DIFF, `origin/${run.base}...HEAD`, ...outsideExcluded(run))
  const text = !patch.ok ? `(git diff failed: ${patch.err})` : patch.out === '' && run.exclude.length > 0 ? '(every changed file matches review.exclude)' : patch.out
  const cut = text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}\n[diff truncated at ${DIFF_CAP} characters of ${text.length}; read the files for the rest]` : text
  return `${stat}\n\n${cut}`
}

export async function isAncestor(run: Run, older: string, newer: string): Promise<boolean> {
  return (await wt(run, 'merge-base', '--is-ancestor', older, newer)).ok
}

// The pipeline's own config is read from the trusted default branch, never
// from the branch under review.
export async function showOnBase(run: Run, path: string): Promise<string | undefined> {
  const r = await wt(run, 'show', `origin/${run.base}:${path}`)
  return r.ok ? r.out : undefined
}

const COMMAND_NAMES: readonly CommandName[] = ['prepare', 'test', 'lint', 'format']

function scalar(raw: string): string | undefined | { error: string } {
  const rest = (after: string, value: string) => (/^(\s+#.*)?$/.test(after) ? value : { error: `unexpected text after the closing quote: ${after.trim()}` })
  if (raw === '' || raw.startsWith('#')) return undefined
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0]!
    let value = ''
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i]!
      if (quote === "'" && c === "'" && raw[i + 1] === "'") value += raw[++i]
      else if (quote === '"' && c === '\\') {
        const escaped = raw[++i]
        if (escaped !== '"' && escaped !== '\\') return { error: 'only \\" and \\\\ escapes are read in a double-quoted value' }
        value += escaped
      } else if (c === quote) return rest(raw.slice(i + 1), value)
      else value += c
    }
    return { error: 'the quote is not closed on the same line' }
  }
  if (/^[>|[\]{}*&!%@`,]|^[-?:](\s|$)/.test(raw)) return { error: 'block, flow, tagged, alias and list values are not read; write the value on one line, quoted if it starts with a YAML indicator' }
  const value = raw.replace(/\s#.*$/, '').trim()
  if (/:(\s|$)/.test(value)) return { error: 'a plain value cannot hold ": "; quote the value' }
  return value === '~' || /^null$/i.test(value) ? undefined : value
}

const SECTIONS = ['commands', 'review'] as const
const FLAGS = ['autofix', 'document'] as const

type Section = (typeof SECTIONS)[number]
type Flag = (typeof FLAGS)[number]

function parseConfig(text: string | undefined): Config | { error: string } {
  const body: Record<Section, string[]> = { commands: [], review: [] }
  const flags: Partial<Record<Flag, boolean>> = {}
  let section: Section | Flag | undefined
  for (const line of (text ?? '').split('\n').map(l => l.replace(/\s+$/, ''))) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\s/.test(line)) {
      if (section !== undefined && isFlag(section)) return { error: `cannot read "${line.trim()}" under ${section}: the value goes on the ${section}: line` }
      if (section !== undefined) body[section].push(line)
      continue
    }
    const top = /^([A-Za-z_]+):(.*)$/.exec(line)
    const known = FLAGS.find(f => f === top?.[1]) ?? SECTIONS.find(s => s === top?.[1])
    const misplaced = /^-(\s|$)/.test(line) || (top !== null && (REVIEW_KEYS.some(k => k === top[1]) || COMMAND_NAMES.some(n => n === top[1])))
    if (section !== undefined && known === undefined && misplaced) {
      return { error: `cannot read "${line.trim()}" under ${section}: entries must be indented under their section key, and commands:, review:, autofix: and document: are the only top-level keys read` }
    }
    section = known
    if (known !== undefined && isFlag(known)) {
      if (flags[known] !== undefined) return { error: `${known} is set twice` }
      const read = readFlag(known, line)
      if (typeof read === 'object') return read
      flags[known] = read ?? DEFAULT_FLAGS[known]
    } else if (known !== undefined && !/^(\s+#.*)?$/.test(top?.[2] ?? '')) {
      return { error: `${known}: must be followed by one entry per line` }
    }
  }
  const commands = readCommands(body.commands)
  if ('error' in commands) return commands
  const review = readReview(body.review)
  if ('error' in review) return review
  return { commands, ...review, autofix: flags.autofix ?? DEFAULT_FLAGS.autofix, document: flags.document ?? DEFAULT_FLAGS.document }
}

const isFlag = (key: string): key is Flag => FLAGS.some(f => f === key)

const DEFAULT_FLAGS: Record<Flag, boolean> = { autofix: false, document: true }

function readFlag(key: Flag, line: string): boolean | undefined | { error: string } {
  const entry = new RegExp(`^${key}:(?:\\s+(.*))?$`).exec(line)
  if (!entry) return { error: `${key}: must be followed by a space and true or false` }
  const raw = entry[1] ?? ''
  if (/^["']/.test(raw)) return { error: `${key}: must be true or false, unquoted` }
  const value = scalar(raw)
  if (typeof value === 'object') return { error: `${key}: ${value.error}` }
  if (value === undefined) return undefined
  if (value !== 'true' && value !== 'false') return { error: `${key}: "${value}" is not true or false` }
  return value === 'true'
}

const misread = (line: string, section: string) => ({ error: `cannot read "${line.trim()}" under ${section}: (a nested, continued or misaligned line)` })

const REVIEW_KEYS = ['exclude', 'guide'] as const

type ReviewKey = (typeof REVIEW_KEYS)[number]

// A pattern starting with `:` is read by git as pathspec magic, not as a path:
// `:(exclude):(top)keep.ts` excludes nothing.
function readReview(lines: string[]): Pick<Config, 'exclude' | 'guide'> | { error: string } {
  const exclude: string[] = []
  let guide: string | undefined
  const seen = new Set<ReviewKey>()
  let current: { key: ReviewKey; indent: string } | undefined
  let itemIndent: string | undefined
  for (const line of lines) {
    const key = /^( +)([A-Za-z_]+):(.*)$/.exec(line)
    if (key) {
      if (current !== undefined && key[1] !== current.indent) return misread(line, 'review')
      const name = REVIEW_KEYS.find(k => k === key[2])
      if (!name) return { error: `review.${key[2]} is not read; review: holds only exclude: and guide:` }
      if (seen.has(name)) return { error: `review.${name} is set twice` }
      seen.add(name)
      current = { key: name, indent: key[1]! }
      if (name === 'guide') {
        const read = readGuidePath(key[3]!)
        if (typeof read === 'object') return read
        guide = read
      } else if (!/^(\s+#.*)?$/.test(key[3]!)) return { error: 'review.exclude: must be followed by one "- <pattern>" line per pattern' }
      continue
    }
    const item = /^( +)-(?:\s+(.*))?$/.exec(line)
    if (!item || current?.key !== 'exclude' || item[1]!.length < current.indent.length || (itemIndent !== undefined && item[1] !== itemIndent)) return misread(line, 'review')
    itemIndent = item[1]
    const value = scalar(item[2] ?? '')
    if (typeof value === 'object') return { error: `review.exclude: ${value.error}` }
    if (value === undefined || value.trim() === '') return { error: 'review.exclude has an empty item' }
    if (/^[:-]/.test(value)) return { error: `review.exclude: "${value}": a pattern cannot begin with : or -` }
    exclude.push(value)
  }
  return { exclude, guide }
}

// readGuide matches ls-tree's entry name to the path as written, so a path git
// would normalize is refused here rather than read as a missing file.
function readGuidePath(raw: string): string | undefined | { error: string } {
  const entry = /^(?:\s+(.*))?$/.exec(raw)
  if (!entry) return { error: 'review.guide: must be followed by a space and a path' }
  const value = scalar(entry[1] ?? '')
  if (typeof value === 'object') return { error: `review.guide: ${value.error}` }
  if (value === undefined || value.trim() === '') return undefined
  if (value.split('/').some(part => part === '' || part === '.' || part === '..')) return { error: `review.guide: "${value}" must be a path from the repository root, with no leading or trailing /, and no empty, . or .. part` }
  return value
}

function readCommands(lines: string[]): Commands | { error: string } {
  const commands: Commands = {}
  let indent: string | undefined
  const seen = new Set<CommandName>()
  for (const line of lines) {
    const entry = /^( +)([A-Za-z_]+):(?:\s+(.*))?$/.exec(line)
    if (!entry || (indent !== undefined && entry[1] !== indent)) return misread(line, 'commands')
    indent = entry[1]
    const name = COMMAND_NAMES.find(n => n === entry[2])
    if (!name) return { error: `commands.${entry[2]} is not one of ${COMMAND_NAMES.join(', ')}` }
    if (seen.has(name)) return { error: `commands.${name} is set twice` }
    seen.add(name)
    const value = scalar(entry[3] ?? '')
    if (typeof value === 'object') return { error: `commands.${name}: ${value.error}` }
    if (value !== undefined && value.trim() !== '') commands[name] = value.trim()
  }
  return commands
}

export type CommandRun = { exitCode: number; output: string }

// A configured command is the repository's own, run as the user: this is the
// trust upstream no-mistakes extends too, and the one place a run executes
// code of the branch's ancestry.
export async function runCommand(run: Run, command: string): Promise<CommandRun> {
  try {
    const r = await io().run(['sh', '-c', command], { cwd: run.worktree, timeoutMs: 600_000 })
    return { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim().slice(-6000) }
  } catch (e) {
    return { exitCode: -1, output: `could not run: ${String(e)}` }
  }
}

// `prepare` runs once per worktree. What it changed in tracked files (a
// lockfile) is put back; what it leaves untracked never reaches a commit,
// since the mod commits only untracked files an agent wrote.
export async function prepare(run: Run): Promise<{ ok: true } | { ok: false; reason: string }> {
  const command = run.commands.prepare
  if (command === undefined || run.prepared) return { ok: true }
  const ran = await runCommand(run, command)
  if (ran.exitCode !== 0) return { ok: false, reason: `prepare command "${command}" exited ${ran.exitCode}:\n${ran.output}` }
  const restored = await wt(run, 'restore', '--staged', '--worktree', '--', '.')
  return restored.ok ? { ok: true } : { ok: false, reason: `cannot restore tracked files after prepare: ${restored.err}` }
}

// `isSetup`: git refused for the user's own setup (identity, signing), and
// `detail` says what to fix.
export type Committed = { kind: 'clean' } | { kind: 'committed'; head: string } | { kind: 'error'; detail: string; isSetup?: true }

// One commit of the mod's, hooks off: every change to a tracked file, and of
// the untracked files only those a run agent wrote (`run.written`) and the
// repository does not ignore. What a command leaves behind (node_modules,
// coverage, caches) stays out, and the user's own excludes still apply.
// Commits run one at a time: an answer's and a timeout's would otherwise race
// on the worktree's index.lock.
let committing: Promise<unknown> = Promise.resolve()

export function commitAll(run: Run, message: string): Promise<Committed> {
  const done = committing.then(() => commitOnce(run, message))
  committing = done.catch(() => undefined)
  return done
}

async function commitOnce(run: Run, message: string): Promise<Committed> {
  const tracked = await wt(run, 'add', '-u')
  if (!tracked.ok) return { kind: 'error', detail: tracked.err }
  if (run.written?.length) {
    const fresh = await wt(run, '--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...run.written)
    if (!fresh.ok) return { kind: 'error', detail: fresh.err }
    // A recorded file that became a directory lists what is under it, which
    // no agent wrote: only exact entries are added.
    const paths = fresh.out.split('\0').filter(p => run.written?.includes(p))
    const added = paths.length === 0 ? fresh : await wt(run, '--literal-pathspecs', 'add', '--', ...paths)
    if (!added.ok) return { kind: 'error', detail: added.err }
  }
  if ((await wt(run, 'diff', '--cached', '--quiet')).ok) return { kind: 'clean' }
  const committed = await wt(run, 'commit', '-q', '-m', message)
  if (!committed.ok) {
    const detail = committed.err || committed.out
    const setup = setupProblem(detail)
    return setup === undefined ? { kind: 'error', detail } : { kind: 'error', detail: setup, isSetup: true }
  }
  const head = await headOf(run)
  return head === undefined ? { kind: 'error', detail: 'cannot read HEAD after the commit' } : { kind: 'committed', head }
}

// The mod's own commits since the rebased head, as `<sha> <subject>` and a
// stat each, for the pane and the PR body.
export async function pipelineCommits(run: Run): Promise<string> {
  const r = await withBaseAttributes(run, 'log', ...DIFF.slice(1), '--no-show-signature', '--format=%h %s', '--stat', `${run.head}..HEAD`)
  return r.ok ? r.out : ''
}

export async function ghReady(cwd: string): Promise<string | undefined> {
  const r = await gh(cwd, ['auth', 'status'])
  if (r.ok) return undefined
  return r.err.includes('not') || r.out.includes('not') || r.err === '' ? 'gh is missing or not authenticated' : r.err.slice(0, 300)
}

export type GhRepo = { host: string; slug: string; path: string }

// The GitHub repository origin names, which is where the mod pushes. Left to
// itself gh picks an `upstream` or `github` remote, or its own default, and
// would open the PR or read CI somewhere else.
export async function ghRepo(run: Run): Promise<GhRepo | { error: string }> {
  const r = await git(run.repo, 'remote', 'get-url', 'origin')
  // `scheme://[user@]host[:port]/owner/name` or scp-like `[user@]host:owner/name`.
  const m = r.ok ? (/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r.out) ?? /^(?:[^@/:]+@)?([^/:@]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r.out)) : null
  // A credential in the URL stays out of the reason the pane shows.
  if (!m) return { error: `origin (${r.ok ? r.out.replace(/\/\/[^@/]+@/, '//') : r.err}) does not name a GitHub repository gh can reach` }
  const [, host, owner, name] = m as unknown as [string, string, string, string]
  const path = `${owner}/${name}`
  return { host, path, slug: host === 'github.com' ? path : `${host}/${path}` }
}

// A gh call pinned to origin's repository.
async function ghOn(run: Run, args: string[], stdin?: string): Promise<Ran> {
  const target = await ghRepo(run)
  if ('error' in target) return { ok: false, code: -1, out: '', err: target.error }
  return gh(run.repo, [...args, '--repo', target.slug], stdin)
}

export type PrRef = { url: string; number: number }

// Only an open PR from origin's own <branch> is the run's: a merged or closed
// one is history, and a fork's PR of the same branch name is someone else's.
export async function prView(run: Run): Promise<PrRef | undefined> {
  const r = await ghOn(run, ['pr', 'list', '--head', run.branch, '--state', 'open', '--json', 'url,number,isCrossRepository', '--limit', '10'])
  if (!r.ok) return undefined
  try {
    const list = JSON.parse(r.out) as { url?: unknown; number?: unknown; isCrossRepository?: unknown }[]
    const v = Array.isArray(list) ? list.find(p => p.isCrossRepository === false) : undefined
    return v && typeof v.url === 'string' && typeof v.number === 'number' ? { url: v.url, number: v.number } : undefined
  } catch {
    return undefined
  }
}

export async function prCreate(run: Run, title: string, body: string): Promise<PrRef | { error: string }> {
  const r = await ghOn(run, ['pr', 'create', '--base', run.base, '--head', run.branch, '--title', title, '--body-file', '-'], body)
  if (!r.ok) return { error: (r.err || r.out).slice(0, 1000) }
  // gh prints the new PR's URL on its own line. Without one, the URL is not
  // trusted: the pane renders the PR as a link, so only an https URL may stand.
  // A PR the view finds is taken as gh reports its URL, without that check.
  const url = r.out.split('\n').find(line => line.startsWith('https://'))
  const view = await prView(run)
  if (view) return view
  if (url === undefined) return { error: `gh pr create printed no pull request URL: ${r.out.slice(0, 200)}` }
  return { url, number: Number(url.split('/').pop()) || 0 }
}

export async function prHead(run: Run, number: number): Promise<string | undefined> {
  const r = await ghOn(run, ['pr', 'view', String(number), '--json', 'headRefOid'])
  if (!r.ok) return undefined
  try {
    const v = JSON.parse(r.out) as { headRefOid?: unknown }
    return typeof v.headRefOid === 'string' ? v.headRefOid : undefined
  } catch {
    return undefined
  }
}

export type Check = { name: string; bucket: string; state: string }

export async function prChecks(run: Run, number: number): Promise<Check[] | { error: string }> {
  const r = await ghOn(run, ['pr', 'checks', String(number), '--json', 'name,state,bucket'])
  if (!r.ok) {
    if (/no checks reported/i.test(r.err + r.out)) return []
    return { error: (r.err || r.out).slice(0, 500) }
  }
  try {
    const list = JSON.parse(r.out) as unknown
    return Array.isArray(list)
      ? list.map(c => ({ name: String((c as Check).name), bucket: String((c as Check).bucket), state: String((c as Check).state) }))
      : { error: 'gh pr checks returned no list' }
  } catch (e) {
    return { error: `gh pr checks output does not parse: ${String(e)}` }
  }
}

// How many Actions workflows the repository defines; undefined when gh cannot
// say. Zero is the one signal that no check will ever report.
export async function workflowCount(run: Run): Promise<number | undefined> {
  const target = await ghRepo(run)
  if ('error' in target) return undefined
  const r = await gh(run.repo, ['api', '--hostname', target.host, `repos/${target.path}/actions/workflows`, '--jq', '.total_count'])
  return r.ok && /^\d+$/.test(r.out) ? Number(r.out) : undefined
}

// The failed log of the pushed head only: a branch's latest failed run may
// belong to an older head whose failure this head already fixed.
export async function failedLog(run: Run): Promise<string> {
  const runs = await ghOn(run, ['run', 'list', '--branch', run.branch, '--status', 'failure', '--limit', '20', '--json', 'databaseId,headSha'])
  let id: number | undefined
  try {
    id = (JSON.parse(runs.out) as { databaseId?: number; headSha?: string }[]).find(r => r.headSha === run.remoteHead)?.databaseId
  } catch {
    id = undefined
  }
  if (id === undefined) return ''
  const log = await ghOn(run, ['run', 'view', String(id), '--log-failed'])
  return log.out.slice(-6000)
}

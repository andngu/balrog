// Drives the mod's own git.ts and guard.ts against real git repositories.
// Run: bun scripts/realgit/realgit.ts   (NM_MOD=<mod dir> to drive another copy)
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Run } from '../../types/index.d.ts'

const MOD = process.env.NM_MOD ?? `${import.meta.dir}/../..`
const git = await import(`${MOD}/hooks/git.ts`)
const { bind } = await import(`${MOD}/hooks/io.ts`)
const { newRun } = await import(`${MOD}/hooks/run.ts`)
const { isAllowed, judge } = await import(`${MOD}/hooks/guard.ts`)

const root = mkdtempSync(`${tmpdir()}/nm-realgit-`)
const home = `${root}/home`
mkdirSync(home)
// Identity comes from the environment unless a scenario drops it.
let ident = true
const IDENT = { GIT_AUTHOR_NAME: 'nm', GIT_AUTHOR_EMAIL: 'nm@x', GIT_COMMITTER_NAME: 'nm', GIT_COMMITTER_EMAIL: 'nm@x' }
const sh = (argv: readonly string[], cwd: string, stdin?: string) =>
  new Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }>(resolve => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, ...(ident ? IDENT : {}) }
    if (!ident) for (const k of [...Object.keys(IDENT), 'EMAIL']) delete env[k]
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }))
  })

const nope = () => { throw new Error('not used') }
// As $.fs.stat answers: a path that is not there rejects; one that is there
// but resolves nowhere (a dangling link) resolves without a realPath.
const stat = async (p: string) => {
  const own = lstatSync(p)
  let realPath: string | undefined
  try {
    realPath = realpathSync(p)
  } catch {
    realPath = undefined
  }
  return { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: own.isSymbolicLink(), ...(realPath === undefined ? {} : { realPath }) }
}
bind({
  run: (argv, init) => sh(argv, init?.cwd ?? '/', init?.stdin),
  spawn: nope, agents: nope, now: nope, every: nope, fork: nope, complete: nope, cwd: nope, openPane: nope, status: nope, toast: nope, notify: nope, readRun: nope, writeRun: nope, readSelected: nope, writeSelected: nope,
  home: async () => home,
  cacheHome: async () => undefined,
  read: async p => readFileSync(p, 'utf8'),
  write: async (p, t) => void writeFileSync(p, t),
  stat,
})

const out = async (argv: string[], cwd: string) => (await sh(argv, cwd)).stdout.trim()
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const origin = `${root}/origin.git`
await sh(['git', 'init', '-q', '--bare', origin], root)
const seed = `${root}/seed`
await sh(['git', 'init', '-q', '-b', 'main', seed], root)
writeFileSync(`${root}/config.yaml`, 'commands:\n  prepare: "sh prepare.sh"\n  test: "sh test.sh"\n  lint: sh lint.sh\n')
await sh(['sh', '-c', `echo base > a.txt && cp ${root}/config.yaml .no-mistakes.yaml && printf 'echo residue > residue.txt; echo prepared >> a.txt\\n' > prepare.sh && printf 'test -f b.txt\\n' > test.sh && printf 'exit 0\\n' > lint.sh && git add . && git commit -qm base && git remote add origin ${origin} && git push -q origin main`], seed)
await sh(['sh', '-c', 'git switch -qc feat && echo local > b.txt && git add . && git commit -qm "local feat" && git push -q origin feat'], seed)

async function runFor(repo: string, label: string): Promise<Run> {
  const inspected = await git.inspectRepo(repo)
  if (!inspected.ok) throw new Error(inspected.reason)
  const dir = await git.runDirectory(inspected.facts, label)
  if (!dir.ok) throw new Error(dir.reason)
  const added = await git.addWorktree(inspected.facts, git.worktreeOf(dir.path))
  if (!added.ok) throw new Error(added.reason)
  const { worktree } = added
  return newRun({ id: label, repo: inspected.facts.repo, branch: inspected.facts.branch, base: inspected.facts.base, worktree: worktree.path, gitFile: worktree.gitFile, commonDir: worktree.commonDir, intent: 'x', localHead: inspected.facts.head })
}
async function rebased(repo: string, label: string): Promise<Run> {
  const run = await runFor(repo, label)
  const r = await git.rebase(run)
  if (r.kind !== 'rebased') throw new Error(JSON.stringify(r))
  return { ...run, head: r.head, remoteHead: r.remoteHead, commands: r.commands }
}
const bash = (run: Run, command: string) => judge({ tool: 'Bash', input: { command } }, run.worktree, run.commands, stat)
const allowed = (run: Run, tool: string, input: Record<string, unknown>) => isAllowed({ tool, input }, run.worktree, run.commands, stat)

// Layout and mode.
{
  const run = await runFor(seed, 'layout')
  check('L: worktree lives under $HOME/.cache/no-mistakes/<repo>-<hash>/<run>/wt', run.worktree.startsWith(`${home}/.cache/no-mistakes/seed-`) && run.worktree.endsWith('/layout/wt'), run.worktree)
  check('L: the cache root is mode 0700', (statSync(`${home}/.cache/no-mistakes`).mode & 0o777) === 0o700)
  check('L: gitFile and commonDir are recorded', run.gitFile.startsWith('gitdir: ') && run.commonDir === realpathSync(`${seed}/.git`), `${run.gitFile.trim()} / ${run.commonDir}`)
  await git.removeWorktree(run)
}

// Scenario A (#1): a teammate commit on origin/feat the local branch lacks.
const mate = `${root}/mate`
await sh(['git', 'clone', '-q', origin, mate], root)
await sh(['sh', '-c', 'git switch -q feat && echo mate > c.txt && git add . && git commit -qm "teammate commit" && git push -q origin feat'], mate)
const mateSha = await out(['git', 'rev-parse', 'refs/heads/feat'], origin)
{
  const run = await runFor(seed, 'a')
  const r = await git.rebase(run)
  check('A: rebase refuses a branch behind origin/feat', r.kind === 'behind', JSON.stringify(r))
  check('A: origin/feat is untouched', (await out(['git', 'rev-parse', 'refs/heads/feat'], origin)) === mateSha)
  await git.removeWorktree(run)
}

// Scenario B/C: local up to date, rebase passes, history moves.
await sh(['git', 'pull', '-q', '--ff-only', 'origin', 'feat'], seed)
{
  const run = await rebased(seed, 'b')
  check('B: commands are read from origin/main', JSON.stringify(run.commands) === JSON.stringify({ prepare: 'sh prepare.sh', test: 'sh test.sh', lint: 'sh lint.sh' }), JSON.stringify(run.commands))
  await sh(['git', 'commit', '-q', '--amend', '-m', 'rewritten'], run.worktree)
  const amended = await git.push(run)
  check('C: push refuses a rewritten head', !amended.ok && amended.reason.includes('does not descend'), JSON.stringify(amended))
  await sh(['git', 'reset', '-q', '--hard', run.head], run.worktree)
  await sh(['sh', '-c', 'echo more > d.txt && git add . && git commit -qm "teammate again" && git push -q origin feat'], mate)
  const moved = await git.push(run)
  check('B: push refuses when origin/feat moved after the rebase', !moved.ok && moved.reason.includes('moved'), JSON.stringify(moved))
  await git.removeWorktree(run)
  await sh(['git', 'pull', '-q', '--ff-only', 'origin', 'feat'], seed)
}

// No prune: a stale remote-tracking ref of the user's survives the mod's fetch.
await sh(['git', 'update-ref', 'refs/remotes/origin/old', 'HEAD'], seed)
{
  const run = await rebased(seed, 'noprune')
  check('N: fetch leaves the stale refs/remotes/origin/old alone', (await sh(['git', 'rev-parse', '--verify', '-q', 'refs/remotes/origin/old'], seed)).exitCode === 0)
  check('N: no tags were fetched', (await out(['git', 'tag'], seed)) === '')
  await git.removeWorktree(run)
}

// The mod's commit after a fixer edit: worktree only; prepare residue excluded.
{
  const run = await rebased(seed, 'commit')
  const featBefore = await out(['git', 'rev-parse', 'feat'], seed)
  writeFileSync(`${seed}/dirty.txt`, 'uncommitted user work')
  const prepared = await git.prepare(run)
  check('P: prepare ran', prepared.ok, JSON.stringify(prepared))
  check('P: prepare residue exists in the worktree and the tracked file it changed is restored', existsSync(`${run.worktree}/residue.txt`) && readFileSync(`${run.worktree}/a.txt`, 'utf8') === 'base\n')
  const prepared2 = { ...run, prepared: true as const, written: ['fix.txt'] }
  writeFileSync(`${run.worktree}/fix.txt`, 'from the fixer\n')
  const committed = await git.commitAll(prepared2, 'fix(no-mistakes/test): make the test check pass')
  check('P: the mod committed the fixer edit', committed.kind === 'committed', JSON.stringify(committed))
  const shown = await out(['git', 'show', '--stat', '--format=%s', 'HEAD'], run.worktree)
  check('P: the commit holds fix.txt and not residue.txt', shown.includes('fix.txt') && !shown.includes('residue.txt') && shown.startsWith('fix(no-mistakes/test)'), shown)
  check('P: the user branch did not move', (await out(['git', 'rev-parse', 'feat'], seed)) === featBefore)
  check('P: the user index and tree are untouched (dirty.txt still untracked, nothing staged)', (await out(['git', 'status', '--short'], seed)) === '?? dirty.txt')
  const clean = await git.commitAll(prepared2, 'x')
  check('P: a second commit with nothing changed is clean', clean.kind === 'clean', JSON.stringify(clean))
  const ran = await git.runCommand(run, run.commands.test!)
  check('P: the configured test command runs in the worktree', ran.exitCode === 0, JSON.stringify(ran))
  const pinned = await git.pinHead(run)
  check('P: the unpushed commit is pinned', pinned.kind === 'pinned', JSON.stringify(pinned))
  await git.removeWorktree(run)
  check('P: the recovery ref holds the fixer commit after removal', (await out(['git', 'show', '--stat', '--format=%s', `refs/no-mistakes/recover/${run.id}`], seed)).includes('fix.txt'))
}

// An excludesFile that does not exist (no prepare ran) does not break add.
{
  const run = await rebased(seed, 'noexclude')
  writeFileSync(`${run.worktree}/e.txt`, 'e\n')
  const committed = await git.commitAll({ ...run, written: ['e.txt'] }, 'fix(no-mistakes/review): fix round 1')
  check('X: commitAll commits an agent-written file', committed.kind === 'committed', JSON.stringify(committed))
  await git.removeWorktree(run)
}

// Wip pin on abort with uncommitted edits.
{
  const run = await rebased(seed, 'wip')
  writeFileSync(`${run.worktree}/half.txt`, 'half done\n')
  const wip = await git.commitAll({ ...run, written: ['half.txt'] }, 'wip(no-mistakes): uncommitted edits when the run ended')
  const pinned = await git.pinHead(run)
  await git.removeWorktree(run)
  const shown = await out(['git', 'show', '--stat', '--format=%s', `refs/no-mistakes/recover/${run.id}`], seed)
  check('W: uncommitted edits become a wip commit that is pinned and survives removal', wip.kind === 'committed' && pinned.kind === 'pinned' && shown.startsWith('wip(no-mistakes)') && shown.includes('half.txt'), shown)
}

// Probe 1: rewrite <wt>/.git to the user's gitdir.
{
  const run = await rebased(seed, 'gitdir')
  const featBefore = await out(['git', 'rev-parse', 'feat'], seed)
  check('G1: the guard allows no Write to <wt>/.git', !(await allowed(run, 'Write', { file_path: `${run.worktree}/.git`, content: 'x' })) && (await judge({ tool: 'Write', input: { file_path: `${run.worktree}/.git`, content: 'x' } }, run.worktree, run.commands, stat)) !== undefined)
  writeFileSync(`${run.worktree}/.git`, `gitdir: ${seed}/.git\n`)
  writeFileSync(`${run.worktree}/inject.txt`, 'injected\n')
  const committed = await git.commitAll(run, 'fix(no-mistakes/test): x')
  check('G1: the mod refuses to commit once .git was rewritten', committed.kind === 'error' && committed.detail.includes('.git was modified'), JSON.stringify(committed))
  check('G1: the user branch and index are untouched', (await out(['git', 'rev-parse', 'feat'], seed)) === featBefore && !(await out(['git', 'status', '--short'], seed)).includes('inject'))
  check('G1: reviewDiff, headOf and pinHead refuse too', (await git.headOf(run)) === undefined && (await git.pinHead(run)).kind === 'error')
  writeFileSync(`${run.worktree}/.git`, run.gitFile)
  await git.removeWorktree(run)
}

// Probe 2: a crafted in-worktree gitdir with fsmonitor and hooksPath.
{
  const run = await rebased(seed, 'fsmon')
  mkdirSync(`${run.worktree}/evil/objects`, { recursive: true })
  mkdirSync(`${run.worktree}/evil/refs/heads`, { recursive: true })
  mkdirSync(`${run.worktree}/evil/hooks`, { recursive: true })
  writeFileSync(`${run.worktree}/evil/HEAD`, 'ref: refs/heads/x\n')
  writeFileSync(`${run.worktree}/evil/config`, `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${root}/PWNED; false"\n\thooksPath = ${run.worktree}/evil/hooks\n`)
  writeFileSync(`${run.worktree}/evil/hooks/pre-commit`, `#!/bin/sh\ntouch ${root}/HOOK_PWNED\n`)
  await sh(['chmod', '+x', `${run.worktree}/evil/hooks/pre-commit`], root)
  check('G2: a crafted gitdir directory inside the worktree is itself a plain in-worktree write (only .git and intact() stand in the way)', await allowed(run, 'Write', { file_path: `${run.worktree}/evil/config`, content: 'x' }))
  writeFileSync(`${run.worktree}/.git`, `gitdir: ${run.worktree}/evil\n`)
  const broken = await git.intact(run)
  check('G2: intact() refuses the crafted gitdir', broken !== undefined, broken)
  const committed = await git.commitAll(run, 'x')
  check('G2: commitAll refuses', committed.kind === 'error')
  // Even a plain git status the mod might run with its flags executes nothing.
  await sh(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status'], run.worktree)
  await sh(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'commit', '--allow-empty', '-qm', 'x'], run.worktree)
  check('G2: with the mod flags neither fsmonitor nor the hook ran', !existsSync(`${root}/PWNED`) && !existsSync(`${root}/HOOK_PWNED`))
  await sh(['git', 'status'], run.worktree)
  check('G2: (control) plain git status in that worktree does run the fsmonitor', existsSync(`${root}/PWNED`))
  writeFileSync(`${run.worktree}/.git`, run.gitFile)
  await git.removeWorktree(run)
}

// Probe 3 to 6: shell spellings. Everything that is not a configured command is refused.
{
  const run = await rebased(seed, 'shell')
  const wt = run.worktree
  for (const c of [
    `git -C ${wt} commit -F ${home}/.ssh/id_rsa`,
    `git -C ${wt} add -A`,
    `git -C ${wt} commit -m x`,
    'git status',
    'git push origin HEAD:main',
    'git send-pack ../origin.git HEAD:refs/heads/main',
    'echo push | xargs git',
    'nice -n 5 git push',
    'env -C /repo git add -A',
    `cd ${wt} && sh test.sh`,
    `cd '${wt}' && sh test.sh && git push`,
    `cd '${wt}' && sh prepare.sh`,
    'cd ../../.. && git checkout -- .',
    'echo deadbeef > ../../refs/heads/main',
    'ls',
  ]) {
    check(`S: refused: ${c}`, (await bash(run, c)) !== undefined && !(await allowed(run, 'Bash', { command: c })))
  }
  for (const c of [`cd '${wt}' && sh test.sh`, `cd '${wt}' && sh lint.sh`, ` cd '${wt}' && sh lint.sh\n`]) {
    check(`S: allowed: ${JSON.stringify(c)}`, (await bash(run, c)) === undefined && (await allowed(run, 'Bash', { command: c })))
  }
  const mainBefore = await out(['git', 'rev-parse', 'main'], seed)
  const p1 = await sh(['sh', '-c', 'echo deadbeef > ../../refs/heads/main'], wt)
  check('S: even run by hand, ../../refs/heads/main from the worktree reaches nothing (cache dir, not .git)', p1.exitCode !== 0 && (await out(['git', 'rev-parse', 'main'], seed)) === mainBefore, p1.stderr.trim())
  const p2 = await sh(['sh', '-c', 'cd ../../.. && git checkout -- .'], wt)
  check('S: even run by hand, cd ../../.. lands outside any repository', p2.exitCode !== 0 && existsSync(`${seed}/dirty.txt`), p2.stderr.trim().split('\n')[0])
  check('S: Write ../../refs/heads/main is refused', (await judge({ tool: 'Write', input: { file_path: `${wt}/../../refs/heads/main`, content: 'x' } }, wt, run.commands, stat)) !== undefined)
  check('S: Read of <wt>/.git is refused', (await judge({ tool: 'Read', input: { file_path: `${wt}/.git` } }, wt, run.commands, stat)) !== undefined)
  check('S: Grep with the worktree path is allowed, without a path it is not', (await allowed(run, 'Grep', { pattern: 'x', path: wt })) && !(await allowed(run, 'Grep', { pattern: 'x' })))
  const diff = await git.reviewDiff(run)
  check('R: reviewDiff carries the stat and the patch', diff.includes('b.txt') && diff.includes('+local'), diff.slice(0, 200))
  await git.removeWorktree(run)
}

// Husky: a branch-controlled relative core.hooksPath with post-checkout and pre-commit hooks.
const husky = `${root}/husky`
await sh(['git', 'clone', '-q', origin, husky], root)
await sh(['sh', '-c', `git switch -q feat && git config core.hooksPath .husky && mkdir .husky && printf '#!/bin/sh\\necho "HOOK RAN: $0 in $(pwd)" >> ${root}/hook.log\\n' > .husky/post-checkout && cp .husky/post-checkout .husky/pre-commit && chmod +x .husky/* && git add -A && git commit -qm "add husky hooks"`], husky)
await sh(['rm', '-f', `${root}/hook.log`], root)
{
  const run = await rebased(husky, 'husky')
  check('H: the mod worktree add ran no post-checkout hook', !existsSync(`${root}/hook.log`), existsSync(`${root}/hook.log`) ? readFileSync(`${root}/hook.log`, 'utf8') : '')
  writeFileSync(`${run.worktree}/h.txt`, 'h\n')
  const committed = await git.commitAll({ ...run, written: ['h.txt'] }, 'fix(no-mistakes/lint): h')
  check('H: the mod commit ran no pre-commit hook', committed.kind === 'committed' && !existsSync(`${root}/hook.log`), existsSync(`${root}/hook.log`) ? readFileSync(`${root}/hook.log`, 'utf8') : '')
  await sh(['git', 'commit', '--allow-empty', '-qm', 'control'], run.worktree)
  check('H: (control) a plain git commit in that worktree does run the hook', existsSync(`${root}/hook.log`) && readFileSync(`${root}/hook.log`, 'utf8').includes('pre-commit'))
  await sh(['rm', '-f', `${root}/hook.log`], root)
  await sh(['git', '-C', husky, 'worktree', 'add', '-q', '--detach', `${root}/plainwt`, 'HEAD'], root)
  check('H: (control) a plain git worktree add does run post-checkout', existsSync(`${root}/hook.log`) && readFileSync(`${root}/hook.log`, 'utf8').includes('post-checkout'))
  await git.removeWorktree(run)
}

// A relative remote URL must still fetch and push from the cache-dir worktree.
await sh(['git', 'remote', 'set-url', 'origin', '../origin.git'], seed)
await sh(['sh', '-c', 'echo rel > g.txt && git add . && git commit -qm "relative remote"'], seed)
{
  const run = await rebased(seed, 'rel')
  const pushed = await git.push(run)
  check('R: push works through a relative remote URL', pushed.ok, JSON.stringify(pushed))
  check('R: origin/feat is the pushed head', (await out(['git', 'rev-parse', 'refs/heads/feat'], origin)) === run.head)
  await git.removeWorktree(run)
}

await import('./round4.ts').then(m => m.round4({ git, judge, isAllowed, stat, sh, out, check, runFor, rebased, root, home, setIdent: (on: boolean) => (ident = on) }))
await import('./round5.ts').then(m => m.round5({ git, sh, out, check, runFor, rebased, root }))

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

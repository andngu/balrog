import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

export async function userConfigAndCheckout(h: any): Promise<void> {
  const { git, judge, isAllowed, stat, sh, out, check, runFor, rebased, root, home, setIdent } = h
  const origin = `${root}/r4-origin.git`
  const seed = `${root}/r4-seed`
  const g = (cwd: string, ...args: string[]) => sh(['git', ...args], cwd)
  await sh(['git', 'init', '-q', '--bare', origin], root)
  await sh(['git', 'init', '-q', '-b', 'main', seed], root)
  writeFileSync(`${seed}/.no-mistakes.yaml`, 'commands:\n  prepare: "sh prepare.sh"  # deps\n  test: sh test.sh\n')
  writeFileSync(`${seed}/prepare.sh`, 'mkdir -p node_modules/x && echo dep > node_modules/x/index.js && echo res > weird1.txt\n')
  writeFileSync(`${seed}/test.sh`, 'mkdir -p coverage __pycache__ && echo cov > coverage/lcov.info && echo pyc > __pycache__/m.pyc\n')
  writeFileSync(`${seed}/base.txt`, 'base\n')
  await sh(['sh', '-c', `git add . && git commit -qm base && git remote add origin ${origin} && git push -q origin main && git remote set-head origin main`], seed)
  await sh(['sh', '-c', `git switch -qc feat && printf '*.js -diff\\n' > .gitattributes && echo 'const secret = 1' > app.js && git add . && git commit -qm "feat one" && echo two > two.txt && git add . && git commit -qm "feat two" && git branch part1 HEAD~1 && git tag -a v1 -m v1 HEAD && git push -q origin feat`], seed)
  // Base moves so the rebase rewrites both feat commits.
  await sh(['sh', '-c', `git switch -q main && echo more > more.txt && git add . && git commit -qm "main moves" && git push -q origin main && git switch -q feat`], seed)
  writeFileSync(`${home}/.gitignore_global`, '*.secret\n')
  await g(seed, 'config', '--global', 'rebase.updateRefs', 'true')
  await g(seed, 'config', '--global', 'push.followTags', 'true')
  await g(seed, 'config', '--global', 'core.excludesFile', `${home}/.gitignore_global`)
  writeFileSync(`${seed}/.env.local`, 'TOKEN=hunter2\n')

  const part1 = await out(['git', 'rev-parse', 'part1'], seed)
  const run = await rebased(seed, 'r4')
  const wt = run.worktree
  check('R4-5: the rebase rewrote the feat commits (so update-refs had something to move)', (await out(['git', 'rev-parse', 'HEAD~1'], wt)) !== part1)
  check('R4-5: with rebase.updateRefs=true the user branch part1 did not move', (await out(['git', 'rev-parse', 'part1'], seed)) === part1)

  const diff = await git.reviewDiff(run).then(r => r.ok ? r.text : r.reason)
  check('R4-6: a -diff attribute in the branch does not hide app.js from the reviewer', diff.includes('+const secret = 1') && !diff.includes('Binary files'), diff.slice(0, 400))
  const plain = await out(['git', 'diff', 'origin/main...HEAD', '--', 'app.js'], wt)
  check('R4-6: (control) a plain git diff shows Binary files differ', plain.includes('Binary files'), plain)

  const env = `${seed}/.env.local`
  check('R4-1: Read of the user checkout .env.local is refused', (await judge({ tool: 'Read', input: { file_path: env } }, wt, run.commands, stat)) !== undefined && !(await isAllowed({ tool: 'Read', input: { file_path: env } }, wt, run.commands, stat)))
  check('R4-1: Grep over the user checkout, and Grep without a path, are refused', (await judge({ tool: 'Grep', input: { pattern: 'TOKEN', path: seed } }, wt, run.commands, stat)) !== undefined && (await judge({ tool: 'Grep', input: { pattern: 'TOKEN' } }, wt, run.commands, stat)) !== undefined)
  check('R4-1: Read inside the worktree is allowed', (await judge({ tool: 'Read', input: { file_path: `${wt}/app.js` } }, wt, run.commands, stat)) === undefined && (await isAllowed({ tool: 'Read', input: { file_path: `${wt}/app.js` } }, wt, run.commands, stat)))
  for (const pattern of [`${seed}/.env*`, '../../../../r4-seed/.env*', '~/.gitconfig']) {
    check(`R4-2: Glob pattern ${pattern} under the worktree path is refused`, (await judge({ tool: 'Glob', input: { pattern, path: wt } }, wt, run.commands, stat)) !== undefined)
  }
  check('R4-2: a relative Glob pattern under the worktree is allowed', await isAllowed({ tool: 'Glob', input: { pattern: '**/*.js', path: wt } }, wt, run.commands, stat))

  symlinkSync(`${seed}/planted.txt`, `${wt}/link`)
  check('R4-9: Write through a dangling link that points into the user checkout is refused', (await judge({ tool: 'Write', input: { file_path: `${wt}/link`, content: 'x' } }, wt, run.commands, stat)) !== undefined && !(await isAllowed({ tool: 'Write', input: { file_path: `${wt}/link`, content: 'x' } }, wt, run.commands, stat)))
  writeFileSync(`${wt}/link`, 'x')
  check('R4-9: (control) writing through that link lands in the user checkout', existsSync(`${seed}/planted.txt`))
  rmSync(`${seed}/planted.txt`)
  rmSync(`${wt}/link`)
  check('R4-10: Write to <wt>/.GIT/config and <wt>/.Git is refused', (await judge({ tool: 'Write', input: { file_path: `${wt}/.GIT/config`, content: 'x' } }, wt, run.commands, stat)) !== undefined && (await judge({ tool: 'Write', input: { file_path: `${wt}/.Git`, content: 'x' } }, wt, run.commands, stat)) !== undefined)

  const prepared = await git.prepare(run)
  const tested = await git.runCommand(run, run.commands.test)
  check('R4-7: prepare and test ran and left residue', prepared.ok && tested.exitCode === 0 && existsSync(`${wt}/node_modules/x/index.js`) && existsSync(`${wt}/coverage/lcov.info`) && existsSync(`${wt}/__pycache__/m.pyc`) && existsSync(`${wt}/weird1.txt`))
  writeFileSync(`${wt}/fix2.txt`, 'agent\n')
  writeFileSync(`${wt}/x.secret`, 'agent but globally ignored\n')
  writeFileSync(`${wt}/weird[1].txt`, 'agent, glob characters\n')
  writeFileSync(`${wt}/app.js`, 'const secret = 2\n')
  const committed = await git.commitAll({ ...run, prepared: true, written: ['fix2.txt', 'x.secret', 'weird[1].txt', 'app.js'] }, 'fix(no-mistakes/test): make the test check pass')
  const files = (await out(['git', 'show', '--name-only', '--format=', 'HEAD'], wt)).split('\n').sort()
  check('R4-7: the commit holds exactly the agent edits: app.js, fix2.txt, weird[1].txt', committed.kind === 'committed' && JSON.stringify(files) === JSON.stringify(['app.js', 'fix2.txt', 'weird[1].txt']), JSON.stringify({ committed, files }))
  check('R4-7: the global core.excludesFile still applies (x.secret not committed) and is the user value', !files.includes('x.secret') && (await out(['git', 'config', 'core.excludesFile'], wt)) === `${home}/.gitignore_global`)

  const commits = await git.pipelineCommits(run).then(r => r.ok ? r.text : r.reason)
  check('R4-11: pipelineCommits lists the mod commit with its subject and stat', commits.includes('fix(no-mistakes/test): make the test check pass') && commits.includes('fix2.txt') && !commits.includes('feat one'), commits)

  const pushed = await git.push(run)
  const tags = await out(['git', 'ls-remote', '--tags', origin], root)
  check('R4-5: with push.followTags=true the push sent no tag', pushed.ok && tags === '', JSON.stringify({ pushed, tags }))
  await g(seed, 'push', '-q', 'origin', 'feat:refs/heads/ctl')
  check('R4-5: (control) a plain push with that config does send v1', (await out(['git', 'ls-remote', '--tags', origin], root)).includes('refs/tags/v1'))
  await git.removeWorktree(run)
  {
    const ctl = `${root}/r4-ctl`
    await g(seed, 'worktree', 'add', '-q', '--detach', ctl, 'feat')
    await g(ctl, 'rebase', '-q', 'origin/main')
    check('R4-5: (control) a plain rebase with that config does move part1', (await out(['git', 'rev-parse', 'part1'], seed)) !== part1)
    await g(seed, 'worktree', 'remove', '--force', ctl)
    await g(seed, 'branch', '-f', 'part1', part1)
  }

  // Setup failures: no identity, and signing that is on and broken.
  await sh(['sh', '-c', 'git fetch -q origin && git reset -q --hard origin/feat'], seed)
  await sh(['sh', '-c', 'git switch -q main && echo again > again.txt && git add . && git commit -qm "main again" && git push -q origin main && git switch -q feat'], seed)
  await g(seed, 'config', 'user.useConfigOnly', 'true')
  setIdent(false)
  {
    const bare = await runFor(seed, 'r4-noident')
    const r = await git.rebase(bare)
    check('R4-12: a rebase with no git identity says so instead of calling it a conflict', r.kind === 'error' && r.detail.includes('git identity not set'), JSON.stringify(r))
    await git.removeWorktree(bare)
  }
  setIdent(true)
  {
    const r12 = await rebased(seed, 'r4-commit-noident')
    writeFileSync(`${r12.worktree}/n.txt`, 'n\n')
    setIdent(false)
    const c = await git.commitAll({ ...r12, written: ['n.txt'] }, 'fix(no-mistakes/review): fix round 1')
    setIdent(true)
    check('R4-12: a commit with no git identity is a setup error that says so', c.kind === 'error' && c.isSetup === true && c.detail.includes('git identity not set'), JSON.stringify(c))
    await g(seed, 'config', 'commit.gpgsign', 'true')
    await g(seed, 'config', 'gpg.program', '/bin/false')
    const s = await git.commitAll({ ...r12, written: ['n.txt'] }, 'fix(no-mistakes/review): fix round 1')
    check('R4-12: a commit with broken signing is a setup error that says so', s.kind === 'error' && s.isSetup === true && s.detail.includes('commit signing failed'), JSON.stringify(s))
    await git.removeWorktree(r12)
  }
  await sh(['sh', '-c', 'git switch -q main && echo third > third.txt && git -c commit.gpgsign=false add . && git -c commit.gpgsign=false commit -qm "main third" && git push -q origin main && git switch -q feat'], seed)
  {
    const signed = await runFor(seed, 'r4-sign')
    const r = await git.rebase(signed)
    check('R4-12: a rebase with broken signing says so instead of calling it a conflict', r.kind === 'error' && r.detail.includes('commit signing failed'), JSON.stringify(r))
    await git.removeWorktree(signed)
  }
  await g(seed, 'config', '--unset', 'commit.gpgsign')
  await g(seed, 'config', '--unset', 'user.useConfigOnly')

  // A block scalar in the config on origin/main fails the rebase step.
  await sh(['sh', '-c', `git switch -q main && printf 'commands:\\n  test: >-\\n    sh test.sh\\n' > .no-mistakes.yaml && git add . && git commit -qm "folded config" && git push -q origin main && git switch -q feat`], seed)
  {
    const bad = await runFor(seed, 'r4-config')
    const r = await git.rebase(bad)
    check('R4-8: test: >- on origin/main is an error naming the file, not a command', r.kind === 'error' && r.detail.includes('.no-mistakes.yaml on origin/main') && r.detail.includes('commands.test'), JSON.stringify(r))
    await git.removeWorktree(bad)
  }
  void mkdirSync
}

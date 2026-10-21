// Round-5 real-git checks, run from realgit.ts with its helpers.
import { mkdirSync, writeFileSync } from 'node:fs'

export async function round5(h: any): Promise<void> {
  const { git, sh, out, check, runFor, rebased, root } = h
  const origin = `${root}/r5-origin.git`
  const seed = `${root}/r5-seed`
  const g = (cwd: string, ...args: string[]) => sh(['git', ...args], cwd)
  await sh(['git', 'init', '-q', '--bare', origin], root)
  await sh(['git', 'init', '-q', '-b', 'main', seed], root)
  await sh(['sh', '-c', `echo a > header.txt && echo a > footer.txt && git add . && git commit -qm base && git remote add origin ${origin} && git push -q origin main && git remote set-head origin main`], seed)
  await sh(['sh', '-c', 'git switch -qc feat && echo b > header.txt && git add . && git commit -qm "Redesign the header" && git push -q origin feat'], seed)
  await sh(['sh', '-c', 'git switch -qc feat2 main && echo b > footer.txt && git add . && git commit -qm "gpg failed to sign the data, cannot run gpg" && git push -q origin feat2'], seed)
  await sh(['sh', '-c', 'git switch -q main && echo c > header.txt && echo c > footer.txt && git add . && git commit -qm "main moves" && git push -q origin main'], seed)

  for (const [branch, subject] of [['feat', 'Redesign the header'], ['feat2', 'gpg failed to sign the data, cannot run gpg']]) {
    await g(seed, 'switch', '-q', branch)
    const run = await runFor(seed, `r5-${branch}`)
    const r = await git.rebase(run)
    check(`R5-2: a conflict on a commit subject "${subject}" is reported as a conflict, not a signing failure`, r.kind === 'conflict', JSON.stringify(r).slice(0, 300))
    await git.removeWorktree(run)
  }
  await g(seed, 'config', 'commit.gpgsign', 'true')
  await g(seed, 'config', 'gpg.program', '/bin/false')
  {
    await g(seed, 'switch', '-q', 'feat')
    const run = await runFor(seed, 'r5-signed-conflict')
    const r = await git.rebase(run)
    check('R5-2: with signing on and broken, a conflict is still a conflict', r.kind === 'conflict', JSON.stringify(r).slice(0, 300))
    await git.removeWorktree(run)
  }
  await g(seed, 'config', '--unset', 'commit.gpgsign')
  await g(seed, 'config', '--unset', 'gpg.program')

  // A branch that does not conflict, for the commit checks.
  await sh(['sh', '-c', `git switch -q main && printf '*.lock -diff\\n' > .gitattributes && echo one > pkg.lock && git add . && git commit -qm "lockfile" && git push -q origin main`], seed)
  await sh(['sh', '-c', `git switch -qc feat3 main && printf '*.bin -diff\\n' >> .gitattributes && echo one > data.bin && git add . && git commit -qm "feat three" && git push -q origin feat3`], seed)
  const run = await rebased(seed, 'r5-commit')
  const wt = run.worktree
  mkdirSync(`${wt}/d`)
  writeFileSync(`${wt}/d/x.txt`, 'residue\n')
  writeFileSync(`${wt}/d/y.txt`, 'residue\n')
  writeFileSync(`${wt}/e.txt`, 'agent\n')
  writeFileSync(`${wt}/data.bin`, 'two\n')
  writeFileSync(`${wt}/pkg.lock`, 'two\n')
  const committed = await git.commitAll({ ...run, written: ['d', 'e.txt'] }, 'fix(no-mistakes/test): make the test check pass')
  const files = (await out(['git', 'show', '--name-only', '--format=', 'HEAD'], wt)).split('\n').sort()
  check('R5-4: a recorded path that became a directory commits nothing under it; the exact entry e.txt is committed', committed.kind === 'committed' && JSON.stringify(files) === JSON.stringify(['data.bin', 'e.txt', 'pkg.lock']), JSON.stringify({ committed, files }))

  const commits = await git.pipelineCommits(run)
  check('R5-5: pipelineCommits shows a file the branch marks -diff as text lines, not Bin', /data\.bin +\| +2 \+-/.test(commits), commits)
  check('R5-5: a -diff of origin/main (the lockfile) still applies', /pkg\.lock +\| Bin/.test(commits), commits)
  const plain = await out(['git', 'log', '--format=%h %s', '--stat', `${run.head}..HEAD`], wt)
  check('R5-5: (control) a plain git log --stat shows data.bin as Bin', /data\.bin +\| Bin/.test(plain), plain)
  await git.removeWorktree(run)
}

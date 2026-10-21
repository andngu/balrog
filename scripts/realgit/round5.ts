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
}

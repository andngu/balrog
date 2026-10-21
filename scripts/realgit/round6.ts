// Round-6 real-git checks, run from realgit.ts with its helpers.
export async function round6(h: any): Promise<void> {
  const { git, sh, out, check, rebased, root } = h
  const origin = `${root}/r6-origin.git`
  const seed = `${root}/r6-seed`
  await sh(['git', 'init', '-q', '--bare', origin], root)
  await sh(['git', 'init', '-q', '-b', 'main', seed], root)
  await sh(['sh', '-c', `echo one > data.bin && echo a > a.txt && git add . && git commit -qm base && git remote add origin ${origin} && git push -q origin main && git remote set-head origin main`], seed)
  await sh(['sh', '-c', `git switch -qc feat && printf '*.bin -diff\\n' > .gitattributes && echo two > data.bin && git add . && git commit -qm "hide data.bin" && git push -q origin feat`], seed)

  const run = await rebased(seed, 'r6-stat')
  const stat = await git.diffStat(run)
  check('R6-6: diffStat shows a file the branch marks -diff as text lines, not Bin', /data\.bin +\| +2 \+-/.test(stat), stat)
  const plain = await out(['git', 'diff', '--text', '--stat', 'origin/main...HEAD'], run.worktree)
  check('R6-6: (control) a plain git diff --text --stat shows data.bin as Bin', /data\.bin +\| Bin/.test(plain), plain)
  await git.removeWorktree(run)

  for (const [url, expected] of [
    ['git@github.com:o/r.git', 'github.com o/r o/r'],
    ['https://github.com/o/r', 'github.com o/r o/r'],
    ['https://x-access-token@github.com/o/r.git/', 'github.com o/r o/r'],
    ['https://x-access-token:s3cret@github.com/o/r.git', 'github.com o/r o/r'],
    ['ssh://git@ghe.example.com:2222/team/svc.git', 'ghe.example.com team/svc ghe.example.com/team/svc'],
    ['../r6-origin.git', 'error'],
    ['https://x-access-token:s3cret@example.com/only-one-segment', 'error'],
    [origin, 'error'],
  ] as const) {
    await sh(['git', 'remote', 'set-url', 'origin', url], seed)
    const target = await git.ghRepo(run)
    const got = 'error' in target ? 'error' : `${target.host} ${target.path} ${target.slug}`
    check(`R6-8: origin ${url} is ${expected}`, got === expected && !JSON.stringify(target).includes('s3cret'), JSON.stringify(target))
  }
  await sh(['git', 'remote', 'set-url', 'origin', origin], seed)
}

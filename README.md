# no-mistakes

A Claude Code mod port of [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT).

`/no-mistakes [intent]` gates the current feature branch: rebase onto `origin/<default>`, adversarial review, test, document, lint, push with a lease, PR, CI watch. Every step runs in a disposable detached worktree under `~/.cache/no-mistakes/` (mode 0700), never in your checkout. Blocking findings park the run in a pane where you fix, approve, skip or abort.

## Who runs what

- The mod runs every `git` call itself, always with `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false`, so no hook of the branch's making (a husky `core.hooksPath`, a crafted gitdir) executes. The rebase passes `--no-update-refs --no-autostash`, the push `--no-follow-tags --recurse-submodules=no`, the fetch `--no-tags --no-recurse-submodules`, so your `rebase.updateRefs`, `rebase.autoStash` and `push.followTags` cannot move your other branches, your stash or your tags. It fetches only `refs/heads/<default>` and `refs/heads/<branch>`, never with `--prune`. Before any git in the worktree it checks that `<worktree>/.git` still holds what it wrote and that `git rev-parse --git-common-dir` is still your repository; otherwise it refuses and the run fails.
- The mod commits every change to a tracked file, and of the untracked files only those at a path a pipeline agent wrote with `Write`, `Edit` or `NotebookEdit` (that path exactly, nothing that later appears under it), minus what your ignore rules (your global `core.excludesFile` included) ignore. The path is recorded before the write runs, and a write the mod cannot record is refused. What a configured command leaves behind (`node_modules`, `coverage`, caches) is never committed. The pane lists the mod's own commits once the push step has run, and the PR body ends with the same list; its stat reads attributes from `origin/<default>` (git 2.40 or newer), so a `-diff` the branch adds cannot show code as `Bin`.
- Every `gh` call after `gh auth status` names origin's repository with `--repo`, read from origin's URL, so a PR is never opened against, and CI never read from, an `upstream` remote gh would pick on its own; an origin that names no GitHub repository skips the PR step with that reason. The PR step adopts only an open PR from origin's own `<branch>` (never a merged or closed one, or a fork's of the same name) and otherwise opens one. A failing CI check sends the fixer the failed log of the pushed head only.
- The CI step passes only when every check that ran on the pushed head passed; a skipped check counts for nothing. A repository with no Actions workflow skips the step after 2 minutes with a "no CI" reason. When workflows exist but no check ran within 5 minutes (none reported, or all skipped by path filters or by not running on pull requests), the step parks on a `ci:no-checks` finding for you to approve or abort, instead of waiting out the 30-minute timeout that parks still-pending checks.
- The reviewer gets the diff in its prompt (`git diff --text`, so a `-diff` attribute in the branch cannot hide code) and `Read`, `Grep`, `Glob` over the worktree. Nothing else.
- The fixer gets `Read`, `Edit`, `Write` over the worktree (`Grep` and `Glob` too where the build registers them beside `Bash`; the native Linux build does not, so its prompt names the files the change touches), and a `Bash` that the mod lets through only for the configured test, lint and format commands, spelled exactly as `cd '<worktree>' && <command>`. It has no git: the mod commits whatever it changed as soon as it answers, or once it is stopped for running 30 minutes without an answer.
- An agent's answer ends with its findings as JSON: a fenced ```json block, or else the last bare `{"findings": [...]}` object in it. An answer with neither is sent back to the same agent once, asking for the block alone; a second unreadable answer fails the run closed.
- A finding id an agent chooses must be a short slug (letters, digits, `.`, `_`, `:`, `-`; at most 32 characters) or the mod replaces it, and a CI check name becomes a slugged `ci:<name>` id. These ids are the only agent- or branch-chosen text in the record of your decisions that every later prompt carries; descriptions, check names, logs, diffs and stats go into prompts marked as untrusted data, each inside a tag with a fresh random name, unchanged: nothing in the data can close the tag, so nothing is rewritten to keep it shut.
- `tool.call` refuses a pipeline agent, whatever your rules say, any read or write outside the worktree, anything at a `.git` entry (in any letter case), a write through a link that resolves nowhere, `Grep` or `Glob` without a path, a `Glob` pattern that is absolute or climbs with `..`, and any `Bash` command that is not a configured one.
- `tool.check` consults the engine first and keeps any deny or ask that stands on your settings rules, a PreToolUse hook or a permission setting. Only then does it allow in-worktree calls without an ask.
- The PR body is written by a model from the intent, the diff stat, the step statuses, your decisions and the blocking findings you approved as is. Agent-written text goes in marked as untrusted data, and informational findings stay out of it.

## Configuration

`.no-mistakes.yaml` is read from `origin/<default>` only, never from the branch under review:

```yaml
commands:
  prepare: npm ci          # once per worktree, before the first command
  test: node add.test.mjs  # the test step; no command parks the step
  lint: npm run lint       # the lint step; no command parks the step
  format: prettier -w .    # before the push; its changes become a commit
```

Each value is one line, plain or quoted (`"..."` reads only `\"` and `\\` escapes). A block (`>-`, `|`), flow (`[...]`, `{...}`), nested or unknown key, or an unclosed quote fails the run at the rebase step with the line it could not read; it never runs as a command.

## Trust model

What the mod runs on your behalf is not held to your permission rules or sandbox:

- The configured commands run as `sh -c <command>` in the worktree, as you, with no sandbox and your full environment (`GH_TOKEN`, cloud credentials, SSH agent). They run code the branch can change: `npm test` runs the branch's tests and `package.json` scripts, and the fixer may have edited both. Configure only commands you would run by hand on this branch.
- The mod's own `git` and `gh` calls (fetch, rebase, commit, push, `gh pr create`, `gh pr checks`, `gh run view`) run outside your permission rules, with your credentials.
- A failing test or lint command goes to the fixer once with the output; the mod commits the fixer's edits and re-runs the command, and a command that still fails parks the step. The fixer's commits are not reviewed again by the reviewer.

Known limitations: hooks are off for every git call, so a `pre-push` hook such as git-lfs's does not run, and LFS objects of the branch are not uploaded by the push. Run `git lfs push origin <branch>` yourself where the repository uses LFS. A tool output too large for the transcript may be saved by the engine outside the worktree, where the agents cannot read it.

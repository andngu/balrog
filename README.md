# no-mistakes

A Claude Code mod port of [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT).

`/no-mistakes [intent]` gates the current feature branch: rebase onto `origin/<default>`, adversarial review, test, document, lint, push with a lease, PR, CI watch. Every step runs in a disposable detached worktree under `~/.cache/no-mistakes/` (mode 0700), never in your checkout. Blocking findings park the run in a pane where you fix, approve, skip or abort, or you decide from the chat with `/no-mistakes-fix [finding ids]`, `/no-mistakes-approve`, `/no-mistakes-skip` and `/no-mistakes-abort`. `/no-mistakes-status` reopens the pane and reports the run.

## Install

You need:

- Claude Code with mod support.
- git. Version 2.40 or newer keeps the base-attribute protection described under [Who runs what](#who-runs-what). Older git works without it.
- `gh`, logged in (`gh auth status`), for the PR and CI steps.

Add this repository as a marketplace, then install the mod from it:

```sh
claude plugin marketplace add andngu/no-mistakes
claude plugin install no-mistakes@no-mistakes
```

To install from a local clone, give its path to `marketplace add` instead of `andngu/no-mistakes`.

The install enables the mod. Check with `claude plugin list`; the entry reads `Status: ✔ enabled`. If it reads `Status: ✘ disabled`, run `claude plugin enable no-mistakes@no-mistakes`. Restart Claude Code to load the mod.

## Quick start

1. Check out a feature branch and commit your work.
2. Put a `.no-mistakes.yaml` on the default branch. See [Configuration](#configuration). The mod reads it from `origin/<default>` only.
3. Run `/no-mistakes <intent>`, where the intent says what the branch is for.
4. Watch the pane. When a step parks, act on its findings as described under [The pane](#the-pane).
5. Run `/no-mistakes-status` to reopen the pane. It also prints the state of the last run.

## The pane

The pane is a board of the eight steps, one row each. A row holds a glyph and the step's latest fact: the command it runs, how long it has run against its 30-minute limit, the findings it parked on, the reason it was skipped or failed, or the PR as a link. A fix round reads `fix round N`, or `auto-fixing (fix round N)` when the pipeline chose it: a failing CI check, or a finding under `autofix`. The status line says `auto-fixing` the same way. A step past 25 minutes turns to the warning colour and says when it times out. The board redraws on every state change, and every 30 seconds while a step runs.

When a step parks, the findings are listed under the board, one row each. A row shows the severity, whether the finding is fixable, your call or needs no action, the file and line when the agent named one, and the first line of the description. Only the blocking findings start selected, and `[x]` marks a selected one. Press a digit, `1` to `9`, to toggle the finding it marks; a finding past the ninth has no digit, so click its row. Press `f` to send the selected findings to the fixer, `a` to approve every finding as is, `s` to skip the step, or `x` to abort. The headline above the findings says how many of the three fix rounds are left, and the Fix button says how many findings it would send, or that no round is left. In the terminal, keys reach the pane only while it has the keyboard, after `ctrl+x tab` or a click, and the pane says so until then.

When the run ends, the board keeps every step's last fact, except that a step still running when the run ends reads `stopped`. Under it come the outcome and what is left for you to do, each command on its own line: pull the pushed commits into your branch, remove a kept worktree, or recover or drop the commits the run pinned.

You can make the same decisions from the chat. `/no-mistakes-approve`, `/no-mistakes-skip` and `/no-mistakes-abort` do what `a`, `s` and `x` do. Approve and skip answer before the next step starts, and that step then runs in the background, as it does from the pane. An abort while a step is starting, such as a push that is still running, waits until that step settles, and the answer says so. `/no-mistakes-fix` sends the selected findings to the fixer. `/no-mistakes-fix r1 r2` sends exactly those findings, and they become the selection when the fix starts. Only `/no-mistakes-fix` takes finding ids.

Each command answers in text with what it did, or why it refused. It refuses when there is no run, when the run already ended or is finishing, when the step is not parked (it names the step and what it is doing), when another press or command decided the step first (it says the step was decided meanwhile), when no fix round is left, or when nothing is selected. It also refuses an id that is not one of the parked step's findings, and ids given to a command that takes none. In both of those cases it changes nothing.

While a step is parked, `/no-mistakes-status` lists every finding in full: its id, severity, action, file and line, whether it is selected, and the whole description. It also says how many fix rounds are left. Once the run ends, it gives the outcome and the follow-up commands. The findings and the note reach your session as untrusted data, as the run note does.

## Who runs what

- The mod runs every `git` call itself, always with `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false`, so no hook of the branch's making (a husky `core.hooksPath`, a crafted gitdir) executes. The rebase passes `--no-update-refs --no-autostash`, the push `--no-follow-tags --recurse-submodules=no`, the fetch `--no-tags --no-recurse-submodules`, so your `rebase.updateRefs`, `rebase.autoStash` and `push.followTags` cannot move your other branches, your stash or your tags. It fetches only `refs/heads/<default>` and `refs/heads/<branch>`, never with `--prune`. Before any git in the worktree it checks that `<worktree>/.git` still holds what it wrote and that `git rev-parse --git-common-dir` is still your repository; otherwise it refuses and the run fails.
- The mod commits every change to a tracked file, and of the untracked files only those at a path a pipeline agent wrote with `Write`, `Edit` or `NotebookEdit` (that path exactly, nothing that later appears under it), minus what your ignore rules (your global `core.excludesFile` included) ignore. The path is recorded before the write runs, a write the mod cannot record is refused, and a write that a later hook or setting refuses, or that fails or throws, has its record taken back. What a configured command leaves behind (`node_modules`, `coverage`, caches) is never committed. The pane lists the mod's own commits once the push step has run, and the PR body ends with the same list. Its stat, and the diff stat the reviewer, the fixer and the PR body writer get, read attributes from `origin/<default>` (git 2.40 or newer), so a `-diff` the branch adds cannot show code as `Bin`.
- Every `gh` call after `gh auth status` names origin's repository with `--repo`, read from origin's URL, so a PR is never opened against, and CI never read from, an `upstream` remote gh would pick on its own; an origin that names no GitHub repository skips the PR step with that reason. The PR step adopts only an open PR from origin's own `<branch>` (never a merged or closed one, or a fork's of the same name) and otherwise opens one. A failing CI check sends the fixer the failed log of the pushed head only.
- The CI step passes only when every check that ran on the pushed head passed; a skipped check counts for nothing. A repository with no Actions workflow skips the step after 2 minutes with a "no CI" reason. When workflows exist but no check ran within 5 minutes (none reported, or all skipped by path filters or by not running on pull requests), the step parks on a `ci:no-checks` finding for you to approve or abort, instead of waiting out the 30-minute timeout that parks still-pending checks.
- The reviewer gets the diff in its prompt (`git diff --text`, so a `-diff` attribute in the branch cannot hide code, minus the `review.exclude` paths, which the prompt names) and `Read`, `Grep`, `Glob` over the worktree. Nothing else.
- The fixer gets `Read`, `Edit`, `Write` over the worktree (`Grep` and `Glob` too where the build registers them beside `Bash`; the native Linux build does not, so its prompt names the files the change touches), and a `Bash` that the mod lets through only for the configured test, lint and format commands, spelled exactly as `cd '<worktree>' && <command>`. It has no git: the mod commits whatever it changed as soon as it answers, or once it is stopped for running 30 minutes without an answer. An agent that cannot be stopped fails the run instead, and the worktree is kept for you to remove once it ends.
- An agent's answer ends with its findings as JSON: a fenced ```json block (the last one, which must parse) or, when the answer has no such block, a bare `{"findings": [...]}` object only when the agent put a `Findings JSON:` line directly before it and the object ends the answer. Anything else, including a quoted object in the middle of prose, is not read. An answer with neither is sent back to the same agent once, asking for the block alone; a second unreadable answer fails the run closed.
- A finding id an agent chooses must be a short slug (letters, digits, `.`, `_`, `:`, `-`; at most 32 characters) or the mod replaces it, and a CI check name becomes a slugged `ci:<name>` id. These ids are the only agent- or branch-chosen text in the record of your decisions that every later prompt carries; descriptions, check names, logs, diffs and stats go into prompts marked as untrusted data, each inside a tag with a fresh random name, unchanged: nothing in the data can close the tag, so nothing is rewritten to keep it shut. A run that ends before `/no-mistakes` returns (a rebase conflict, which quotes the branch's commit subjects) hands its note back to your session the same way.
- `tool.call` refuses every call of a pipeline agent whose step has moved on (it answered, or timed out), and of every pipeline agent once the run has ended. It refuses the current step's agent, whatever your rules say, any read or write outside the worktree, anything at a `.git` entry (in any letter case), a write through a link that resolves nowhere, `Grep` or `Glob` without a path, a `Glob` pattern that is absolute or climbs with `..`, and any `Bash` command that is not a configured one.
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
review:
  exclude:                 # left out of the diff and stat the agents see
    - package-lock.json
    - "dist/*"
autofix: true              # auto-fix findings go to the fixer with no press
```

Each value is one line, plain or quoted (`"..."` reads only `\"` and `\\` escapes). A block (`>-`, `|`), flow (`[...]`, `{...}`), nested or unknown key, or an unclosed quote fails the run at the rebase step with the line it could not read; it never runs as a command.

`autofix: true` sends a parked step's findings to the fixer without a press when every blocking finding is one the agent marked `auto-fix` and a fix round is left. The decision is recorded as the pipeline's, the fixer gets the prompt a press would send, and the round counts against the same three. One `ask-user` finding, or no round left, parks the step as before with every finding listed, the `auto-fix` ones included. For the test and lint steps, a fix round sets the step back to pending and the command runs again. A command that still fails goes to the fixer with its output again, and a command that fails again parks on an `auto-fix` finding, so the next automatic round starts. A command that never passes therefore runs the fixer up to seven times (the fixer with the output, then three times a fix round and the fixer with the output again) and parks after the third round. Each fixer run has the 30-minute limit, so an unattended run on such a command can spend hours. The document step's agent is the fixer with a documentation prompt, not a reviewer, and an automatic round runs it again over the round's commits. The CI step fixes a failing check on its own with or without `autofix`. Only a plain `true` or `false` is read. An empty value, `~` or `null` leaves it off, and anything else (`yes`, `"true"`, `[true]`) fails the run at the rebase step. The default is off.

`review.exclude` keeps generated files, lockfiles and snapshots from filling the reviewer's diff, which is cut at 120,000 characters. Each pattern is a git pathspec with git's default matching, so `*` also matches `/`: `dist/*` covers `dist/a/b.js`. Excluded files are still rebased, tested, pushed and readable by the reviewer, and the reviewer's prompt names the patterns. The diff and the stat the agents see leave them out. The PR body leaves them out too, because it is written from that stat and a lockfile line adds nothing to a PR description. The list of the mod's own commits at its end still names every file. A branch that changes only excluded files still runs. The mod does not clear git's pathspec variables. A `GIT_LITERAL_PATHSPECS` set in your environment turns every pattern off, and a `GIT_NOGLOB_PATHSPECS` turns off each pattern that has a wildcard. Neither gives a message. The list follows the same strict rules as `commands:`: one `- <pattern>` line per item, all at one indent, each a plain or quoted value. A flow list, a scalar, a nested or unknown key, an empty item, or a pattern that starts with `:` or `-` fails the run at the rebase step. A pattern that starts with `*` must be quoted.

A `review:` section with any key other than `exclude:` fails the run, and so does a line at column 0 after `commands:` or `review:` that reads as a misplaced entry: a `- item`, a command name, or `exclude:`. Earlier versions ignored these lines, so remove them from a config that has them. Any other top-level key than `autofix:`, or a `---`, still ends the section and is ignored.

## Trust model

What the mod runs on your behalf is not held to your permission rules or sandbox:

- The configured commands run as `sh -c <command>` in the worktree, as you, with no sandbox and your full environment (`GH_TOKEN`, cloud credentials, SSH agent). They run code the branch can change: `npm test` runs the branch's tests and `package.json` scripts, and the fixer may have edited both. Configure only commands you would run by hand on this branch.
- The mod's own `git` and `gh` calls (fetch, rebase, commit, push, `gh pr list`, `gh pr create`, `gh pr checks`, `gh run view`) run outside your permission rules, with your credentials.
- A failing test or lint command goes to the fixer with the output; the mod commits the fixer's edits and re-runs the command, and a command that still fails parks the step. Under `autofix` that park starts a fix round, the command runs again, and a command that still fails goes to the fixer with the output again, for up to three rounds. The fixer's commits are not reviewed again by the reviewer.
- `autofix` removes only the human press for findings the agent already marked `auto-fix`; it does not widen what the fixer can read, write or run. After an automatic round the review step runs the reviewer again over the fixer's commits. The test and lint steps re-run their command, the document step runs its agent again, which is the fixer with a documentation prompt, and no reviewer reads those commits.

Known limitations: hooks are off for every git call, so a `pre-push` hook such as git-lfs's does not run, and LFS objects of the branch are not uploaded by the push. Run `git lfs push origin <branch>` yourself where the repository uses LFS. A tool output too large for the transcript may be saved by the engine outside the worktree, where the agents cannot read it.

## Development

Run the tests from the repository root:

```sh
claude plugin test .
```

- `hooks/`: the mod. `register.tsx` binds the commands and guards; `io.ts` holds the bindings the run reaches the host through; `engine.ts`, `steps.ts`, `git.ts`, `guard.ts`, `prompts.ts`, `pane.tsx` and `run.ts` hold the run.
- `types/`: `index.d.ts`, the types of a run, a step, a finding and the configured commands.
- `tests/`: `pipeline.test.ts`, the tests, run against a mocked world.
- `scripts/realgit/`: checks that drive `git.ts` and `guard.ts` against real git repositories. Run `bun scripts/realgit/realgit.ts`.

To gate a branch with its own mod, run `scripts/dogfood.sh start <branch> [intent]` on a pushed branch. It clones the branch from `origin` into `~/.cache/no-mistakes-dogfood/<name>`, where `<name>` is the branch with every character other than a letter, digit, `_` or `-` replaced by `-`, so `feat/x` and `feat-x` share a clone. It hosts Claude Code there in tmux with that clone loaded as the plugin, and runs `/no-mistakes`. The hosted session runs the branch's mod and spends your own Claude quota. It is told to stay passive, because it once reacted to the mod's notifications by editing files in the clone. `start` answers the folder-trust dialog for that clone without asking you, on purpose, so the branch's plugin and hooks run. `start` never deletes anything. If the session or the clone already exists, it stops, and you run `stop` and remove the clone by hand. The pipeline pushes its commits to the branch, so pull afterwards.

`send` clears the chat input, types text and presses Enter. `key` presses one key in the pane. If the key lands in the chat input instead, `key` clears the input, focuses the pane with ctrl+x then Tab, and presses the key again. `show` prints the screen, `status` runs `/no-mistakes-status`, and `stop` ends the session.

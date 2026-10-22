# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code mod (plugin) that gates a feature branch. `/no-mistakes [intent]` rebases, reviews, tests, documents, lints, rechecks, pushes, opens a PR, and watches CI. Subagents run every step inside a disposable detached worktree under `~/.cache/no-mistakes/`. Blocking findings park the run in a pane where a human fixes, approves, skips, or aborts. The mod is a port of kunchenguid/no-mistakes.

There is no package.json, no build step, and no linter. The host loads `hooks/register.tsx` directly (see `hooks/hooks.json`). The plugin loader writes an untracked `tsconfig.json`. The README is the behavioural spec. It describes every edge case in prose, and the mod's own `document` step expects docs to track behaviour, so a change in behaviour is not done until the README says the new thing.

## Commands

```sh
claude plugin test .                 # the unit suite: every tests/*.test.ts against the mocked world
bun scripts/realgit/realgit.ts       # git.ts and guard.ts against real git repositories (runs the other three realgit files too)
scripts/dogfood-check.sh             # dogfood.sh start, record and wait against stubbed tmux, claude and git clone
```

`claude plugin test` takes a directory, not a file, and has no filter flag. It runs every test file under the directory. To run the suite on another host build, call that binary from `~/.local/share/claude/versions/<v>`. The suite is kept green on 2.1.306 and 2.1.307, whose testing kits differ (see the README's Development section).

The repository has no CI workflow that runs. The three commands above are the gate, plus a live run of the mod on its own branch:

```sh
scripts/dogfood.sh start <branch> "<intent>"            # clone the pushed branch, host Claude Code in tmux with the branch's own mod loaded, run /no-mistakes
scripts/dogfood.sh wait <branch>                        # poll the run record and print "parked at <step>: <ids>" (exit 1) or "run <outcome>: <note>" (exit 0 when passed)
scripts/dogfood.sh send <branch> "/no-mistakes-approve" # decide a parked step from the chat (also show, status, record, key, stop)
```

The dogfood pipeline pushes its own commits onto the branch under test. Run `git merge --ff-only origin/<branch>` before touching that branch again, and never push to it while a run is before its push step.

## Architecture

**State is one `Run` object.** `types/index.d.ts` defines it. A plugin-state atom holds it, and every change rewrites it whole through `io().writeRun(change)`. Each change also rewrites `latest.json` in the run's record directory, and a finished run appends one line to `history.jsonl`. `steps` is a `Record<StepName, StepState>`. A `StepState` status of `starting`, or `fixing` without an `agentId`, is a claim: one actor owns that step's start effect, and nobody else may start or settle it. `decisions` records every human and pipeline verdict, and every later prompt carries them as facts that outrank the intent.

**The host is reached only through `hooks/io.ts`.** The engine handle `$` may be used only as `$.noun.event(...)` on a hook's own parameter. So `session.start` in `register.tsx` binds closures into `io()`, and everything else calls `io().run(...)`, `io().spawn(...)`, or `io().writeRun(...)`. An atom must be declared in the file that reads it, which is why `register.tsx` and `pane.tsx` each declare their own. The tests and the realgit script replace the whole `Io` with `bind(...)`.

**Module roles under `hooks/`.**

- `register.tsx` is the hook table. `session.start` binds io, registers the commands and the two agent types, and resumes a stored run. `tool.call` is the deny half of the guard and `tool.check` the allow half. The engine's own verdict comes first, and a user's deny or ask always stands. `agent.offer` hides the reviewer and fixer from the user's model. `turn.complete` routes agent answers to the engine.
- `engine.ts` is the run lifecycle: `startRun`, `press` (fix, approve, skip, or abort from the pane or the chat), `onAgentAnswer`, `resume`, `ownerOf` (whether an agent is one of ours), and the step loop that advances the run.
- `steps.ts` holds one `StepDef` per step in `STEPS` (rebase, review, test, document, lint, recheck, push, pr, ci), the `AGENT_SPECS` for the reviewer and the fixer, `spawn`, `pollCi`, and the messages of the mod's own commits.
- `run.ts` holds pure functions over `Run` and the constants (fix rounds, timeouts, step order). `parseFindings` reads an agent's answer, `slug` sanitises agent-chosen ids, and `priorApprovals` reads `history.jsonl`.
- `git.ts` makes every git and gh call. Nothing else in the mod runs git.
- `guard.ts` places paths (it resolves links and `..` against the worktree's real path) and exposes `judge` (deny), `isAllowed` (allow), and `writtenPath` (which untracked file an agent wrote, so the commit takes only those).
- `prompts.ts` holds the system prompts, the task prompts, and `untrusted()`, which wraps branch-, agent-, or CI-authored text in a tag with a fresh random name.
- `pane.tsx` draws the step board and handles its keys.

**Invariants to keep.** The code is built around these. Keep them when changing anything they touch.

- Every git call carries `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false` (`HOOKS_OFF` in `git.ts`). The rebase, push, and fetch carry the flags listed in the README under "Who runs what". The tests' `calls` array strips the `-c` pairs, and `raw` keeps them.
- `.no-mistakes.yaml` and `review.guide` are read from `origin/<default>` only, never from the branch under review. The config reader is strict on purpose: one line per value, no block or flow syntax, and an unknown key fails the run.
- Agents have no git and no general shell. The fixer's Bash runs only the configured commands, spelled exactly as `cd '<worktree>' && <command>`. Every file call must be absolute, under the worktree, and never at a `.git` entry in any letter case.
- Anything an agent, the branch, a command, or CI wrote goes into a prompt or the PR body through `untrusted()`. A finding id is the only agent-chosen text carried as a trusted fact, and `slug` constrains it.
- An agent whose step has moved on is retired. The mod ignores its answers and refuses its tool calls. The host cannot resume a run agent because its type is hidden, so an unreadable answer goes once to a fresh agent of the same type (`reasked`), and a second failure fails the run closed.
- A record write that fails is dropped without a word (`writeOrDrop`) and never changes a step.

## Tests

`tests/world.ts` is the mocked world. A rule list answers process calls by command line, `spawns` records agent spawns, `runs` records every stored run, and helpers such as `start`, `parkReview`, `pressOnce`, and `toolCall` drive the engine. Each `*.test.ts` covers one area (run, review, commands, recheck, push, pane, guards, config, record). Add a test to the file whose area it belongs to, and put a helper in `world.ts` only when more than one file needs it. `HOST_ALLOWS` lists the tools the host allows without an ask (`TaskStop`). The world must answer `allow` for them on 2.1.307.

## Conventions

- Commit subjects read `type(no-mistakes): what changed`, and a change a user can see gets a `CHANGELOG.md` line naming its PR. The version lives in `.claude-plugin/plugin.json`.
- Comments in `hooks/` say why a constraint exists (which attack, which host rule), not what the line does. Match that.
- `.no-mistakes.yaml` at the repo root configures the mod's own gate on this repository. Its test command is `claude plugin test .`.

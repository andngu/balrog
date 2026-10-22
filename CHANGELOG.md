# Changelog

Each entry names the pull request that made the change.

## 0.2.0, 2026-10-21

- The empty run directory is removed with the worktree (#9).
- `document: false` turns the document step off (#10).
- A `recheck` step between lint and push: the reviewer reads every commit the pipeline's own agents made since the review, and a fix round there runs test and lint again (#11).
- `review.guide` in `.no-mistakes.yaml`: a standards file on the default branch that the reviewer applies (#12).
- A run record on disk: `latest.json` and `history.jsonl` under the repository's cache directory, a `Record:` line in `/no-mistakes-status`, and `scripts/dogfood.sh wait` and `record` that read it (#13).
- The reviewer is told which findings the author approved as is in earlier runs of the branch (#15).
- The test suite passes on Claude Code 2.1.307, whose testing kit routes a mod's own tool calls through the permission check (#16).
- An answer without its findings block goes to a fresh agent of the same type instead of failing the run; the host refuses to resume an agent whose type the mod hides (#17).

## 0.1.0, 2026-10-21

- The port of kunchenguid/no-mistakes as a Claude Code mod landed as the first commit, with no pull request: rebase, review, test, document, lint, push, PR and CI in a disposable worktree, with a pane for the human calls. Rounds 5 and 6 of hardening followed (#1).
- The pane as a step board with the findings and the follow-up commands under it (#2).
- Install, quick start and development docs, and a marketplace manifest (#4).
- `/no-mistakes-fix`, `-approve`, `-skip` and `-abort` decide a parked step from the chat (#5).
- `review.exclude` keeps paths out of the diff the agents see (#6).
- `scripts/dogfood.sh` gates a branch with its own mod in a tmux-hosted session (#7).
- `autofix: true` sends a parked step's findings to the fixer without a press when every blocking finding is one the agent marked auto-fix (#8).

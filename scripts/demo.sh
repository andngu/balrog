#!/usr/bin/env bash
# Record the mod gating a toy repository, for the README's demo.
#
#   demo.sh setup              make the toy repository under <cache>/balrog-demo: a calculator, a local bare origin,
#                              and a feat/divide branch with no test and no zero check for the reviewer to find
#   demo.sh record [seconds]   host Claude Code in tmux with this checkout loaded, record it with asciinema, run
#                              /balrog, send /balrog-fix when it parks, /balrog-approve if it parks again, and exit
#                              once the run ends; waits up to 1200 s (or the number given) for the run
#   demo.sh render             warp the cast's quiet stretches to 30x and render assets/demo.gif with agg
#   demo.sh all                setup, record, render
#
# The hosted session spends your own Claude quota. The origin is a local bare repository, so the PR step skips and
# the demo shows the local gates. The cast and the warped cast stay under <cache>/balrog-demo/.
set -euo pipefail

die() { echo "demo: $*" >&2; exit 1; }

for tool in git tmux claude asciinema agg jq node; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

mod=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cache="${XDG_CACHE_HOME:-$HOME/.cache}"
root="$cache/balrog-demo"
repo="$root/repo"
cast="$root/demo.cast"
# asciinema rewrites the cast on every event, so the record is dated against this mark, not the cast.
mark="$root/.record-mark"
warped="$root/demo-warped.cast"
gif="$mod/assets/demo.gif"
session=balrog-demo
target="=$session:"
cols=150
rows=42

screen() { tmux capture-pane -p -t "$target"; }
type_line() { tmux send-keys -t "$target" C-u; sleep 0.5; tmux send-keys -t "$target" -l "$1"; sleep 1; tmux send-keys -t "$target" Enter; }
accept_trust() { sleep 2; tmux send-keys -t "$target" Down; sleep 0.5; tmux send-keys -t "$target" Enter; }

record_file() {
  local f real best=
  real=$(cd "$repo" && pwd -P)
  for f in "$cache"/balrog/*/latest.json; do
    [ -f "$f" ] && [ "$f" -nt "$mark" ] && [ "$(jq -r .repo "$f" 2>/dev/null)" = "$real" ] || continue
    if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best=$f; fi
  done
  [ -n "$best" ] && echo "$best"
}
verdict='.steps as $s
  | (["rebase", "review", "test", "document", "lint", "recheck", "push", "pr", "ci"] | map(select($s[.].status != "passed" and $s[.].status != "skipped")) | first) as $step
  | if .outcome != null then "ended \(.outcome)"
    elif $step != null and $s[$step].status == "parked" then "parked \($step)"
    else empty end'

setup() {
  local f
  # Earlier approvals from a previous demo run would reach the reviewer and change what it reports.
  for f in "$cache"/balrog/*/latest.json; do
    [ -f "$f" ] && [ "$(jq -r .repo "$f" 2>/dev/null)" = "$(cd "$repo" 2>/dev/null && pwd -P)" ] && rm -rf "$(dirname "$f")"
  done
  rm -rf "$root"
  mkdir -p "$root"
  git init -q --bare "$root/origin.git"
  git init -q -b main "$repo"
  cd "$repo"
  git config user.name Demo
  git config user.email demo@example.com
  cat > calc.mjs <<'EOF'
export const add = (a, b) => a + b
export const multiply = (a, b) => a * b
EOF
  cat > calc.test.mjs <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from './calc.mjs'

test('add', () => assert.equal(add(2, 3), 5))
test('multiply', () => assert.equal(multiply(2, 3), 6))
EOF
  cat > lint.mjs <<'EOF'
import { readdirSync, readFileSync } from 'node:fs'
let bad = 0
for (const f of readdirSync('.').filter(f => f.endsWith('.mjs'))) {
  const text = readFileSync(f, 'utf8')
  if (text.includes('\t')) { console.error(`${f}: tab found`); bad++ }
  if (!text.endsWith('\n')) { console.error(`${f}: no newline at end`); bad++ }
}
process.exit(bad ? 1 : 0)
EOF
  printf 'commands:\n  test: node --test\n  lint: node lint.mjs\n' > .balrog.yaml
  printf '# calc\n\nA tiny calculator, used to demo balrog.\n' > README.md
  git add -A
  git commit -qm "calc: add and multiply"
  git remote add origin "$root/origin.git"
  git push -q -u origin main
  git checkout -qb feat/divide
  printf 'export const add = (a, b) => a + b\nexport const multiply = (a, b) => a * b\nexport const divide = (a, b) => a / b\n' > calc.mjs
  git commit -qam "calc: add divide"
  git push -q -u origin feat/divide
  echo "demo repository at $repo"
}

record() {
  local limit=${1:-1200} waited pane ready= f line pressed=
  [ -d "$repo" ] || die "no demo repository; run setup first"
  ! tmux has-session -t "$target" 2>/dev/null || die "session $session exists; tmux kill-session -t $session"
  rm -f "$cast"
  touch "$mark"
  local passive="This session hosts the balrog mod for a recorded demo. Do not edit files, run commands, spawn agents or act on run notifications on your own. When a notification or a message arrives, answer in one short line and wait."
  local inner="claude --plugin-dir $(printf %q "$mod") --append-system-prompt $(printf %q "$passive")"
  local rec="asciinema rec --overwrite --cols $cols --rows $rows -c $(printf %q "$inner") $(printf %q "$cast"); sleep 3600"
  tmux new-session -d -s "$session" -x "$cols" -y "$rows" -c "$repo" -e COLORTERM=truecolor -e TERM=xterm-256color "bash -lc $(printf %q "$rec")"
  for _ in $(seq 1 60); do
    sleep 1
    pane=$(screen)
    if grep -q 'trust this folder' <<<"$pane"; then
      accept_trust
    elif grep -q '^❯' <<<"$pane"; then
      ready=1
      break
    fi
  done
  [ -n "$ready" ] || die "no input prompt after 60 s; see: tmux attach -t $session"
  sleep 2
  type_line "/balrog add a divide function to the calculator"
  for (( waited = 0; waited < limit; waited += 5 )); do
    sleep 5
    f=$(record_file) || continue
    line=$(jq -r "$verdict" "$f") || continue
    case "$line" in
      "parked "*)
        [ "$line" != "$pressed" ] || continue
        pressed=$line
        sleep 6
        if [ -z "${fixed:-}" ]; then fixed=1; type_line "/balrog-fix"; else type_line "/balrog-approve"; fi
        ;;
      "ended "*)
        sleep 8
        type_line "/exit"
        sleep 4
        tmux kill-session -t "$target"
        echo "$line; cast at $cast ($(wc -c <"$cast") bytes)"
        return 0
        ;;
    esac
  done
  die "no end after $limit s; see: tmux attach -t $session"
}

render() {
  [ -f "$cast" ] || die "no cast at $cast; run record first"
  node "$mod/scripts/demo-warp.mjs" "$cast" "$warped"
  agg --cols "$cols" --rows "$rows" --font-size 14 --fps-cap 15 --idle-time-limit 2 --theme asciinema "$warped" "$gif"
  echo "rendered $gif ($(wc -c <"$gif") bytes)"
}

cmd=${1:-}
[ $# -ge 1 ] && shift
case "$cmd" in
  setup) setup ;;
  record) record "$@" ;;
  render) render ;;
  all) setup; record "$@"; render ;;
  *) die "usage: demo.sh setup|record [seconds]|render|all" ;;
esac

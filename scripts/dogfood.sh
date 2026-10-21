#!/usr/bin/env bash
# Gate a branch with its own mod: host Claude Code in tmux with the branch cloned
# and loaded as a plugin, so /no-mistakes runs the code under review.
#
#   dogfood.sh start <branch> [intent]   clone the branch, start the session, run /no-mistakes
#   dogfood.sh send <branch> <text>      type text into the session and press Enter
#   dogfood.sh key <branch> <key>        press one tmux key name (Escape, Enter, a, ...)
#   dogfood.sh focus <branch>            give the pane the keyboard (ctrl+x, then Tab)
#   dogfood.sh show <branch> [lines]     print the last lines of the session's screen
#   dogfood.sh status <branch>           run /no-mistakes-status and print the screen
#   dogfood.sh stop <branch>             kill the session
set -euo pipefail

die() { echo "dogfood: $*" >&2; exit 1; }

for tool in tmux claude; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

[ $# -ge 2 ] || die "usage: dogfood.sh start|send|key|focus|show|status|stop <branch> [args]"
cmd=$1 branch=$2
shift 2

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && git remote get-url origin) || die "no origin remote"
dir="${XDG_CACHE_HOME:-$HOME/.cache}/no-mistakes-dogfood/$branch"
session="nm-${branch//[^A-Za-z0-9_-]/-}"

screen() { tmux capture-pane -p -t "$session" -S "-${1:-60}" | sed -e 's/[[:space:]]*$//' | grep -v '^$' || true; }
type_line() { tmux send-keys -t "$session" C-u; sleep 0.5; tmux send-keys -t "$session" -l "$1"; sleep 1; tmux send-keys -t "$session" Enter; }
alive() { tmux has-session -t "$session" 2>/dev/null || die "no session $session; run start first"; }

case "$cmd" in
  start)
    rm -rf "$dir"
    mkdir -p "$(dirname "$dir")"
    git clone -q --branch "$branch" "$repo" "$dir"
    tmux kill-session -t "$session" 2>/dev/null || true
    tmux new-session -d -s "$session" -x 200 -y 50 -c "$dir" \
      "bash -lc 'claude --plugin-dir \"$dir\"; echo EXIT \$?; sleep 3600'"
    ready=
    for _ in $(seq 1 60); do
      sleep 1
      pane=$(tmux capture-pane -p -t "$session")
      if grep -q 'trust this folder' <<<"$pane"; then
        # the prompt defaults to "No, exit"
        sleep 2
        tmux send-keys -t "$session" Down
        sleep 0.5
        tmux send-keys -t "$session" Enter
      elif grep -q '^❯' <<<"$pane"; then
        ready=1
        break
      fi
    done
    [ -n "$ready" ] || die "no input prompt after 60 s; see: tmux attach -t $session"
    [ $# -eq 0 ] || type_line "/no-mistakes $1"
    echo "session $session in $dir"
    ;;
  send) alive; [ $# -ge 1 ] || die "send needs text"; type_line "$*" ;;
  key) alive; [ $# -eq 1 ] || die "key needs one key name"; tmux send-keys -t "$session" "$1" ;;
  focus)
    alive
    # ctrl+x Tab toggles focus, so press only while the hint says the pane lacks it
    if screen | grep -qF 'Keys work after ctrl+x tab focuses the pane.'; then
      tmux send-keys -t "$session" C-x
      sleep 0.3
      tmux send-keys -t "$session" Tab
    fi
    ;;
  show) alive; screen "${1:-60}" ;;
  status) alive; type_line "/no-mistakes-status"; sleep 8; screen ;;
  stop) tmux kill-session -t "$session" ;;
  *) die "unknown command $cmd" ;;
esac

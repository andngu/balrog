#!/usr/bin/env bash
# Gate a branch with its own mod: host Claude Code in tmux with the branch cloned
# and loaded as a plugin, so /no-mistakes runs the code under review.
#
#   dogfood.sh start <branch> [intent]   clone the branch, start the session, run /no-mistakes if an intent is given
#   dogfood.sh send <branch> <text>      clear the chat input, type text, press Enter
#   dogfood.sh key <branch> <key>        press one tmux key name (Escape, Enter, a, ...) in the pane;
#                                        a character that lands in the chat input refocuses and retries
#   dogfood.sh show <branch> [lines]     print the last lines of the session's screen
#   dogfood.sh status <branch>           run /no-mistakes-status and print the screen
#   dogfood.sh stop <branch>             kill the session
#
# start never deletes an existing clone or session, only the temporary directory of a clone of
# its own that failed. It refuses when the session or the clone already exists.
# It answers the folder-trust dialog for the clone it makes, on purpose, so the
# branch's plugin and hooks run without a human decision on that dialog.
set -euo pipefail

die() { echo "dogfood: $*" >&2; exit 1; }

for tool in git tmux claude; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

[ $# -ge 2 ] || die "usage: dogfood.sh start|send|key|show|status|stop <branch> [args]"
cmd=$1 branch=$2
shift 2
# --branch expands @{-N} to another branch, so the name must also expand to itself.
[ -n "$branch" ] && [ "${branch#-}" = "$branch" ] && [ "$(git check-ref-format --branch "$branch" 2>/dev/null)" = "$branch" ] ||
  die "not a valid branch name: '$branch'"

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && git remote get-url origin) || die "no origin remote"
slug=${branch//[^A-Za-z0-9_-]/-}
dir="${XDG_CACHE_HOME:-$HOME/.cache}/no-mistakes-dogfood/$slug"
session="nm-$slug"
target="=$session:"

screen() { tmux capture-pane -p -t "$target" -S "-${1:-60}" | sed -e 's/[[:space:]]*$//' | grep -v '^$' || true; }
type_line() { tmux send-keys -t "$target" C-u; sleep 0.5; tmux send-keys -t "$target" -l "$1"; sleep 1; tmux send-keys -t "$target" Enter; }
alive() { tmux has-session -t "$target" 2>/dev/null || die "no session $session; run start first"; }
accept_trust() { sleep 2; tmux send-keys -t "$target" Down; sleep 0.5; tmux send-keys -t "$target" Enter; }
focus_pane() { tmux send-keys -t "$target" C-u; sleep 0.3; tmux send-keys -t "$target" C-x; sleep 0.3; tmux send-keys -t "$target" Tab; sleep 0.5; }
prompt() { tmux capture-pane -p -t "$target" | grep '^❯' | tail -n 1 || true; }
press() { local before after; before=$(prompt); tmux send-keys -t "$target" "$1"; sleep 1; after=$(prompt); [ "$after" = "$before" ] || [ "${after%"$1"}" = "$after" ]; }

case "$cmd" in
  start)
    ! tmux has-session -t "$target" 2>/dev/null || die "session $session exists; run stop first"
    [ ! -e "$dir" ] || die "$dir exists; remove it by hand"
    parent=$(dirname "$dir")
    mkdir -p "$parent"
    tmp=$(mktemp -d "$parent/.clone.XXXXXX")
    git clone -q --branch "$branch" -- "$repo" "$tmp/repo" || { rm -rf "$tmp"; die "clone of $branch failed"; }
    mv "$tmp/repo" "$dir"
    rmdir "$tmp"
    passive="This session hosts the no-mistakes mod for a dogfood run. Do not edit files, run commands, spawn agents or act on run notifications on your own. When a notification or a message arrives, answer in one line at most and wait."
    inner="claude --plugin-dir $(printf %q "$dir") --append-system-prompt $(printf %q "$passive"); echo EXIT \$?; sleep 3600"
    tmux new-session -d -s "$session" -x 200 -y 50 -c "$dir" "bash -lc $(printf %q "$inner")"
    ready=
    for _ in $(seq 1 60); do
      sleep 1
      pane=$(tmux capture-pane -p -t "$target")
      if grep -q 'trust this folder' <<<"$pane"; then
        accept_trust
      elif grep -q '^❯' <<<"$pane"; then
        ready=1
        break
      fi
    done
    [ -n "$ready" ] || die "no input prompt after 60 s; see: tmux attach -t $session"
    [ $# -eq 0 ] || type_line "/no-mistakes $*"
    echo "session $session in $dir"
    ;;
  send) alive; [ $# -ge 1 ] || die "send needs text"; type_line "$*" ;;
  key)
    alive
    [ $# -eq 1 ] || die "key needs one key name"
    press "$1" || [ ${#1} -ne 1 ] || { focus_pane; press "$1" || die "$1 went to the chat input twice; see: tmux attach -t $session"; }
    ;;
  show) alive; screen "${1:-60}" ;;
  status) alive; type_line "/no-mistakes-status"; sleep 8; screen ;;
  stop) tmux kill-session -t "$target" ;;
  *) die "unknown command $cmd" ;;
esac

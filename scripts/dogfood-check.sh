#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tmp=$(cd "$tmp" && pwd -P)

mkdir -p "$tmp/bin" "$tmp/jq"
for tool in bash dirname touch sed grep tail sleep mkdir mktemp mv rmdir seq; do ln -s "$(command -v "$tool")" "$tmp/bin/$tool"; done
ln -s "$(command -v jq)" "$tmp/jq/jq"
cat >"$tmp/bin/tmux" <<'EOF'
#!/bin/sh
case "$1" in
  has-session) [ -z "$NO_SESSION" ] ;;
  capture-pane) echo "❯ " ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/claude"
cat >"$tmp/bin/git" <<EOF
#!/bin/sh
[ "\$1" = clone ] || exec $(command -v git) "\$@"
for arg; do dest=\$arg; done
mkdir -p "\$dest/.git"
EOF
chmod +x "$tmp/bin/tmux" "$tmp/bin/claude" "$tmp/bin/git"

export XDG_CACHE_HOME=$tmp/cache
branch=dogfood-check
clone=$tmp/cache/no-mistakes-dogfood/$branch
records=$tmp/cache/no-mistakes
mkdir -p "$clone/.git" "$records/repo-aaaaaaaa" "$records/repo-bbbbbbbb"
echo "ref: refs/heads/$branch" >"$clone/.git/HEAD"

dogfood() { PATH=$tmp/bin:$tmp/jq "$here/dogfood.sh" "$@"; }
record() {
  local id=$1 review=$2 outcome=$3
  jq -cn --arg repo "$clone" --arg id "$id" --argjson review "$review" --argjson outcome "$outcome" \
    '{repo: $repo, id: $id, outcome: $outcome, note: (if $outcome == null then null else "note of " + $id end),
      steps: {rebase: {status: "passed"}, review: $review, test: {status: "pending"}, document: {status: "pending"},
              lint: {status: "pending"}, recheck: {status: "pending"}, push: {status: "pending"}, pr: {status: "pending"}, ci: {status: "pending"}}}'
}
parked='{"status": "parked", "findings": [{"id": "f1"}, {"id": "f2"}]}'
passed='{"status": "passed"}'
write() { local file=$1; shift; record "$@" >"$file"; }
old() { touch -d '2000-01-01' "$@"; }

fails=0
check() {
  local name=$1 want_status=$2 want_out=$3 status=0 out
  shift 3
  out=$("$@" 2>&1) || status=$?
  if [ "$status" = "$want_status" ] && [ "$out" = "$want_out" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: exit $status, output: $out" >&2
    echo "     wanted exit $want_status, output: $want_out" >&2
    stat -c '     %y %n' "$clone/.git/HEAD" "$clone/.git/dogfood-mark" "$records"/*/latest.json >&2 2>/dev/null || true
    fails=1
  fi
}

old "$clone/.git/HEAD"
check 'no record yet: record dies' 1 "dogfood: no record for $clone yet" dogfood record "$branch"
check 'no record yet: wait exits 2 at the limit' 2 'dogfood: no verdict after 0 s' dogfood wait "$branch" 0
check 'wait refuses a limit that is not a number' 1 'dogfood: wait takes a number of seconds' dogfood wait "$branch" soon

write "$records/repo-aaaaaaaa/latest.json" run1 "$parked" null
check 'a parked step prints its name and finding ids, exit 1' 1 'parked at review: f1, f2' dogfood wait "$branch" 0
check 'record prints the record' 0 "$(jq . "$records/repo-aaaaaaaa/latest.json")" dogfood record "$branch"
check 'record dies without jq' 1 'dogfood: jq is not on PATH' env PATH="$tmp/bin" "$here/dogfood.sh" record "$branch"
check 'wait dies without jq' 1 'dogfood: jq is not on PATH' env PATH="$tmp/bin" "$here/dogfood.sh" wait "$branch" 0

write "$records/repo-aaaaaaaa/latest.json" run1 "$passed" '"passed"'
check 'a passed run prints its note, exit 0' 0 'run passed: note of run1' dogfood wait "$branch" 0
write "$records/repo-aaaaaaaa/latest.json" run1 "$passed" '"failed"'
check 'a failed run prints its note, exit 1' 1 'run failed: note of run1' dogfood wait "$branch" 0
write "$records/repo-aaaaaaaa/latest.json" run1 "$passed" null
jq -c --argjson parked "$parked" '.steps |= (map_values({status: "passed"}) | .recheck = $parked | .push.status = "pending")' \
  "$records/repo-aaaaaaaa/latest.json" >"$tmp/l" && mv "$tmp/l" "$records/repo-aaaaaaaa/latest.json"
check 'a parked recheck is a verdict' 1 'parked at recheck: f1, f2' dogfood wait "$branch" 0
write "$records/repo-aaaaaaaa/latest.json" run1 '{"status": "running"}' null
check 'a run in progress is no verdict' 2 'dogfood: no verdict after 0 s' dogfood wait "$branch" 0

write "$records/repo-bbbbbbbb/latest.json" other "$passed" '"passed"'
jq -c '.repo = "/somewhere/else"' "$records/repo-bbbbbbbb/latest.json" >"$records/repo-bbbbbbbb/l" && mv "$records/repo-bbbbbbbb/l" "$records/repo-bbbbbbbb/latest.json"
check 'a record of another repository is not this clone'"'"'s' 2 'dogfood: no verdict after 0 s' dogfood wait "$branch" 0
rm "$records/repo-bbbbbbbb/latest.json"

write "$records/repo-aaaaaaaa/latest.json" run1 "$passed" '"passed"'
old "$records/repo-aaaaaaaa/latest.json"
touch "$clone/.git/HEAD"
check 'a record older than the clone belongs to an earlier clone' 2 'dogfood: no verdict after 0 s' dogfood wait "$branch" 0

old "$clone/.git/HEAD"
write "$records/repo-aaaaaaaa/latest.json" run1 "$passed" '"passed"'
sleep 0.01
dogfood send "$branch" '/no-mistakes again' >/dev/null
check 'a record older than the last send is an earlier run'"'"'s' 2 'dogfood: no verdict after 0 s' dogfood wait "$branch" 0
write "$records/repo-aaaaaaaa/latest.json" run2 "$parked" null
check 'a record written after the send is this run'"'"'s' 1 'parked at review: f1, f2' dogfood wait "$branch" 0
dogfood key "$branch" a >/dev/null
check 'a key press is an action too' 2 'dogfood: no verdict after 0 s' dogfood wait "$branch" 0

write "$records/repo-aaaaaaaa/latest.json" run2 "$passed" '"passed"'
sleep 0.05
write "$records/repo-bbbbbbbb/latest.json" run3 "$parked" null
check 'the newest matching record wins' 1 'parked at review: f1, f2' dogfood wait "$branch" 0
rm "$records/repo-bbbbbbbb/latest.json"

write "$records/repo-aaaaaaaa/latest.json" run4 '{"status": "running"}' null
(sleep 1 && write "$records/repo-aaaaaaaa/latest.json" run4 "$passed" '"passed"') &
check 'wait polls until the run ends' 0 'run passed: note of run4' dogfood wait "$branch" 10
wait

ln -s "$tmp/cache" "$tmp/link"
check 'the clone path is resolved before it is compared with the record' 0 'run passed: note of run4' env XDG_CACHE_HOME="$tmp/link" PATH="$tmp/bin:$tmp/jq" "$here/dogfood.sh" wait "$branch" 0

fresh=$tmp/cache/no-mistakes-dogfood/dogfood-start
check 'start opens the session in a new clone' 0 "session nm-dogfood-start in $fresh" env NO_SESSION=1 PATH="$tmp/bin:$tmp/jq" "$here/dogfood.sh" start dogfood-start
check 'start leaves the mark that wait reads records against' 0 '' test -e "$fresh/.git/dogfood-mark"

exit "$fails"

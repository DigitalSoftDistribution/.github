#!/usr/bin/env bash
# Offline test for the scheduled / manual scan rules of the "gitleaks (free binary fallback)" step of
# .github/workflows/security-shared.yml (T-11668):
#   - a scheduled run on day 8-31 scans every ref's commits of the last 8 days; day 1-7 and manual runs scan in full;
#   - a scheduled or manual scan that could not complete (killed, memory watchdog, error, no report) sets
#     GITLEAKS_INCOMPLETE with the reason, and the job's last step fails on it; findings stay report-only;
#   - pull request and push runs keep their old rule (an incomplete report-only scan is a warning, never a flag).
# The step's real script is cut out of the workflow and run against a fake gitleaks that records its arguments and
# either writes a SARIF, dies by SIGKILL, exits 2, or holds 300 MB (the watchdog case, Linux only: it reads /proc).
# Two lines of the script are patched, each asserted to occur once: the day of the month and the cgroup files.
#
# Usage: bash tests/gitleaks-scheduled-scan.test.sh      Needs: bash, jq, python3.     Wall time: about 3 s.
# GL_WF=<path> runs the same checks against another copy of the workflow.
# shellcheck disable=SC2016
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WF="${GL_WF:-$ROOT/.github/workflows/security-shared.yml}"
T=$(mktemp -d "${TMPDIR:-/tmp}/gl-sched-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
PASSES=0; FAILS=0; SKIPS=0
ok()  { PASSES=$((PASSES + 1)); echo "ok   - $1"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# the scan step and the job's last step, cut out of the workflow by indentation
cut_step() { # cut_step <exact step name, as an awk regex> <out>
  awk -v pat="$1" '
    $0 ~ "^      - name: " pat "$" { s = 1; next }
    s && /^        run: \|$/ { r = 1; next }
    r { if ($0 ~ /^          / || $0 ~ /^$/) { sub(/^          /, ""); print; next } else exit }
  ' "$WF" > "$2"
}
cut_step 'gitleaks \\(free binary fallback\\)' "$T/step.sh"
cut_step 'gitleaks scan incomplete \\(a scheduled or manual scan that did not finish fails the job\\)' "$T/last.sh"
check "scan step extracted" '[ -s "$T/step.sh" ] && grep -q "GITLEAKS_INCOMPLETE" "$T/step.sh"'
check "last step extracted" '[ -s "$T/last.sh" ] && grep -q "exit 1" "$T/last.sh"'

# shape: the last step comes after the scope step, runs unless cancelled when the flag is set, and sets no shell
L_SCOPE=$(grep -n '^      - name: scope (which advisory scanners this run needs)$' "$WF" | cut -d: -f1)
L_LAST=$(grep -n '^      - name: gitleaks scan incomplete (' "$WF" | cut -d: -f1)
check "the incomplete-scan step is the job's step after the scope step" '[ -n "$L_SCOPE" ] && [ -n "$L_LAST" ] && [ "$L_LAST" -gt "$L_SCOPE" ]'
check "its condition is !cancelled() and the flag" \
  '[ "$(sed -n "$((L_LAST + 1))p" "$WF")" = "        if: \${{ !cancelled() && env.GITLEAKS_INCOMPLETE != '"''"' }}" ]'
check "it sets no shell (the job default stays)" '! sed -n "$((L_LAST + 1)),$((L_LAST + 4))p" "$WF" | grep -q "^        shell:"'

# the two patched lines
DAY_LINE='day=$(date -u +%d)'
CG_LINE='for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do'
check "the day line occurs once" '[ "$(grep -cxF "$DAY_LINE" <(sed "s/^ *//" "$T/step.sh"))" = 1 ]'
check "the cgroup line occurs once" '[ "$(grep -cxF "$CG_LINE" <(sed "s/^ *//" "$T/step.sh"))" = 1 ]'

cat > "$T/fake-gitleaks" <<'FAKE'
#!/usr/bin/env bash
# stands in for gitleaks: records its arguments, then acts as GL_MODE says
printf '%s\n' "$@" > "$GL_ARGS"
rp=""; prev=""
for a in "$@"; do [ "$prev" = "--report-path" ] && rp=$a; prev=$a; done
sarif() { python3 -B -I -c 'import json,sys; n=int(sys.argv[2]); r=[{"ruleId":"generic-api-key","locations":[{"physicalLocation":{"artifactLocation":{"uri":"f%d.txt"%i},"region":{"startLine":1}}}],"partialFingerprints":{"commitSha":"ab"*20}} for i in range(n)]; json.dump({"version":"2.1.0","runs":[{"results":r}]},open(sys.argv[1],"w"))' "$rp" "$1"; }
case "$GL_MODE" in
  clean) sarif 0; exit 0 ;;
  found2) sarif 2; exit 0 ;;
  kill) kill -KILL $$ ;;
  error) exit 2 ;;
  hog) exec python3 -B -I -c 'import time; b=bytearray(300*1024*1024); [b.__setitem__(i, 1) for i in range(0, len(b), 4096)]; time.sleep(30)' ;;
esac
exit 3
FAKE
chmod 0755 "$T/fake-gitleaks"
printf '134217728\n' > "$T/memory.max"   # 128 MiB: the watchdog cap is 3/4 of it, 96 MB

# run_step <name> <event> <day> <mode>: the step with the binary, the day and the cgroup file patched
run_step() {
  local name=$1 event=$2 day=$3 mode=$4
  mkdir -p "$T/w-$name" "$T/rt-$name"
  sed -e "s#/tmp/gitleaks#$T/fake-gitleaks#g" \
      -e "s#day=\$(date -u +%d)#day=$day#" \
      -e "s#for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do#for f in $T/memory.max; do#" \
      "$T/step.sh" > "$T/step-$name.sh"
  : > "$T/sum-$name.md"; : > "$T/env-$name"
  ( cd "$T/w-$name" && env EVENT="$event" PR_BASE= PR_HEAD= PR_NUMBER= READ_TOKEN= PUSH_BEFORE= PUSH_AFTER= MG_BASE= MG_HEAD= \
      DEFAULT_BRANCH=main GITLEAKS_BLOCKING=false REPO=test/repo GITHUB_STEP_SUMMARY="$T/sum-$name.md" GITHUB_ENV="$T/env-$name" \
      RUNNER_TEMP="$T/rt-$name" GL_MODE="$mode" GL_ARGS="$T/args-$name" \
      bash --noprofile --norc -e -o pipefail "$T/step-$name.sh" > "$T/out-$name.log" 2>&1 )
  RC=$?
}
flag() { grep -q '^GITLEAKS_INCOMPLETE=' "$T/env-$1"; }

run_step weekly schedule 09 clean
check "schedule, day 9, clean: rc 0 (rc=$RC)" '[ $RC -eq 0 ]'
check "schedule, day 9: scans every ref of the last 8 days" 'grep -qxF -- "--log-opts=--all --since=8.days.ago" "$T/args-weekly"'
check "schedule, day 9, clean: no incomplete flag" '! flag weekly'

run_step monthly schedule 03 clean
check "schedule, day 3: the full history (no --log-opts)" '[ $RC -eq 0 ] && ! grep -q -- "--log-opts" "$T/args-monthly" && grep -q "scanning the full history (schedule)" "$T/out-monthly.log"'
run_step manual workflow_dispatch 20 clean
check "workflow_dispatch, day 20: the full history" '[ $RC -eq 0 ] && ! grep -q -- "--log-opts" "$T/args-manual"'

run_step killed schedule 16 kill
check "schedule, gitleaks killed: the step ends 0 so the later steps run (rc=$RC)" '[ $RC -eq 0 ]'
check "schedule, killed: an error annotation names it" 'grep -q "^::error title=gitleaks scan incomplete::gitleaks did not complete (killed, signal 9" "$T/out-killed.log"'
check "schedule, killed: GITLEAKS_INCOMPLETE is set with the reason" 'grep -q "^GITLEAKS_INCOMPLETE=killed, signal 9" "$T/env-killed"'
( env GITLEAKS_INCOMPLETE="$(sed -n "s/^GITLEAKS_INCOMPLETE=//p" "$T/env-killed")" bash --noprofile --norc -e -o pipefail "$T/last.sh" > "$T/out-last.log" 2>&1 ); LRC=$?
check "the last step fails the job on the flag (rc=$LRC)" '[ $LRC -eq 1 ] && grep -q "^gitleaks scan incomplete: killed, signal 9" "$T/out-last.log"'

run_step err workflow_dispatch 16 error
check "workflow_dispatch, gitleaks exit 2: flagged as exit 2" '[ $RC -eq 0 ] && grep -q "^GITLEAKS_INCOMPLETE=exit 2$" "$T/env-err"'

run_step found schedule 16 found2
check "schedule, 2 findings: report-only (rc 0, a warning, no flag)" \
  '[ $RC -eq 0 ] && grep -q "^::warning::gitleaks flagged 2 potential secret(s) (report-only)" "$T/out-found.log" && ! flag found'

run_step pr pull_request 16 kill
check "pull_request report-only, killed: a warning, no flag (unchanged)" \
  '[ $RC -eq 0 ] && grep -q "^::warning::gitleaks did not complete (killed, signal 9" "$T/out-pr.log" && ! flag pr'
run_step push push 16 kill
check "push, killed: a warning, no flag (unchanged)" '[ $RC -eq 0 ] && grep -q "^::warning::gitleaks did not complete" "$T/out-push.log" && ! flag push'

if [ -r /proc/self/status ]; then
  run_step hog schedule 16 hog
  check "schedule, gitleaks over 3/4 of the cgroup limit: the watchdog stops it and says so" \
    '[ $RC -eq 0 ] && grep -q "^gitleaks: passed 96 MB RSS ([0-9]* MB); stopped by the memory watchdog$" "$T/out-hog.log"'
  check "schedule, watchdog: flagged with the cap" 'grep -q "^GITLEAKS_INCOMPLETE=stopped by the memory watchdog at 96 MB$" "$T/env-hog"'
else
  SKIPS=$((SKIPS + 1)); echo "SKIP - watchdog case: no /proc on this host"
fi

echo "-- $PASSES passed, $FAILS failed, $SKIPS skipped"
[ "$FAILS" -eq 0 ]

#!/usr/bin/env bash
# Tests the `gitleaks (free binary fallback)` step of .github/workflows/security-shared.yml: the step's own `run:`
# script is extracted from the workflow and executed the way the runner does (bash --noprofile --norc -eo pipefail)
# in a throwaway fixture repository. Needs bash, git, jq, curl, python3 + PyYAML, and Linux (/proc).
#
#   bash tests/gitleaks-step.test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }

python3 - "$here/.github/workflows/security-shared.yml" > "$work/step.sh" <<'PY' || { echo "FATAL: cannot extract the step"; exit 2; }
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
steps = [s for s in wf["jobs"]["gitleaks"]["steps"] if s.get("name") == "gitleaks (free binary fallback)"]
assert len(steps) == 1, "step not found"
print(steps[0]["run"])
PY

# fixture: one clean commit, one commit with a GitHub-token-shaped string (assembled at runtime, not a credential)
repo="$work/repo"
git init -q -b main "$repo" && cd "$repo" || exit 2
g() { git -c user.email=step-test@example.invalid -c user.name=step-test -c commit.gpgsign=false "$@"; }
echo hi > a.txt && g add a.txt && g commit -qm clean
printf 'GITHUB_TOKEN=ghp_%s\n' "Zq8Lr2Vx9Kt4Wm7Np3Bs6Hd1Fj5Gc0Ya8Ue2Xi" > t.env && g add t.env && g commit -qm token

run_step() { # run_step <cap> -> sets out, rc; summary in $work/summary
  : > "$work/summary"
  out=$(EVENT=workflow_dispatch GITHUB_STEP_SUMMARY="$work/summary" GL_MAX_RSS_MB="$1" \
        timeout 180 bash --noprofile --norc -eo pipefail "$work/step.sh" 2>&1)
  rc=$?
}

run_step 4096
[ "$rc" -eq 0 ] && ok "a normal scan exits 0 (advisory)" || bad "normal scan rc=$rc: $out"
case "$out" in *"gitleaks: 0 potential"*) bad "normal scan missed the token" ;; *"potential finding(s)"*) ok "normal scan reports the finding" ;; *) bad "no finding line: $out" ;; esac
case "$out" in *INCOMPLETE*) bad "normal scan reported INCOMPLETE" ;; *) ok "normal scan is not marked incomplete" ;; esac

run_step 1
[ "$rc" -eq 0 ] && ok "a capped scan still exits 0 (advisory; the step survives bash -e)" || bad "capped scan rc=$rc: $out"
case "$out" in *"secret scan INCOMPLETE"*"cap gitleaks_max_rss_mb=1"*) ok "a capped scan is reported INCOMPLETE with the cap" ;; *) bad "capped scan not reported: $out" ;; esac
grep -q "scan incomplete" "$work/summary" && ok "the job summary says incomplete" || bad "summary: $(cat "$work/summary")"

run_step abc
[ "$rc" -ne 0 ] && ok "a non-numeric cap fails the step" || bad "a non-numeric cap passed"

rm -f /tmp/gitleaks gitleaks.sarif
if [ "$fail" -ne 0 ]; then echo "gitleaks step tests: FAILED"; exit 1; fi
echo "gitleaks step tests: all passed"

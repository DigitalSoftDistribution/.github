#!/usr/bin/env bash
# Offline test for the finding-locations log of the "gitleaks (free binary fallback)" step of
# .github/workflows/security-shared.yml: each finding prints its rule, file, line and commit, and NEVER the secret.
#
# The step's real script is cut out of the workflow and run twice:
#   A. against a fake gitleaks that writes a prepared SARIF carrying a PLANTED fake secret in every field a real
#      report can carry it (snippet, message, commit message): hermetic, always runs;
#   B. against the real gitleaks binary on PATH, scanning a temp git repo whose second commit adds a freshly generated
#      fake token: skipped (and said so) when no gitleaks is installed.
# In both, the log and the step summary must hold the location and must not hold the value, whole or in part.
#
# Usage: bash tests/gitleaks-findings-log.test.sh        Needs: bash, jq, python3, git; B also needs gitleaks.
# shellcheck disable=SC2016,SC2034
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WF="${GL_WF:-$ROOT/.github/workflows/security-shared.yml}"
T=$(mktemp -d "${TMPDIR:-/tmp}/gl-find-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
PASSES=0; FAILS=0; SKIPS=0
ok()  { PASSES=$((PASSES + 1)); echo "ok   - $1"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# the step's script, cut out of the workflow by indentation
awk '
  /^      - name: gitleaks \(free binary fallback\)$/ { s = 1; next }
  s && /^        run: \|$/ { r = 1; next }
  r { if ($0 ~ /^          / || $0 ~ /^$/) { sub(/^          /, ""); print; next } else exit }
' "$WF" > "$T/step.sh"
check "step script extracted from the workflow" '[ -s "$T/step.sh" ] && grep -q "gitleaks finding: rule=" "$T/step.sh"'

# a fake secret that is not any real token: random, generated per run
SECRET="ghp_$(python3 -B -I -c 'import secrets, string; print("".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36)))')"
RAND=${SECRET#ghp_}

# run_step <name> <gitleaks binary> <env assignments...>: runs the step script with the binary at "/tmp/gitleaks" redirected
run_step() {
  local name=$1 bin=$2; shift 2
  mkdir -p "$T/w-$name" "$T/rt-$name"
  sed -e "s#/tmp/gitleaks#$bin#g" "$T/step.sh" > "$T/step-$name.sh"
  : > "$T/sum-$name.md"
  ( cd "$T/w-$name" && env EVENT=workflow_dispatch PR_BASE= PR_HEAD= PR_NUMBER= PUSH_BEFORE= PUSH_AFTER= MG_BASE= MG_HEAD= \
      DEFAULT_BRANCH=main GITLEAKS_BLOCKING=false REPO=test/repo GITHUB_STEP_SUMMARY="$T/sum-$name.md" RUNNER_TEMP="$T/rt-$name" "$@" \
      bash --noprofile --norc -e -o pipefail "$T/step-$name.sh" > "$T/out-$name.log" 2>&1 )
  RC=$?
}
frag_in_log() { # any 8-char window of the random part, in the log or the summary
  local i
  for i in $(seq 0 $((${#RAND} - 8))); do
    grep -q -F "${RAND:$i:8}" "$T/out-$1.log" "$T/sum-$1.md" && return 0
  done
  return 1
}

# A. fixture: 60 results (50-line cap) and one crafted path, the secret planted in snippet, message and commit message
python3 -B -I - "$T/fixture.sarif" "$SECRET" <<'PY'
import json, sys
out, secret = sys.argv[1], sys.argv[2]
def res(rule, uri, line, commit):
    return {"ruleId": rule, "message": {"text": rule + " has detected secret for file " + uri + ": " + secret},
            "locations": [{"physicalLocation": {"artifactLocation": {"uri": uri}, "region": {"startLine": line,
                           "snippet": {"text": "token = " + secret}}}}],
            "partialFingerprints": {"commitSha": commit, "commitMessage": "add " + secret, "author": "A", "email": "a@b"}}
results = [res("github-pat", "src/app.js", 12, "0123456789abcdef0123456789abcdef01234567")]
results.append(res("generic-api-key", "evil\n::error::boom", 3, "fedcba98765432100123456789abcdef01234567"))
results += [res("generic-api-key", "pad/f%d.txt" % i, i + 1, "a" * 40) for i in range(58)]
json.dump({"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "gitleaks"}}, "results": results}]}, open(out, "w"))
PY
cat > "$T/fake-gitleaks" <<'FAKE'
#!/usr/bin/env bash
# stands in for gitleaks: writes the prepared SARIF to --report-path and exits 0 like `--exit-code 0`
while [ $# -gt 0 ]; do [ "$1" = "--report-path" ] && cp "$GL_FIXTURE" "$2"; shift; done
exit 0
FAKE
chmod 0755 "$T/fake-gitleaks"
run_step fixture "$T/fake-gitleaks" GL_FIXTURE="$T/fixture.sarif"
check "A: the step completes (rc=$RC) and reports 60 findings" '[ $RC -eq 0 ] && grep -q "gitleaks: 60 potential finding(s)" "$T/out-fixture.log"'
check "A: rule, file, line and 12-char commit of a finding are in the log" \
  'grep -qx "gitleaks finding: rule=github-pat file=src/app.js line=12 commit=0123456789ab" "$T/out-fixture.log"'
check "A: at most 50 finding lines are printed" '[ "$(grep -c "^gitleaks finding: " "$T/out-fixture.log")" = 50 ]'
check "A: the planted secret is in the SARIF (so the test can fail) but nowhere in the log or the summary, whole or in part" \
  'grep -q -F "$SECRET" "$T/w-fixture/gitleaks.sarif" && ! grep -q -F "$SECRET" "$T/out-fixture.log" "$T/sum-fixture.md" && ! frag_in_log fixture'
check "A: a crafted file name cannot start a workflow command (no log line begins with ::error::boom)" \
  '! grep -q "^::error::boom" "$T/out-fixture.log" && grep -q "^gitleaks finding: rule=generic-api-key file=evil?::error::boom line=3 " "$T/out-fixture.log"'
check "A: nothing but the four fields is printed on a finding line" \
  '! grep "^gitleaks finding: " "$T/out-fixture.log" | grep -qvE "^gitleaks finding: rule=[^ ]+ file=[^ ]+ line=[0-9?]+ commit=[0-9a-f?]{0,12}$"'

# B. the real gitleaks on a real temp repo with a freshly generated fake token
if command -v gitleaks >/dev/null 2>&1; then
  R="$T/repo"; mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "base"
  BASE=$(git -C "$R" rev-parse HEAD)
  printf 'GITHUB_TOKEN=%s\n' "$SECRET" > "$R/leak.txt"
  git -C "$R" add leak.txt && git -C "$R" -c user.name=t -c user.email=t@t commit -q -m "add a file"
  HEADC=$(git -C "$R" rev-parse HEAD)
  sed -e "s#/tmp/gitleaks#$(command -v gitleaks)#g" "$T/step.sh" > "$T/step-real.sh"; : > "$T/sum-real.md"; mkdir -p "$T/rt-real"
  ( cd "$R" && env EVENT=push PR_BASE= PR_HEAD= PR_NUMBER= PUSH_BEFORE="$BASE" PUSH_AFTER="$HEADC" MG_BASE= MG_HEAD= \
      DEFAULT_BRANCH=main GITLEAKS_BLOCKING=false REPO=test/repo GITHUB_STEP_SUMMARY="$T/sum-real.md" RUNNER_TEMP="$T/rt-real" \
      bash --noprofile --norc -e -o pipefail "$T/step-real.sh" > "$T/out-real.log" 2>&1 ); RC=$?
  check "B: real gitleaks $(gitleaks version 2>/dev/null | head -n 1): the step completes (rc=$RC) and flags the planted token" \
    '[ $RC -eq 0 ] && grep -q "gitleaks: 1 potential finding(s)" "$T/out-real.log"'
  check "B: the log holds file leak.txt, line 1 and the 12-char commit, as a finding line" \
    'grep -qE "^gitleaks finding: rule=[a-z0-9-]+ file=leak.txt line=1 commit=${HEADC:0:12}$" "$T/out-real.log"'
  check "B: neither the log nor the step summary holds the token, whole or in part" \
    '! grep -q -F "$SECRET" "$T/out-real.log" "$T/sum-real.md" && ! frag_in_log real'
else
  SKIPS=$((SKIPS + 1)); echo "SKIP - B: no gitleaks on PATH; the real-binary case did not run (case A did)"
fi

echo "-- $PASSES passed, $FAILS failed, $SKIPS skipped"
[ "$FAILS" -eq 0 ]

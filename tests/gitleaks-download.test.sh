#!/usr/bin/env bash
# Offline test for the "gitleaks (install pinned binary)" step of .github/workflows/security-shared.yml.
#
# The step's real script runs against a local HTTP server that plays github.com and api.github.com. A curl
# shim in front of the real curl rewrites only those two hosts and shortens --retry-delay to 1 s (curl reads
# 0 as its own 1-2-4-8-16 s backoff). A timeout shim in front of the real timeout passes everything through.
# Install paths (/tmp, /opt/gitleaks) are redirected into a mktemp dir, so the test never touches the host.
# No network, no real token.
#
# The server can answer 504, or HANG: accept the connection and never answer. Hang cases run either in real
# time (the step's real caps) or time-compressed: with GL_SCALE=5 both shims divide curl's --max-time and
# --connect-timeout and timeout's durations by 5, so a pure-hang run finishes in seconds. The static checks tie the
# step's caps, its step timeout and the job timeout together arithmetically.
#
# Usage: bash tests/gitleaks-download.test.sh        Needs: bash, curl, jq, python3, tar, sha256sum, timeout, awk
# Wall time: about 90 s, almost all of it the real-time hang case (about 46 s) and the compressed hang cases.
# GL_WF=<path> runs the same checks against another copy of the workflow (used to prove the hang cases fail on the old step).
# The conditions below are single-quoted on purpose (check() evals them) and read variables set around them.
# shellcheck disable=SC2016,SC2034
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WF="${GL_WF:-$ROOT/.github/workflows/security-shared.yml}"
T=$(mktemp -d "${TMPDIR:-/tmp}/gl-dl-test.XXXXXX")
SRV_PID=""
trap '[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$T"' EXIT
REAL_CURL=$(command -v curl)
REAL_TIMEOUT=$(command -v timeout)
FAKE_TOKEN="test-token-not-a-secret"
PASSES=0; FAILS=0
ok()  { PASSES=$((PASSES + 1)); echo "ok   - $1"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# 1. the step's script and header, cut out of the workflow by indentation
awk '
  /^      - name: gitleaks \(install pinned binary\)$/ { s = 1; next }
  s && /^        run: \|$/ { r = 1; next }
  r { if ($0 ~ /^          / || $0 ~ /^$/) { sub(/^          /, ""); print; next } else exit }
' "$WF" > "$T/step.sh"
awk '
  /^      - name: gitleaks \(install pinned binary\)$/ { s = 1 }
  s { print }
  s && /^        run: \|$/ { exit }
' "$WF" > "$T/step-head.txt"
awk '/^  gitleaks:$/ { j = 1; next } j && /^  [a-z][a-z-]*:$/ { exit } j { print }' "$WF" > "$T/job.txt"
check "step script extracted from the workflow" '[ -s "$T/step.sh" ] && grep -q "^VERSION=8.21.2$" "$T/step.sh"'
check "pinned tarball sha256 and pinned binary sha256 are full 64-hex digests" \
  'grep -qE "^SHA256=[0-9a-f]{64}$" "$T/step.sh" && grep -qE "^BIN_SHA256=[0-9a-f]{64}$" "$T/step.sh"'
check "no unretried curl-to-tar pipe is left in the workflow" '! grep -nE "curl .*\| *tar" "$WF"'

# 1b. the time budget, as arithmetic: caps, kill grace, step timeout, job timeout
CAPS=$(grep -oE 'timeout -k [0-9]+ [0-9]+' "$T/step.sh" | awk '{ c += $4; k += $3; n++ } END { print c, k, n }')
CAP_SUM=${CAPS%% *}; rest=${CAPS#* }; GRACE_SUM=${rest%% *}; NCAPS=${rest##* }
WORST=$((CAP_SUM + GRACE_SUM))
STEP_MIN=$(sed -nE 's/^ *timeout-minutes: ([0-9]+)$/\1/p' "$T/step-head.txt" | head -n 1)
JOB_MIN=$(grep -oE '&& 30 [|][|] [0-9]+' "$T/job.txt" | awk '{ print $4 }' | head -n 1)
check "three capped phases (release, API lookup, API asset): caps sum $CAP_SUM s + kill grace $GRACE_SUM s = worst case $WORST s, under 3 min" \
  '[ "$NCAPS" = 3 ] && [ "$WORST" -lt 180 ]'
uncapped() { grep -F '${GET[@]}' "$T/step.sh" | grep -vc 'timeout -k'; }
check "every curl call in the step runs under a timeout cap" '[ "$(uncapped)" = 0 ] && ! grep -nE "^ *(curl|[|] *curl)" "$T/step.sh"'
check "step timeout-minutes ($STEP_MIN) is above the worst case, as a backstop" '[ "$NCAPS" = 3 ] && [ -n "$STEP_MIN" ] && [ $((STEP_MIN * 60)) -gt "$WORST" ]'
check "job timeout for pull request / push ($JOB_MIN min) covers 5 min of checkout + scan plus the worst-case install" \
  '[ "$NCAPS" = 3 ] && [ -n "$JOB_MIN" ] && [ $((JOB_MIN * 60)) -ge $((300 + WORST)) ]'
perm_lines() { awk '/^    permissions:$/ { p = 1; next } p && /^      [a-z-]+: / { print; next } p { exit }' "$T/job.txt"; }
check "the gitleaks job asks for contents: read and nothing else" '[ "$(perm_lines)" = "      contents: read" ]'

# 2. fixtures: a good tarball (fake gitleaks that prints its version), a tampered one, and the binaries' own digests
mkdir -p "$T/fix-good" "$T/fix-bad" "$T/bin" "$T/pathbin"
printf '#!/bin/sh\necho 8.21.2\n' > "$T/fix-good/gitleaks"
printf '#!/bin/sh\necho tampered\n' > "$T/fix-bad/gitleaks"
chmod 0755 "$T/fix-good/gitleaks" "$T/fix-bad/gitleaks"
tar -czf "$T/good.tgz" -C "$T/fix-good" gitleaks
tar -czf "$T/bad.tgz" -C "$T/fix-bad" gitleaks
GOODSHA=$(sha256sum "$T/good.tgz" | cut -d' ' -f1)
GOODBIN=$(sha256sum "$T/fix-good/gitleaks" | cut -d' ' -f1)

# 3. the shims. GL_SCALE (default 1) compresses time: curl's --max-time / --connect-timeout and timeout's durations.
cat > "$T/bin/curl" <<'SHIM'
#!/usr/bin/env bash
sc() { awk -v v="$1" -v s="${GL_SCALE:-1}" 'BEGIN { printf "%g", v / s }'; }
args=()
for a in "$@"; do
  a=${a//https:\/\/github.com\//http:\/\/127.0.0.1:$GL_PORT\/gh\/}
  a=${a//https:\/\/api.github.com\//http:\/\/127.0.0.1:$GL_PORT\/api\/}
  args+=("$a")
done
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    --retry-delay) args[$((i + 1))]=1 ;;
    --max-time|--connect-timeout) args[$((i + 1))]=$(sc "${args[$((i + 1))]}") ;;
  esac
done
printf '%s\n' "${args[*]}" >> "$GL_ARGV_LOG"
exec "$REAL_CURL" "${args[@]}"
SHIM
cat > "$T/bin/timeout" <<'SHIM'
#!/usr/bin/env bash
sc() { awk -v v="$1" -v s="${GL_SCALE:-1}" 'BEGIN { printf "%g", v / s }'; }
out=(); args=("$@"); n=${#args[@]}; i=0
while [ "$i" -lt "$n" ]; do
  a=${args[$i]}
  case "$a" in
    -k) out+=(-k "$(sc "${args[$((i + 1))]}")"); i=$((i + 2)); continue ;;
    -*) out+=("$a") ;;
    *) out+=("$(sc "$a")"); i=$((i + 1)); while [ "$i" -lt "$n" ]; do out+=("${args[$i]}"); i=$((i + 1)); done; break ;;
  esac
  i=$((i + 1))
done
printf '%s\n' "${out[*]:0:3}" >> "$GL_TIMEOUT_LOG"
exec "$REAL_TIMEOUT" "${out[@]}"
SHIM
chmod 0755 "$T/bin/curl" "$T/bin/timeout"

# 4. the fake server. REL_MODE: N >= 0 = the first N release hits answer 504, then 200 with REL_BODY; -1 = always 504;
#    -2 = every release hit HANGS (accepted, never answered). API_MODE: ok | fail (504) | hang.
cat > "$T/srv.py" <<'PY'
import http.server, json, os, sys, time
rel_mode, rel_body, api_mode, log_path, port_path = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
hits = {"rel": 0}
def log(line):
    with open(log_path, "a") as f:
        f.write(line + "\n")
def hang():
    time.sleep(3600)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = self.path
        authed = self.headers.get("Authorization", "").startswith("Bearer ")
        if p.startswith("/gh/gitleaks/gitleaks/releases/download/"):
            hits["rel"] += 1; log("REL")
            if rel_mode == -2: return hang()
            if rel_mode < 0 or hits["rel"] <= rel_mode:
                return self.send(504, b"<html><body><h1>504 Gateway Time-out</h1></body></html>", "text/html")
            return self.send(200, open(rel_body, "rb").read(), "application/gzip")
        if p.startswith("/api/repos/gitleaks/gitleaks/releases/tags/"):
            log("API_TAGS auth=" + ("yes" if authed else "no"))
            if api_mode == "hang": return hang()
            if api_mode == "fail": return self.send(504, b"{}", "application/json")
            if not authed: return self.send(401, b"{}", "application/json")
            body = {"assets": [{"name": "other.zip", "id": 7}, {"name": "gitleaks_8.21.2_linux_x64.tar.gz", "id": 42}]}
            return self.send(200, json.dumps(body).encode(), "application/json")
        if p == "/api/repos/gitleaks/gitleaks/releases/assets/42":
            log("API_ASSET auth=" + ("yes" if authed else "no") + " accept=" + self.headers.get("Accept", ""))
            if api_mode == "hang": return hang()
            if api_mode == "fail" or not authed: return self.send(504 if api_mode == "fail" else 401, b"{}", "application/json")
            return self.send(200, open(rel_body, "rb").read(), "application/octet-stream")
        self.send(404, b"{}", "application/json")
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
srv.daemon_threads = True
open(port_path, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY

# 5. one run of the step: run_case <n> <release mode> <body good|bad> <api ok|fail|hang> <token|none> [pre] [scale]
#    pre = baked-good | baked-other (a binary under /opt/gitleaks/8.21.2) | path-good | path-other (a binary on PATH)
#    scale = GL_SCALE for the shims (default 1 = real time). Sets RC and WALL (whole seconds).
cnt() { grep -c "^$2" "$T/req-$1.log" || true; }
run_case() {
  local n=$1 rmode=$2 body=$3 api=$4 tok=$5 pre=${6:-} scale=${7:-1}
  local inst="$T/inst-$n" rt="$T/rt-$n" opt="$T/opt-$n" pb="$T/pathbin"
  mkdir -p "$inst" "$rt" "$opt"; rm -f "$pb/gitleaks"
  : > "$T/req-$n.log"; : > "$T/argv-$n.log"; : > "$T/to-$n.log"
  case "$pre" in
    baked-good) mkdir -p "$opt/8.21.2"; cp "$T/fix-good/gitleaks" "$opt/8.21.2/gitleaks" ;;
    baked-other) mkdir -p "$opt/8.21.2"; cp "$T/fix-bad/gitleaks" "$opt/8.21.2/gitleaks" ;;
    path-good) cp "$T/fix-good/gitleaks" "$pb/gitleaks" ;;
    path-other) cp "$T/fix-bad/gitleaks" "$pb/gitleaks" ;;
  esac
  python3 -B -I "$T/srv.py" "$rmode" "$T/$body.tgz" "$api" "$T/req-$n.log" "$T/port-$n" </dev/null >/dev/null 2>&1 &
  SRV_PID=$!
  for _ in $(seq 1 50); do [ -s "$T/port-$n" ] && break; sleep 0.1; done
  sed -e "s#/tmp/gitleaks#$inst/gitleaks#g" -e "s#-C /tmp #-C $inst #" -e "s#/opt/gitleaks#$opt#g" \
      -e "s#^SHA256=.*#SHA256=$GOODSHA#" -e "s#^BIN_SHA256=.*#BIN_SHA256=$GOODBIN#" "$T/step.sh" > "$T/step-$n.sh"
  if grep -qE '/tmp/gitleaks|-C /tmp |/opt/gitleaks' "$T/step-$n.sh"; then echo "test bug: install path not redirected"; exit 2; fi
  local t0 t1; t0=$(date +%s)
  env PATH="$T/bin:$pb:$PATH" GL_PORT="$(cat "$T/port-$n")" GL_ARGV_LOG="$T/argv-$n.log" GL_TIMEOUT_LOG="$T/to-$n.log" \
      GL_SCALE="$scale" REAL_CURL="$REAL_CURL" REAL_TIMEOUT="$REAL_TIMEOUT" \
      RUNNER_TEMP="$rt" GH_TOKEN="$([ "$tok" = token ] && echo "$FAKE_TOKEN")" \
      bash --noprofile --norc -e -o pipefail "$T/step-$n.sh" > "$T/out-$n.log" 2>&1
  RC=$?; t1=$(date +%s); WALL=$((t1 - t0))
  kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
}
installed() { [ -x "$T/inst-$1/gitleaks" ] && [ "$("$T/inst-$1/gitleaks" version)" = "8.21.2" ]; }
CLEAR="::error::gitleaks download failed after retries; no scan ran"

# 6. 504 cases (answers come back, nothing hangs)
run_case 1 2 good ok token
check "504 twice then 200: retried, installed, sha256 verified (rc=$RC, release hits=$(cnt 1 REL))" \
  '[ $RC -eq 0 ] && [ "$(cnt 1 REL)" = 3 ] && [ "$(cnt 1 API_TAGS)" = 0 ] && installed 1 && grep -q "installed from the release page, sha256 verified" "$T/out-1.log"'

run_case 2 -1 good ok token
check "504 on every release attempt: 4 tries (1 + 3 retries), then the REST API serves it (rc=$RC, wall ${WALL}s)" \
  '[ $RC -eq 0 ] && [ "$(cnt 2 REL)" = 4 ] && [ "$(cnt 2 API_TAGS)" = 1 ] && [ "$(cnt 2 API_ASSET)" = 1 ] && installed 2 && grep -q "trying the REST API" "$T/out-2.log" && grep -q "installed from the REST API, sha256 verified" "$T/out-2.log"'
check "API requests carried the token as a header, and asked for the octet-stream" \
  'grep -q "^API_TAGS auth=yes" "$T/req-2.log" && grep -q "^API_ASSET auth=yes accept=application/octet-stream" "$T/req-2.log"'
check "token never appears on curl's command line; the per-try flags reached curl" \
  '! grep -q "$FAKE_TOKEN" "$T/argv-2.log" && grep -q -- "--retry 3 --retry-all-errors --retry-delay 1 --connect-timeout 10 --max-time 20" "$T/argv-2.log"'
check "the three phases ran under the three caps: release 45 s, API lookup 25 s, API asset 45 s" \
  '[ "$(tr "\n" "|" < "$T/to-2.log")" = "-k 2 45|-k 2 25|-k 2 45|" ]'

run_case 3 -1 good fail token
check "504 everywhere: clear failure line, non-zero exit, nothing installed (rc=$RC)" \
  '[ $RC -ne 0 ] && [ "$(tail -n 1 "$T/out-3.log")" = "$CLEAR" ] && ! [ -e "$T/inst-3/gitleaks" ]'

run_case 4 -1 good ok none
check "504 and no token for the API: same clear failure line, no API request (rc=$RC)" \
  '[ $RC -ne 0 ] && [ "$(tail -n 1 "$T/out-4.log")" = "$CLEAR" ] && [ "$(cnt 4 API_TAGS)" = 0 ] && ! [ -e "$T/inst-4/gitleaks" ]'

run_case 5 0 bad ok token
check "checksum mismatch on the release asset: refused, tarball deleted, nothing installed (rc=$RC)" \
  '[ $RC -ne 0 ] && grep -q "sha256 mismatch" "$T/out-5.log" && grep -q "refusing to extract" "$T/out-5.log" && ! [ -e "$T/inst-5/gitleaks" ] && ! [ -e "$T/rt-5/gitleaks_8.21.2_linux_x64.tar.gz" ]'

run_case 6 -1 bad ok token
check "checksum mismatch on the API asset: refused as well (rc=$RC)" \
  '[ $RC -ne 0 ] && grep -q "sha256 mismatch" "$T/out-6.log" && ! [ -e "$T/inst-6/gitleaks" ]'

# 7. a gitleaks already on the runner is used only when its OWN sha256 matches the pinned binary hash
run_case 7 -1 good fail token baked-good
check "baked copy whose sha256 matches the pin: used, zero network requests (rc=$RC)" \
  '[ $RC -eq 0 ] && [ ! -s "$T/req-7.log" ] && installed 7 && grep -q "using .*/8.21.2/gitleaks (sha256 matches the pin), no download" "$T/out-7.log"'

run_case 8 0 good ok token baked-other
check "baked copy with another sha256 is ignored: downloaded and verified instead (rc=$RC)" \
  '[ $RC -eq 0 ] && [ "$(cnt 8 REL)" = 1 ] && installed 8 && ! grep -q "no download" "$T/out-8.log"'

run_case 9 -1 good fail token path-good
check "gitleaks on PATH whose sha256 matches the pin: used, zero network requests (rc=$RC)" \
  '[ $RC -eq 0 ] && [ ! -s "$T/req-9.log" ] && installed 9 && grep -q "using $T/pathbin/gitleaks (sha256 matches the pin), no download" "$T/out-9.log"'

run_case 10 0 good ok token path-other
check "gitleaks on PATH with another sha256 is ignored: downloaded and verified instead (rc=$RC)" \
  '[ $RC -eq 0 ] && [ "$(cnt 10 REL)" = 1 ] && installed 10 && ! grep -q "no download" "$T/out-10.log"'

# 8. hangs: the connection is accepted and never answered
run_case 11 -2 good ok token "" 5
check "time-compressed x5, release HANGS, API answers: the fallback runs and installs, wall ${WALL}s <= 20 s (rc=$RC)" \
  '[ $RC -eq 0 ] && [ "$WALL" -le 20 ] && [ "$(cnt 11 REL)" -ge 1 ] && installed 11 && grep -q "installed from the REST API, sha256 verified" "$T/out-11.log"'

run_case 12 -2 good hang token "" 5
check "time-compressed x5, release AND API hang: clear failure line, wall ${WALL}s <= 29 s (the 121 s cap sum / 5 + slack), nothing installed (rc=$RC)" \
  '[ $RC -ne 0 ] && [ "$WALL" -le 29 ] && [ "$(tail -n 1 "$T/out-12.log")" = "$CLEAR" ] && ! [ -e "$T/inst-12/gitleaks" ]'

run_case 13 -2 good ok token
check "REAL TIME, release HANGS, API answers: the fallback runs, installs from the REST API, wall ${WALL}s <= 60 s, far inside the job timeout (rc=$RC)" \
  '[ $RC -eq 0 ] && [ "$WALL" -le 60 ] && [ "$WALL" -ge 40 ] && installed 13 && grep -q "installed from the REST API, sha256 verified" "$T/out-13.log"'

echo "-- $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]

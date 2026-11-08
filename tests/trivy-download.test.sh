#!/usr/bin/env bash
# Offline test for the trivy install of the `trivy` job in .github/workflows/security-shared.yml.
#
# The install block of the step's real script (from `TRIVY="$(command -v trivy ...` to the end of its `if`) runs against a
# local HTTP server that plays github.com. A curl shim in front of the real curl rewrites only that host and shortens
# --retry-delay to 1 s (curl reads 0 as its own 1-2-4-8-16 s backoff); a timeout shim passes everything through; a uname
# shim answers `uname -m`. RUNNER_TEMP is a mktemp dir, PATH is restricted so no host trivy answers `command -v trivy`.
# No network, no credential.
#
# The server can answer 504 or HANG (accept the connection, never answer). Hang cases run in real time (the step's real
# caps) and time-compressed: with GL_SCALE=5 the shims divide curl's --max-time / --connect-timeout and timeout's durations
# by 5. The static checks tie the step's cap, the scan's own --timeout and the job timeout together arithmetically.
#
# Usage: bash tests/trivy-download.test.sh     Needs: bash, curl, python3, tar, sha256sum, timeout, awk
# Wall time: about 115 s, almost all of it the real-time hang case (about 92 s) and the compressed one (about 19 s).
# GL_WF=<path> runs the same checks against another copy of the workflow; GL_SKIP_REAL=1 skips the real-time hang case
# (both used to prove the hang cases fail on the old step, whose real-time hang would take 745 s).
# The conditions below are single-quoted on purpose (check() evals them) and read variables set around them.
# shellcheck disable=SC2016,SC2034
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WF="${GL_WF:-$ROOT/.github/workflows/security-shared.yml}"
T=$(mktemp -d "${TMPDIR:-/tmp}/trivy-dl-test.XXXXXX")
SRV_PID=""
trap '[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$T"' EXIT
REAL_CURL=$(command -v curl)
REAL_TIMEOUT=$(command -v timeout)
REAL_UNAME=$(command -v uname)
PASSES=0; FAILS=0
ok()  { PASSES=$((PASSES + 1)); echo "ok   - $1"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# 1. the step's script (dedented) and the trivy job, cut out of the workflow by indentation
awk '
  index($0, "      - name: trivy fs (vuln, secret, misconfig") == 1 { s = 1; next }
  s && /^        run: \|$/ { r = 1; next }
  r { if ($0 ~ /^          / || $0 ~ /^$/) { sub(/^          /, ""); print; next } else exit }
' "$WF" > "$T/step.sh"
awk '/^  trivy:$/ { j = 1; next } j && /^  [a-z][a-z-]*:$/ { exit } j { print }' "$WF" > "$T/job.txt"
# the install block: from the runner-trivy lookup to the line before the first `if [ "$STATUS" = ok ]` after it
awk '/^TRIVY="\$\(command -v trivy/ { f = 1 } f && /^if \[ "\$STATUS" = ok \]; then$/ { exit } f' "$T/step.sh" > "$T/block.sh"
check "step script and install block extracted from the workflow" \
  '[ -s "$T/step.sh" ] && [ -s "$T/block.sh" ] && grep -q "TRIVY_VERSION" "$T/job.txt"'
check "pinned sha256 digests for x64 and arm64 are full 64-hex and differ" \
  'x=$(sed -nE "s/^ *TRIVY_SHA256_X64: \"([0-9a-f]{64})\"$/\1/p" "$T/job.txt"); a=$(sed -nE "s/^ *TRIVY_SHA256_ARM64: \"([0-9a-f]{64})\"$/\1/p" "$T/job.txt"); [ -n "$x" ] && [ -n "$a" ] && [ "$x" != "$a" ]'

# 1b. the time budget, as arithmetic: cap, kill grace, the scan's own timeout, job timeout
CAPS=$(grep -v '^ *#' "$T/block.sh" | grep -oE 'timeout -k [0-9]+ [0-9]+' | awk '{ c += $4; k += $3; n++ } END { print c + 0, k + 0, n + 0 }')
CAP_SUM=${CAPS%% *}; rest=${CAPS#* }; GRACE_SUM=${rest%% *}; NCAPS=${rest##* }
WORST=$((CAP_SUM + GRACE_SUM))
SCAN_MIN=$(grep -v '^ *#' "$T/step.sh" | grep -oE -- '--timeout [0-9]+m' | head -n 1 | grep -oE '[0-9]+')
SCAN_S=$(( ${SCAN_MIN:-0} * 60 ))
JOB_MIN=$(sed -nE 's/^ *timeout-minutes: ([0-9]+)$/\1/p' "$T/job.txt" | head -n 1)
check "one capped download phase: cap $CAP_SUM s + kill grace $GRACE_SUM s = worst case $WORST s, under 2 min" \
  '[ "$NCAPS" = 1 ] && [ "$WORST" -lt 120 ]'
uncapped() { grep -v '^ *#' "$T/job.txt" | grep -E '(^|[^a-z-])curl ' | grep -vc 'timeout -k'; }
check "every curl call in the trivy job runs under a timeout cap" '[ "$(uncapped)" = 0 ] && grep -v "^ *#" "$T/block.sh" | grep -q "timeout -k [0-9]* [0-9]* curl "'
check "no uncapped retry loop left (the old --retry 5 / --max-time 120 form)" '! grep -v "^ *#" "$T/job.txt" | grep -qE -- "--retry 5|--max-time 120"'
check "job timeout ($JOB_MIN min) covers the install worst case ($WORST s) + the scan's --timeout ($SCAN_S s) + 120 s for checkout and reporting" \
  '[ "$NCAPS" = 1 ] && [ "$SCAN_S" -gt 0 ] && [ -n "$JOB_MIN" ] && [ $((JOB_MIN * 60)) -ge $((WORST + SCAN_S + 120)) ]'

# 2. fixtures: fake trivy tarballs per architecture, a tampered x64 one, and the digests the step is told to pin
mkdir -p "$T/fx-x64" "$T/fx-arm" "$T/fx-bad" "$T/bin" "$T/pathbin"
for d in x64 arm bad; do
  case $d in x64) w=trivy-x64 ;; arm) w=trivy-arm64 ;; bad) w=tampered ;; esac
  printf '#!/bin/sh\necho %s\n' "$w" > "$T/fx-$d/trivy"; chmod 0755 "$T/fx-$d/trivy"
  tar -czf "$T/$d.tgz" -C "$T/fx-$d" trivy
done
SHA_X64=$(sha256sum "$T/x64.tgz" | cut -d' ' -f1)
SHA_ARM=$(sha256sum "$T/arm.tgz" | cut -d' ' -f1)

# 3. the shims. GL_SCALE (default 1) compresses time: curl's --max-time / --connect-timeout and timeout's durations.
cat > "$T/bin/curl" <<'SHIM'
#!/usr/bin/env bash
sc() { awk -v v="$1" -v s="${GL_SCALE:-1}" 'BEGIN { printf "%g", v / s }'; }
args=()
for a in "$@"; do args+=("${a//https:\/\/github.com\//http:\/\/127.0.0.1:$GL_PORT\/gh\/}"); done
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
exec "$REAL_TIMEOUT" "${out[@]}"
SHIM
cat > "$T/bin/uname" <<'SHIM'
#!/bin/sh
if [ "${1:-}" = "-m" ]; then echo "${FAKE_UNAME:-x86_64}"; else exec "$REAL_UNAME" "$@"; fi
SHIM
chmod 0755 "$T/bin/curl" "$T/bin/timeout" "$T/bin/uname"

# 4. the fake server. FAIL_FIRST: N >= 0 = the first N hits answer 504, then 200 with the asset of the requested architecture;
#    -1 = always 504; -2 = every hit HANGS (accepted, never answered).
cat > "$T/srv.py" <<'PY'
import http.server, sys, time
fail_first, body_x64, body_arm, log_path, port_path = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
hits = [0]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        hits[0] += 1
        with open(log_path, "a") as f:
            f.write("REL " + self.path + "\n")
        if fail_first == -2:
            time.sleep(3600)
        if fail_first < 0 or hits[0] <= fail_first:
            code, ctype, body = 504, "text/html", b"<html><body><h1>504 Gateway Time-out</h1></body></html>"
        else:
            code, ctype = 200, "application/gzip"
            body = open(body_arm if "Linux-ARM64" in self.path else body_x64, "rb").read()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(port_path, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PY

# run_case <n> <fail_first> <x64 body: x64|bad> [uname -m] [stub: put a trivy on PATH first]
# sets RC, ELAPSED (s); the block's own verdict is read back with res <n> status|trivy|err
run_case() {
  local n=$1 ff=$2 xb=$3 un=${4:-x86_64} stub=${5:-}
  local rt="$T/rt-$n" pb="$T/pb-$n" t0
  mkdir -p "$rt" "$pb"; : > "$T/hits-$n.log"; : > "$T/argv-$n.log"
  if [ -n "$stub" ]; then printf '#!/bin/sh\necho trivy-stub\n' > "$pb/trivy"; chmod 0755 "$pb/trivy"; fi
  python3 -B -I "$T/srv.py" "$ff" "$T/$xb.tgz" "$T/arm.tgz" "$T/hits-$n.log" "$T/port-$n" </dev/null >/dev/null 2>&1 &
  SRV_PID=$!
  for _ in $(seq 1 50); do [ -s "$T/port-$n" ] && break; sleep 0.1; done
  { echo 'set -uo pipefail'; echo 'STATUS=ok; ERR=""'; cat "$T/block.sh"
    echo 'echo "RESULT status=$STATUS"'; echo 'echo "RESULT trivy=${TRIVY:-}"'; echo 'echo "RESULT err=$ERR"'; } > "$T/case-$n.sh"
  t0=$(date +%s.%N)
  env PATH="$T/bin:$pb:/usr/bin:/bin" GL_PORT="$(cat "$T/port-$n")" GL_ARGV_LOG="$T/argv-$n.log" GL_SCALE="${GL_SCALE:-1}" \
      REAL_CURL="$REAL_CURL" REAL_TIMEOUT="$REAL_TIMEOUT" REAL_UNAME="$REAL_UNAME" FAKE_UNAME="$un" RUNNER_TEMP="$rt" \
      TRIVY_VERSION=0.76.1 TRIVY_SHA256_X64="$SHA_X64" TRIVY_SHA256_ARM64="$SHA_ARM" \
      bash --noprofile --norc "$T/case-$n.sh" > "$T/out-$n.log" 2>&1
  RC=$?
  ELAPSED=$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }')
  kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
}
hits() { wc -l < "$T/hits-$1.log" | tr -d ' '; }
res() { sed -n "s/^RESULT $2=//p" "$T/out-$1.log"; }
within() { awk -v e="$ELAPSED" -v m="$1" 'BEGIN { exit !(e <= m) }'; }
empty_dir() { [ -z "$(ls -A "$1")" ]; }
if env PATH="/usr/bin:/bin" bash -c 'command -v trivy' >/dev/null 2>&1; then echo "test bug: a trivy sits in /usr/bin or /bin"; exit 2; fi

run_case 1 0 x64
check "healthy x64: one request, the Linux-64bit asset, installed and runnable, status ok (requests=$(hits 1))" \
  '[ "$(hits 1)" = 1 ] && grep -q "trivy_0.76.1_Linux-64bit.tar.gz" "$T/hits-1.log" && [ "$(res 1 status)" = ok ] && [ "$(res 1 trivy)" = "$T/rt-1/trivy" ] && [ "$("$T/rt-1/trivy")" = trivy-x64 ]'
check "the shim passed the bounded flags through to curl (retry 2, connect 10 s, max-time 30 s per try)" \
  'grep -q -- "--retry 2 --retry-all-errors --retry-delay 1 --connect-timeout 10 --max-time 30" "$T/argv-1.log"'

run_case 2 2 x64
check "504 twice then 200: retried, installed, status ok (requests=$(hits 2))" \
  '[ "$(hits 2)" = 3 ] && [ "$(res 2 status)" = ok ] && [ "$("$T/rt-2/trivy")" = trivy-x64 ]'

run_case 3 -1 x64
check "504 on every attempt: 3 requests, status error with a download reason, no tarball left, nothing extracted (requests=$(hits 3))" \
  '[ "$(hits 3)" = 3 ] && [ "$(res 3 status)" = error ] && res 3 err | grep -q "download failed" && empty_dir "$T/rt-3"'

run_case 4 0 x64 aarch64
check "aarch64 picks the Linux-ARM64 asset and its own digest, installed (requests=$(hits 4))" \
  '[ "$(hits 4)" = 1 ] && grep -q "trivy_0.76.1_Linux-ARM64.tar.gz" "$T/hits-4.log" && [ "$(res 4 status)" = ok ] && [ "$("$T/rt-4/trivy")" = trivy-arm64 ]'

run_case 5 0 x64 riscv64
check "an architecture with no pinned build: zero requests, status error with the reason, nothing written" \
  '[ "$(hits 5)" = 0 ] && [ "$(res 5 status)" = error ] && res 5 err | grep -q "no pinned build for this architecture" && empty_dir "$T/rt-5"'

run_case 6 0 bad
check "tampered tarball: sha256 mismatch, status error, tarball removed, nothing extracted" \
  '[ "$(hits 6)" = 1 ] && [ "$(res 6 status)" = error ] && res 6 err | grep -q "sha256 mismatch, not extracted" && empty_dir "$T/rt-6"'

run_case 7 -1 x64 x86_64 stub
check "a trivy already on PATH: block skipped, zero requests, that binary is used" \
  '[ "$(hits 7)" = 0 ] && [ "$(res 7 status)" = ok ] && [ "$(res 7 trivy)" = "$T/pb-7/trivy" ]'

# hang, time-compressed (GL_SCALE=5): every shimmed duration is divided by 5, so the cap must end the call near WORST / 5
GL_SCALE=5 run_case 8 -2 x64
LIM8=$(awk -v w="$WORST" 'BEGIN { printf "%.1f", w / 5 + 4 }')
check "release endpoint HANGS (time /5): the install ends in ${ELAPSED}s, within $LIM8 s, status error with a download reason, nothing left" \
  'within "$LIM8" && [ "$(hits 8)" -ge 1 ] && [ "$(res 8 status)" = error ] && res 8 err | grep -q "download failed" && empty_dir "$T/rt-8"'

# hang, real time: the step's real caps
if [ "${GL_SKIP_REAL:-0}" = 1 ]; then
  echo "SKIP - real-time hang case (GL_SKIP_REAL=1)"
else
  run_case 9 -2 x64
  LIM9=$((WORST + 3))
  check "release endpoint HANGS (real time): the install ends in ${ELAPSED}s, within $LIM9 s ($WORST s worst case + 3 s), one-line advisory error, nothing left" \
    'within "$LIM9" && [ "$(res 9 status)" = error ] && res 9 err | grep -q "download failed" && [ "$(res 9 err | wc -l)" = 1 ] && empty_dir "$T/rt-9"'
fi

echo "-- $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]

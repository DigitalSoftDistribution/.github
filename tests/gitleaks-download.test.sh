#!/usr/bin/env bash
# Offline test for the "gitleaks (install pinned binary)" step of .github/workflows/security-shared.yml.
#
# The step's real script runs against a local HTTP server that plays github.com and api.github.com. A curl
# shim in front of the real curl rewrites only those two hosts and shortens --retry-delay to 1 s (curl reads
# 0 as its own 1-2-4-8-16 s backoff). Every other flag, including --retry 5 --retry-all-errors, reaches the
# real curl untouched. Install paths
# (/tmp, /opt/gitleaks) are redirected into a mktemp dir, so the test never touches the host. No network,
# no real token.
#
# Usage: bash tests/gitleaks-download.test.sh        Needs: bash, curl, jq, python3, tar, sha256sum
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WF="$ROOT/.github/workflows/security-shared.yml"
T=$(mktemp -d "${TMPDIR:-/tmp}/gl-dl-test.XXXXXX")
SRV_PID=""
trap '[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$T"' EXIT
REAL_CURL=$(command -v curl)
FAKE_TOKEN="test-token-not-a-secret"
PASSES=0; FAILS=0
ok()  { PASSES=$((PASSES + 1)); echo "ok   - $1"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# 1. the step's script, cut out of the workflow by indentation
awk '
  /^      - name: gitleaks \(install pinned binary\)$/ { s = 1; next }
  s && /^        run: \|$/ { r = 1; next }
  r { if ($0 ~ /^          / || $0 ~ /^$/) { sub(/^          /, ""); print; next } else exit }
' "$WF" > "$T/step.sh"
check "step script extracted from the workflow" '[ -s "$T/step.sh" ] && grep -q "^VERSION=8.21.2$" "$T/step.sh"'
check "pinned sha256 line is a full 64-hex digest" 'grep -qE "^SHA256=[0-9a-f]{64}$" "$T/step.sh"'
check "no unretried curl-to-tar pipe is left in the workflow" '! grep -nE "curl .*\| *tar" "$WF"'

# 2. fixtures: a good tarball (fake gitleaks that prints its version) and a tampered one
mkdir -p "$T/fix-good" "$T/fix-bad" "$T/bin"
printf '#!/bin/sh\necho 8.21.2\n' > "$T/fix-good/gitleaks"
printf '#!/bin/sh\necho tampered\n' > "$T/fix-bad/gitleaks"
chmod 0755 "$T/fix-good/gitleaks" "$T/fix-bad/gitleaks"
tar -czf "$T/good.tgz" -C "$T/fix-good" gitleaks
tar -czf "$T/bad.tgz" -C "$T/fix-bad" gitleaks
GOODSHA=$(sha256sum "$T/good.tgz" | cut -d' ' -f1)

# 3. the curl shim
cat > "$T/bin/curl" <<'SHIM'
#!/usr/bin/env bash
args=()
for a in "$@"; do
  a=${a//https:\/\/github.com\//http:\/\/127.0.0.1:$GL_PORT\/gh\/}
  a=${a//https:\/\/api.github.com\//http:\/\/127.0.0.1:$GL_PORT\/api\/}
  args+=("$a")
done
for i in "${!args[@]}"; do [ "${args[$i]}" = "--retry-delay" ] && args[$((i + 1))]=1; done
printf '%s\n' "${args[*]}" >> "$GL_ARGV_LOG"
exec "$REAL_CURL" "${args[@]}"
SHIM
chmod 0755 "$T/bin/curl"

# 4. the fake server: REL_FAIL_FIRST release hits answer 504 (-1 = always), then 200 with REL_BODY
cat > "$T/srv.py" <<'PY'
import http.server, json, os, sys
fail_first, rel_body, api_mode, log_path, port_path = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
hits = {"rel": 0}
def log(line):
    with open(log_path, "a") as f:
        f.write(line + "\n")
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
            if fail_first < 0 or hits["rel"] <= fail_first:
                return self.send(504, b"<html><body><h1>504 Gateway Time-out</h1></body></html>", "text/html")
            return self.send(200, open(rel_body, "rb").read(), "application/gzip")
        if p.startswith("/api/repos/gitleaks/gitleaks/releases/tags/"):
            log("API_TAGS auth=" + ("yes" if authed else "no"))
            if api_mode == "fail": return self.send(504, b"{}", "application/json")
            if not authed: return self.send(401, b"{}", "application/json")
            body = {"assets": [{"name": "other.zip", "id": 7}, {"name": "gitleaks_8.21.2_linux_x64.tar.gz", "id": 42}]}
            return self.send(200, json.dumps(body).encode(), "application/json")
        if p == "/api/repos/gitleaks/gitleaks/releases/assets/42":
            log("API_ASSET auth=" + ("yes" if authed else "no") + " accept=" + self.headers.get("Accept", ""))
            if api_mode == "fail" or not authed: return self.send(504 if api_mode == "fail" else 401, b"{}", "application/json")
            return self.send(200, open(rel_body, "rb").read(), "application/octet-stream")
        self.send(404, b"{}", "application/json")
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_path, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY

# 5. one run of the step: run_case <n> <release 504s first (-1 = always)> <body good|bad> <api ok|fail> <token|none> [baked version]
cnt() { grep -c "^$2" "$T/req-$1.log" || true; }
run_case() {
  local n=$1 ff=$2 body=$3 api=$4 tok=$5 baked=${6:-}
  local inst="$T/inst-$n" rt="$T/rt-$n" opt="$T/opt-$n"
  mkdir -p "$inst" "$rt" "$opt"
  : > "$T/req-$n.log"; : > "$T/argv-$n.log"
  if [ -n "$baked" ]; then
    mkdir -p "$opt/8.21.2"
    printf '#!/bin/sh\necho %s\n' "$baked" > "$opt/8.21.2/gitleaks"; chmod 0755 "$opt/8.21.2/gitleaks"
  fi
  python3 -B -I "$T/srv.py" "$ff" "$T/$body.tgz" "$api" "$T/req-$n.log" "$T/port-$n" </dev/null >/dev/null 2>&1 &
  SRV_PID=$!
  for _ in $(seq 1 50); do [ -s "$T/port-$n" ] && break; sleep 0.1; done
  sed -e "s#/tmp/gitleaks#$inst/gitleaks#g" -e "s#-C /tmp #-C $inst #" -e "s#/opt/gitleaks#$opt#g" \
      -e "s#^SHA256=.*#SHA256=$GOODSHA#" "$T/step.sh" > "$T/step-$n.sh"
  if grep -qE '/tmp/gitleaks|-C /tmp |/opt/gitleaks' "$T/step-$n.sh"; then echo "test bug: install path not redirected"; exit 2; fi
  env PATH="$T/bin:$PATH" GL_PORT="$(cat "$T/port-$n")" GL_ARGV_LOG="$T/argv-$n.log" REAL_CURL="$REAL_CURL" \
      RUNNER_TEMP="$rt" GH_TOKEN="$([ "$tok" = token ] && echo "$FAKE_TOKEN")" \
      bash --noprofile --norc -e -o pipefail "$T/step-$n.sh" > "$T/out-$n.log" 2>&1
  RC=$?
  kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
}
installed() { [ -x "$T/inst-$1/gitleaks" ] && [ "$("$T/inst-$1/gitleaks" version)" = "8.21.2" ]; }
# shellcheck disable=SC2034  # read inside the eval-ed conditions of check()
CLEAR="::error::gitleaks download failed after retries; no scan ran"

run_case 1 2 good ok token
check "504 twice then 200: retried, installed, sha256 verified (rc=$RC, release hits=$(cnt 1 REL))" \
  '[ $RC -eq 0 ] && [ "$(cnt 1 REL)" = 3 ] && [ "$(cnt 1 API_TAGS)" = 0 ] && installed 1 && grep -q "installed from the release page, sha256 verified" "$T/out-1.log"'

run_case 2 -1 good ok token
check "504 on every release attempt: 6 tries (1 + 5 retries), then the REST API serves it (rc=$RC)" \
  '[ $RC -eq 0 ] && [ "$(cnt 2 REL)" = 6 ] && [ "$(cnt 2 API_TAGS)" = 1 ] && [ "$(cnt 2 API_ASSET)" = 1 ] && installed 2 && grep -q "trying the REST API" "$T/out-2.log" && grep -q "installed from the REST API, sha256 verified" "$T/out-2.log"'
check "API requests carried the token as a header, and asked for the octet-stream" \
  'grep -q "^API_TAGS auth=yes" "$T/req-2.log" && grep -q "^API_ASSET auth=yes accept=application/octet-stream" "$T/req-2.log"'
check "token never appears on curl's command line; every retry flag was passed" \
  '! grep -q "$FAKE_TOKEN" "$T/argv-2.log" && grep -q -- "--retry 5 --retry-all-errors --retry-delay 1 --connect-timeout 20 --max-time 120" "$T/argv-2.log"'

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

run_case 7 -1 good fail token 8.21.2
check "baked copy at the pinned version: used, zero network requests (rc=$RC)" \
  '[ $RC -eq 0 ] && [ ! -s "$T/req-7.log" ] && installed 7 && grep -q "baked into the runner image" "$T/out-7.log"'

run_case 8 0 good ok token 8.30.1
check "baked copy at another version is ignored: downloaded and verified instead (rc=$RC)" \
  '[ $RC -eq 0 ] && [ "$(cnt 8 REL)" = 1 ] && installed 8 && ! grep -q "baked into" "$T/out-8.log"'

echo "-- $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]

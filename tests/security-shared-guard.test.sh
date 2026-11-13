#!/usr/bin/env bash
# Offline test for the isolation of the gitleaks, npm-audit, trivy, codeql and zap-baseline jobs of .github/workflows/security-shared.yml
# (T-11229; T-11386 added codeql, zap-baseline, npm-audit's pinned node + tool guard and the licensed gitleaks path):
# each job's first step isolates HOME, the XDG dirs and the tool caches under RUNNER_TEMP, the job env fixes PATH, and a guard step
# fails the job when the runner's cache can still reach it. Part 1 checks the shape of the five jobs and T-11386's node/pnpm and licensed
# gitleaks rules, and proves the same checks flag the workflow as it was before (tests/fixtures/security-shared.before-t11229.yml) and
# twelve mutations of the new one. Part 2 runs the isolate step, the guard step, npm-audit's tool guard and node step, and the licensed
# gitleaks guard, taken out of the YAML, under a cleared environment: green on a clean job, red on each way the cache can still reach it.
# Fixture directories stand in for the runner's cache and the image PATH, and a fake curl, tar and uname for the node download; no root,
# no /gha-cache, no network, no credential.
#
# Usage: bash tests/security-shared-guard.test.sh     Needs: bash, python3 with PyYAML     Wall time: about 3 s.
# GL_WF=<path> runs the same checks against another copy of the workflow; GL_OLD=<path> replaces the negative-control file.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
python3 -c 'import yaml' 2>/dev/null || { echo "security-shared guard tests: needs python3 with PyYAML (pip install pyyaml)"; exit 2; }
exec python3 -I "$HERE/security-shared-guard.test.py" "${GL_WF:-$HERE/../.github/workflows/security-shared.yml}" "${GL_OLD:-$HERE/fixtures/security-shared.before-t11229.yml}"

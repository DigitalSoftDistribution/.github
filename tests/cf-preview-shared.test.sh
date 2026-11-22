#!/usr/bin/env bash
# Offline test of .github/workflows/cf-preview-shared.yml (G-466 OSP-infra 3.1, T-14303) with its test caller
# tests/fixtures/cf-preview-caller.yml: the coolify-ci runner, the deploy flag (a dry run runs only `plan` and needs no
# secret), where each secret may go, the caller contract, and the plan and Worker Previews steps run in bash under a
# cleared environment with stub `gh` and `wrangler`. Six mutations of the workflow are the negative control: each must
# make its check fail. No network, no credential, no runner.
#
# Usage: bash tests/cf-preview-shared.test.sh     Needs: bash, jq, python3 with PyYAML     Wall time: a few seconds.
# CF_WF=<path> / CF_CALLER=<path> run the same checks against other copies.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
python3 -I -c 'import yaml' 2>/dev/null || { echo "cf-preview-shared tests: needs python3 with PyYAML (pip install pyyaml)"; exit 2; }
exec python3 -I "$HERE/cf-preview-shared.test.py" "${CF_WF:-$HERE/../.github/workflows/cf-preview-shared.yml}" "${CF_CALLER:-$HERE/fixtures/cf-preview-caller.yml}"

#!/usr/bin/env bash
# Offline test for the routing of the `ci` job of .github/workflows/ci-shared.yml (G-218 T-13997): which runner a push to main,
# a merge group, a pull request and a schedule get (a merge group never on a trusted lane: coolify-ci-main / -deploy / -hotfix),
# the guard step that fails a merge group naming a trusted lane before checkout, the concurrency group that cancels superseded
# pull-request runs only, and the draft skip that is now on by default. The runs-on, concurrency and if values are evaluated by a
# small evaluator of the GitHub expression subset they use; the guard step runs in bash under a cleared environment. Five mutations
# of the workflow are the negative control: each must make its check fail. No network, no credential, no runner.
#
# Usage: bash tests/ci-shared-routing.test.sh     Needs: bash, python3 with PyYAML     Wall time: about 1 s.
# CI_WF=<path> runs the same checks against another copy of the workflow.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
python3 -c 'import yaml' 2>/dev/null || { echo "ci-shared routing tests: needs python3 with PyYAML (pip install pyyaml)"; exit 2; }
exec python3 -I "$HERE/ci-shared-routing.test.py" "${CI_WF:-$HERE/../.github/workflows/ci-shared.yml}"

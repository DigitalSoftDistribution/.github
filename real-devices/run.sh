#!/usr/bin/env bash
# Runs a repo's real-device specs through this harness. The reusable workflow calls it; so can a person or an agent.
#
#   RD_SPEC_DIR=<repo>/tests/real-devices RD_BASE_URL=https://example.com RD_MODE=local \
#     RD_DEVICES=iphone-16-ios18-safari,desktop-chrome real-devices/run.sh [playwright test args]
#
# RD_MODE=local needs local browsers once: (cd real-devices && npx playwright install chromium webkit).
# Specs import { test, expect, ... } from '@dsd/real-devices' and '@playwright/test'. Both resolve through a
# node_modules link that this script puts in the spec dir for the run and removes afterwards, so a caller repo
# needs no install and the specs and the runner share one Playwright.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${RD_SPEC_DIR:?RD_SPEC_DIR is required}"
: "${RD_BASE_URL:?RD_BASE_URL is required}"
spec_dir="$(cd "$RD_SPEC_DIR" && pwd)"
export RD_SPEC_DIR="$spec_dir"

[ -d "$here/node_modules/@playwright/test" ] || { echo "real-devices: run 'npm ci' in $here first" >&2; exit 2; }
# A copy, not a link: Playwright transpiles every imported file whose real path is outside node_modules, which
# would turn this ESM package into CommonJS. Inside node_modules Node loads it as it is.
pkg="$here/node_modules/@dsd/real-devices"
rm -rf "$pkg"
mkdir -p "$pkg"
cp "$here/package.json" "$here/index.mjs" "$here/devices.mjs" "$pkg/"

link="$spec_dir/node_modules"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "real-devices: $link is a real directory; the spec dir must not carry its own node_modules" >&2
  exit 2
fi
ln -sfn "$here/node_modules" "$link"
trap 'rm -f "$link"' EXIT

cd "$here"
./node_modules/.bin/playwright test --config playwright.config.mjs "$@"

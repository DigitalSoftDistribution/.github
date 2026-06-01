# DigitalSoftDistribution

Org-shared CI workflows + standard config.

## Reusable workflows

Each repo in this org calls these three workflows from a tiny per-repo wrapper:

```yaml
# .github/workflows/ci.yml in any consumer repo
name: ci
on: [pull_request, push]
jobs:
  ci:
    uses: DigitalSoftDistribution/.github/.github/workflows/ci-shared.yml@main
    secrets: inherit
```

| Workflow | Purpose | Required for merge |
|---|---|---|
| [`ci-shared.yml`](./.github/workflows/ci-shared.yml) | typecheck + lint + test | ✅ |
| [`security-shared.yml`](./.github/workflows/security-shared.yml) | gitleaks + npm audit + CodeQL | ✅ |
| [`merge-mate-shared.yml`](./.github/workflows/merge-mate-shared.yml) | auto-rebase open PRs against main | (advisory) |

## What this replaces

Prior to 2026-06, each repo had 6-10 workflow files duplicating the same logic.
This rebuild consolidates to a single source of truth.

## Build & deploy ownership

GitHub Actions never builds prod artifacts. Coolify (https://coolify.softblaze.net)
owns build + deploy on push to main via webhook. CI here only validates correctness.

## Branch protection

All repos in this org require exactly two status checks:
- `ci`
- `security`

Everything else is informational.

# DigitalSoftDistribution — infrastructure & workflow reference

**Audience:** every coding agent (Claude Code, Cursor, codex, glm, kimi) and
every human dev working on any DigitalSoftDistribution repo. Read this
before doing anything that involves CI, deploys, PRs, or merges.

Last updated: 2026-06-01 — major workflow restructure landed today.

## TL;DR for agents

```
local dev → gk ai commit → git push → gh pr create (or gk ai pr create)
  → CodeRabbit + Cursor Bugbot review automatically (GitHub Apps, advisory)
  → ci + security checks run on GitHub Actions (REQUIRED)
  → Merge Mate auto-rebases main into PR
  → reviewer (you) hits gh pr merge --squash
  → Coolify webhook fires → builds + deploys to <app>.apps.softblaze.net
```

**There is no `gk merge`. Final merge is always `gh pr merge` (or the
GitHub web button). gk handles authoring + AI; gh handles merging.**

## Infrastructure map

| Host | Type | Role |
|---|---|---|
| **Beast** | Dedicated server (96-core, NOT Hetzner cloud) | Cursor Remote-SSH workspace, dev box, `agent-state` service, `pr-watch` auto-fix runner, `gk` CLI (authenticated as SublimeMinds Pro / 250K weekly AI tokens) |
| **mcp-fleet** | Hetzner cpx62 cloud VPS (49.13.202.136) | All MCP supergateway processes, ContextForge gateway. NOT Beast. |
| **coolify-vps** | Hetzner cpx62 cloud VPS (178.105.222.41) | Coolify deploy platform — webhooks from GitHub, builds + deploys every prod app |
| **Cloudflare Worker** | `agent-state-edge.softblaze.net` | Proxies Mac publisher → Beast `agent-state`. KV-backed stale-while-error (24h fallback if Beast dies). |

## Production URLs

- **All apps:** `<app>.apps.softblaze.net` (e.g. `distivo.apps.softblaze.net`, `beamdesk.apps.softblaze.net`)
- **There is NO preview URL pattern.** Coolify only deploys main; per-PR previews are not used.
- **Beast SSH:** through CF Tunnel at `ssh-beast.softblaze.net`

## CI architecture — every repo has exactly 3 workflows

All three are tiny wrappers calling org-shared reusable workflows in
`DigitalSoftDistribution/.github`:

```
.github/workflows/
  ci.yml          → typecheck + lint + test         (calls ci-shared.yml)
  security.yml    → gitleaks + npm audit + CodeQL    (calls security-shared.yml)
  merge-mate.yml  → auto-rebase main into PR         (calls merge-mate-shared.yml)
```

**Build is intentionally NOT in CI.** Coolify owns the build step. GitHub
Actions only validates correctness, never produces a deployable artifact.

**Self-hosted GitHub runners are FORBIDDEN.** Never set `runs-on:
self-hosted` or `[self-hosted, beast]`. Use `ubuntu-latest`. A
beamdesk/unit-tests.yml that ran on `self-hosted, beamdesk-beast` was
the single biggest cause of Beast load spikes — it's been deleted.

## Branch protection (all repos)

Required status checks: **`ci` and `security`. Nothing else.** Everything
else (CodeRabbit, Bugbot, Merge Mate, pipeline/*) is advisory.

If a PR sits with "pending" on something other than ci or security,
it's a ghost check — drop it; do not block the merge waiting for it.

## Reviewers (GitHub Apps — no workflow files needed)

| App | What it does | Required? |
|---|---|---|
| CodeRabbit | AI review of PR diff, posts inline + summary comments | Advisory |
| Cursor Bugbot | Cursor-specific bug review | Advisory |
| Dependabot | Weekly dep update PRs | n/a |
| Merge Mate | Auto-rebase main → open PRs; gated by `confidence-threshold: 80` | Advisory but if it parks at low confidence you must resolve manually |

## GitKraken `gk` CLI — what it can and can't do

**Can (verified 2026-06-01):**
- `gk ai commit` — AI-generated commit message from staged diff
- `gk ai pr create` — AI-generated PR title + body
- `gk ai explain branch|commit` — AI explanation
- `gk ai resolve` — AI-guided merge conflict resolution (the "guide me through it" tool)
- `gk ai changelog` — generate changelog between two refs
- `gk ai tokens` — show remaining quota (250K/week, resets weekly)
- `gk pr list` — list PRs assigned to you (read-only)

**Cannot:**
- ❌ `gk merge`, `gk pr merge`, `gk ai pr merge` — **GitKraken has no merge command**, verified across CLI subcommands AND MCP tools (29 tools, 0 contain "merge")
- ❌ `gk pr create` (top-level) — only `gk ai pr create` exists

**Where to merge:** `gh pr merge <N> --squash` (or the GitHub web button).
Always squash unless you have a specific reason to rebase or merge-commit.

## Merge conflicts

```bash
# Cursor or VSCode is fine, OR:
gk ai resolve      # AI-guided resolution; tells you which side to keep
# OR Merge Mate auto-rebases at confidence > 80%; check its PR comment.
```

## Deploy flow

```
git push main (or gh pr merge to main)
  ↓
GitHub webhook → Coolify (https://coolify.softblaze.net)
  ↓
Coolify pulls main, builds container, deploys to <app>.apps.softblaze.net
  ↓
~3-8 min later: live
```

Coolify also has per-PR preview support BUT it is currently disabled across all
apps — do not assume a per-branch URL exists.

## pr-watch (Beast) — what it does, when to NOT trust it

Lives at `/home/devops/pr-trigger-runner` on Beast. Watches
`/var/log/pr-watch/triggers.jsonl` and dispatches a CLI agent
(codex round 1, cursor round 2, glm round 3) when CR/Bugbot leave
unresolved findings on a PR. Aims to auto-fix bot findings without
human intervention.

**Keep alive.** Use `dispatch-build` from Beast to fire feature builds:

```bash
ssh beast '/home/devops/bin/dispatch-build \
  --cli codex --playbook feature-build \
  --task-file SPEC.md --branch feat/SB-XXXX \
  --cwd /home/devops/beamdesk--SB-XXXX'
```

Status: `/pipeline-status` skill or `mcp__pr-pipeline__pipeline_health`.

## Things NOT to do

- Don't `git push --force` to main without explicit user permission.
- Don't bypass branch protection via admin override.
- Don't run `npm install` / `pnpm build` locally — use `beast install`, `beast build` if working on Beast (the dedicated server has the cached node_modules).
- Don't create or restore workflow files named `bot-review-gate.yml`, `lighthouse.yml`, `firecrawl-screenshots.yml`, `preview-smoke.yml`, `db-migrate.yml`, `i18n-completeness.yml`, `merge-mate-review.yml` — these were consolidated into the 3-workflow structure today.
- Don't set `runs-on: self-hosted` or `[self-hosted, beast]` anywhere — these tank Beast.
- Don't `VACUUM` Beast's Cursor `state.vscdb` (14 GB, has known issues but user wants it kept intact).
- Don't reinstall the agent-state-bar Cursor extension below v1.3.0 — earlier versions had `execFileSync` + unbounded globalState bloat that hung the workspace.

## Where the auth lives

- `gk` (GitKraken) — Beast `~/.gitkraken/` (devops user)
- `gh` (GitHub) — Beast `~/.config/gh/`
- Cloudflare API token — Beast `~/.secrets/cloudflare-global-key-2026-05-25`
- Coolify API token — Beast `~/.coolify-mcp.env`
- Hetzner Cloud token — Beast `~/.secrets/hetzner-hcloud-token` (also Mac)
- KluczeSoft.pl SSH — `ssh kluczesoft-pl` alias on Beast

## Quick reference — the day-to-day commands

```bash
# Start work
cd <repo>
git checkout -b feat/SB-XXXX-description

# Develop, then:
git add .
gk ai commit             # AI commit message; -p prompts for review
git push -u origin HEAD

# Open PR
gh pr create --title "..." --body "..."
# OR
gk ai pr create

# After review + checks pass:
gh pr merge <N> --squash

# Conflicts:
gk ai resolve

# Branch summary
gk ai explain branch

# Changelog between two tags
gk ai changelog --from v1.0.0 --to v1.1.0
```

## Open issues / known TODOs

- mcp-fleet's `mcp-gitkraken` PM2 process is running but unauthed → MCP endpoint serves nothing. Either fresh token + auth OR leave it (CLI on Beast covers all use cases).
- agent-state FastAPI still on Beast (planned migration to mcp-fleet deferred — current path through CF Worker has stale-while-error so Beast outages don't break Command Central).

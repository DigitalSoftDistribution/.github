# hallmark: the advisory design check

Decision 2026-10-26 (coordinator, on the Docs audit "Hallmark audit"): adopt Hallmark partly. This directory is the CI half: `hallmark-profile.mjs` wraps Hallmark's `sloplint` (Nutlope/hallmark, MIT, pinned commit `7ec868225c6caa040558c321ee0fefa0e73f83a8`, run unmodified) and keeps seven of its gates. The skill half is the explicit `hallmark` pack in dsh-plugins (opt-in, Orviel web pages only).

## The seven gates

| gate | what | why it is in |
|---|---|---|
| 40 | form-field edge under 3:1 against its surround | WCAG 1.4.11; axe does not test it. Found 1.59:1 on Orviel and 1.10 to 1.69:1 on Distivo |
| 49a | a control wraps to a second line at 320 to 1920 px | Lizensa cookie-banner buttons, Orviel's reservation button |
| 73 | text painted under another element | needs an eye check |
| 75 | text under 11 px | Distivo vendor rows at 10 px |
| 25 | prose line over 75 characters | Lizensa and Distivo PDP at about 90 |
| 34 | `overflow-x` not `clip` on html and body | breaks sticky |
| 19 | copy tells: buzzword, cliche, placeholder name | not the em-dash rule (English style; it would flag German copy) |

Everything else sloplint reports (eyebrows, tracked caps, pure white, 4 px grid, hero must fit the fold, word counts, section counts) is counted as "outside the profile" and ignored: those are Hallmark's taste and clash with our brand contracts and tokens.

## Fails closed

Upstream prints `render tier not run` and exits 0 when puppeteer or Chrome is missing. Here that, a page that did not load, and a linter that prints no JSON are all exit 2. Findings alone never fail the run unless `--fail-on new|any` is set.

| exit | meaning |
|---|---|
| 0 | it ran; findings (if any) are warnings in the summary |
| 1 | it ran and `--fail-on` says the findings count |
| 2 | it could not run or could not render: fix the runner, not the page |

## Source, not build output

`--static <path>` lints css, html, jsx, tsx, vue, svelte and astro files and refuses a path under `dist`, `build`, `out`, `.next`. A linked stylesheet (`/styles.css` or relative) is inlined into a temporary copy first; upstream pairs a page with the css beside it and gave 6 false FAILs on Orviel's nested `/id/` and `/thanks/` pages. Rendering needs a build: `--serve <built dir>` serves it on loopback in this process; `--url` takes a deployed preview.

## Egress

Chrome starts with `--host-resolver-rules` so it reaches only 127.0.0.1 plus the hosts of `--url` and `--allow-host`. Analytics, chat widgets and Stripe.js do not load (so a page that needs them for layout shows less). `--no-egress-limit` turns this off.

## Use

```
node hallmark/hallmark-profile.mjs --tool <hallmark checkout | skills/hallmark/scripts> \
  --static src --serve dist --route / --route /id/ --genre atmospheric --out hallmark-out
```

In CI call `.github/workflows/hallmark-shared.yml` (header has a caller example). The job is on `coolify-ci`, not a required check. It finds Chrome via `CHROME_PATH`, the usual paths, or Playwright's Chromium under `PLAYWRIGHT_BROWSERS_PATH` (baked into the CI image), and adds `--no-sandbox --disable-dev-shm-usage` when `CI` or `GITHUB_ACTIONS` is set.

`.hallmark-profile.json` in the project (optional): `{ "gates": [...], "exclude": [{ "gate": "49a", "evidence": "button\\.flex\\.flex-1" }], "static": [...], "serve": "dist", "routes": ["/"], "baseline": "hallmark-baseline.json" }`. `--baseline file --write-baseline` records today's findings; with `--fail-on new` only a finding not in the file counts. A measurement moving (1.59:1 to 1.61:1) is the same finding.

## Proof (26 Oct 2026, sandbox on beast, real sloplint, Orviel landing v2)

`--static src --serve dist --route / --route /id/` found 5 findings in 16 s: gate 34 (`styles.css:15` body `overflow-x: hidden`), gate 40 twice (field edges 1.59:1 on `/` and `/id/`) and gate 49a twice (the reservation button wraps at 320 px). The 104 other raw findings were ignored. With no puppeteer, a missing `CHROME_PATH` file, or `--static dist`, it exits 2 with the reason.

## Rollback

Delete this directory and the two workflows. Callers lose one advisory job.

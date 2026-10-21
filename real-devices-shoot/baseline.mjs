// Baseline handling for the real-devices-shoot workflow (G-218). Dependency-free, node >= 20.
//
// The shoot engine (beast-infra mcp/browserstack) compares a new shoot with the previous shoot of the same app + base
// that it finds in <BROWSERSTACK_LEDGER_DIR>/shoots.jsonl, and reads that shoot's manifest.json and pngs from the row's
// `dir`. A fresh runner has neither, so:
//
//   restore  downloads the newest unexpired baseline artifact of the DEFAULT branch, puts its folder under OUT_DIR and
//            writes the one shoots.jsonl row the engine needs (dir rewritten to this runner, base set to this run's
//            base: a PR preview URL never equals the default branch URL, and the baseline is by definition "the
//            default branch's shoot of the same app").
//   pack     after the shoot, writes _baseline.json (the shoot's ledger row) into the shoot folder, so the folder
//            uploaded as the artifact can be restored next time.
//
// Neither command ever fails the job: no baseline just means "nothing to compare with".
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const META = '_baseline.json';
const gh = (args, env = process.env) => execFileSync(env.GH_BIN || 'gh', args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Artifact names are [A-Za-z0-9._-]; a baseline is per app (or "urls"). */
export function artifactName(app) {
  return `real-devices-shoot-${String(app || 'urls').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}`;
}

/** The newest unexpired artifact called `name` that a run of `branch` uploaded. */
export function pickBaseline(artifacts, name, branch) {
  return (artifacts || [])
    .filter((a) => a && a.name === name && !a.expired && a.workflow_run?.head_branch === branch)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

export function readRows(ledgerDir) {
  try {
    return fs.readFileSync(path.join(ledgerDir, 'shoots.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function restore({ repo, branch, app, base, ledgerDir, outDir, env = process.env }) {
  const name = artifactName(app);
  if (!branch) {
    // some events (schedule) carry no repository payload: ask the API
    try { branch = gh(['api', `repos/${repo}`, '--jq', '.default_branch'], env).trim(); } catch { /* handled below */ }
  }
  const res = { baseline: '', name };
  let list;
  try {
    list = JSON.parse(gh(['api', `repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=50`], env)).artifacts;
  } catch (e) {
    res.note = `could not list artifacts: ${String(e.stderr || e.message).slice(0, 200)}`;
    return res;
  }
  const art = pickBaseline(list, name, branch);
  if (!art) { res.note = `no ${name} artifact from ${branch} yet: this shoot has nothing to compare with`; return res; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-baseline-'));
  try {
    gh(['run', 'download', String(art.workflow_run.id), '-R', repo, '-n', name, '-D', tmp], env);
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, META), 'utf8'));
    if (!meta.shoot || !/^[A-Za-z0-9._-]+$/.test(meta.shoot)) throw new Error('baseline metadata has no usable shoot id');
    const dest = path.join(outDir, meta.shoot);
    fs.mkdirSync(outDir, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    fs.rmSync(path.join(dest, META), { force: true });
    fs.mkdirSync(ledgerDir, { recursive: true });
    const row = { ...meta, base: base || null, dir: dest, gallery_url: path.join(dest, 'index.html'), gallery_base: `${dest}/` };
    fs.appendFileSync(path.join(ledgerDir, 'shoots.jsonl'), `${JSON.stringify(row)}\n`);
    res.baseline = meta.shoot;
    res.run = art.workflow_run.id;
  } catch (e) {
    res.note = `baseline artifact unusable: ${String(e.stderr || e.message).slice(0, 200)}`;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return res;
}

export function pack({ shoot, dir, ledgerDir }) {
  const row = readRows(ledgerDir).reverse().find((r) => r.shoot === shoot);
  if (!row) return false;
  // drop what the next runner must not trust: absolute paths are rewritten on restore, and the previous diff is history
  const { dir: _d, gallery_url: _g, gallery_base: _b, ...meta } = row;
  fs.writeFileSync(path.join(dir, META), `${JSON.stringify(meta)}\n`);
  return true;
}

function out(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value).replace(/\n/g, ' ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const e = process.env;
  const cmd = process.argv[2];
  if (cmd === 'restore') {
    const r = restore({ repo: e.RD_REPO, branch: e.RD_DEFAULT_BRANCH, app: e.RD_APP_KEY, base: e.RD_BASE, ledgerDir: e.BROWSERSTACK_LEDGER_DIR, outDir: e.BROWSERSTACK_OUT_DIR });
    out('baseline', r.baseline);
    console.log(r.baseline ? `baseline restored: ${r.baseline} (run ${r.run})` : `no baseline: ${r.note}`);
  } else if (cmd === 'pack') {
    const ok = pack({ shoot: e.RD_SHOOT, dir: e.RD_SHOOT_DIR, ledgerDir: e.BROWSERSTACK_LEDGER_DIR });
    console.log(ok ? `baseline metadata written to ${e.RD_SHOOT_DIR}` : `no ledger row for ${e.RD_SHOOT}: this shoot cannot be a baseline`);
  } else {
    console.error('usage: baseline.mjs restore|pack');
    process.exit(2);
  }
}

// node --test real-devices-shoot/test. No network, no key: gh is a stub, the CLI is a stub that answers a
// contract-shaped result and folder (beast-infra mcp/browserstack/CONTRACT: manifest.json v1, `--json` done output).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactName, pickBaseline, restore, pack, readRows, META } from '../baseline.mjs';
import { classify, buildComment, topChanged, failedShots, postComment, marker } from '../report.mjs';
import { createServer } from '../static-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rds-test-'));

/** A shoot folder as the engine writes it. */
function makeShoot(root, id, { changed = [], failed = [] } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const routes = [{ id: 'now', route: '#/now', url: 'x' }, { id: 'goals', route: '#/goals', url: 'x' }, { id: 'health-ops', route: '#/health/ops', url: 'x' }];
  const shots = [];
  for (const r of routes) {
    for (const device of ['iphone-16-ios18-safari', 'desktop-chrome']) {
      const c = changed.find((x) => x.route_id === r.id && x.device === device);
      const f = failed.find((x) => x.route_id === r.id && x.device === device);
      shots.push({ route_id: r.id, device, theme: 'light', ok: !f, error: f?.error, png: `${r.id}-${device}.png`, diff: f ? null : { prev_png: 'p.png', ratio: c ? c.ratio : 0, changed: Boolean(c) } });
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, shoot: id, app: 'cc-demo', routes, shots }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'now-desktop.png'), 'png');
  return dir;
}

/** A stand-in for gh. State comes from STUB_* env files. */
function makeGh(dir) {
  const file = path.join(dir, 'gh');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const log = (o) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(o) + '\\n');
if (a[0] === 'api' && /actions\\/artifacts/.test(a[1])) { process.stdout.write(fs.readFileSync(process.env.STUB_ARTIFACTS, 'utf8')); }
else if (a[0] === 'api' && a[1] === '--') { process.exit(1); }
else if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+$/.test(a[1]) && a.includes('--jq')) { process.stdout.write('main\\n'); }
else if (a[0] === 'run' && a[1] === 'download') {
  const d = a[a.indexOf('-D') + 1];
  fs.cpSync(process.env.STUB_FIXTURE, d, { recursive: true });
  log({ download: a[2], name: a[a.indexOf('-n') + 1] });
} else if (a[0] === 'api' && /issues\\/\\d+\\/comments$/.test(a[1]) && !a.includes('-X')) { process.stdout.write(fs.readFileSync(process.env.STUB_COMMENTS, 'utf8')); }
else if (a[0] === 'api' && a.includes('-X')) { log({ method: a[a.indexOf('-X') + 1], url: a[a.indexOf('-X') + 2], body: JSON.parse(fs.readFileSync(0, 'utf8')).body }); }
else { process.stderr.write('stub gh: unexpected ' + a.join(' ')); process.exit(1); }
`, { mode: 0o755 });
  return file;
}

test('artifactName is file safe and per app', () => {
  assert.equal(artifactName('cc-demo'), 'real-devices-shoot-cc-demo');
  assert.equal(artifactName(''), 'real-devices-shoot-urls');
  assert.equal(artifactName('a b/c'), 'real-devices-shoot-a-b-c');
});

test('pickBaseline: default branch only, unexpired, newest', () => {
  const n = 'real-devices-shoot-x';
  const list = [
    { id: 1, name: n, expired: false, created_at: '2026-10-01T00:00:00Z', workflow_run: { id: 1, head_branch: 'main' } },
    { id: 2, name: n, expired: false, created_at: '2026-10-03T00:00:00Z', workflow_run: { id: 2, head_branch: 'feat/x' } },
    { id: 3, name: n, expired: true, created_at: '2026-10-04T00:00:00Z', workflow_run: { id: 3, head_branch: 'main' } },
    { id: 4, name: n, expired: false, created_at: '2026-10-02T00:00:00Z', workflow_run: { id: 4, head_branch: 'main' } },
    { id: 5, name: 'other', expired: false, created_at: '2026-10-05T00:00:00Z', workflow_run: { id: 5, head_branch: 'main' } },
  ];
  assert.equal(pickBaseline(list, n, 'main').id, 4);
  assert.equal(pickBaseline([], n, 'main'), null);
});

test('pack then restore: the next runner gets the folder and a ledger row with its own paths and base', () => {
  // run 1, on the default branch: the engine leaves a folder and a ledger row
  const r1 = tmp();
  const out1 = path.join(r1, 'out');
  const led1 = path.join(r1, 'bs');
  fs.mkdirSync(led1, { recursive: true });
  const dir1 = makeShoot(out1, '20261020-cc-demo-aaaa1111');
  fs.writeFileSync(path.join(led1, 'shoots.jsonl'), `${JSON.stringify({ shoot: '20261020-cc-demo-aaaa1111', app: 'cc-demo', base: 'http://127.0.0.1:41000/index.html', created: 'c', caller: 'ci:r', dir: dir1, gallery_url: `${dir1}/index.html`, gallery_base: `${dir1}/`, counts: { shots: 6 }, diffs: {}, minutes: 1 })}\n`);
  assert.equal(pack({ shoot: '20261020-cc-demo-aaaa1111', dir: dir1, ledgerDir: led1 }), true);
  const meta = JSON.parse(fs.readFileSync(path.join(dir1, META), 'utf8'));
  assert.equal(meta.dir, undefined);
  assert.equal(meta.shoot, '20261020-cc-demo-aaaa1111');
  assert.equal(pack({ shoot: 'nope', dir: dir1, ledgerDir: led1 }), false);

  // run 2, a fresh runner: gh finds the artifact and downloads it
  const r2 = tmp();
  const gh = makeGh(r2);
  const arts = path.join(r2, 'arts.json');
  fs.writeFileSync(arts, JSON.stringify({ artifacts: [{ id: 9, name: 'real-devices-shoot-cc-demo', expired: false, created_at: '2026-10-20T10:00:00Z', workflow_run: { id: 777, head_branch: 'main' } }] }));
  const env = { ...process.env, GH_BIN: gh, STUB_ARTIFACTS: arts, STUB_FIXTURE: dir1, STUB_LOG: path.join(r2, 'log') };
  const out2 = path.join(r2, 'out');
  const led2 = path.join(r2, 'bs');
  const res = restore({ repo: 'o/r', branch: 'main', app: 'cc-demo', base: 'http://127.0.0.1:42222/index.html', ledgerDir: led2, outDir: out2, env });
  assert.equal(res.baseline, '20261020-cc-demo-aaaa1111');
  const rows = readRows(led2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dir, path.join(out2, '20261020-cc-demo-aaaa1111'));
  assert.equal(rows[0].base, 'http://127.0.0.1:42222/index.html', 'base is rewritten to this run, the port differs every time');
  assert.equal(rows[0].app, 'cc-demo');
  assert.ok(fs.existsSync(path.join(rows[0].dir, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(rows[0].dir, META)));
});

test('restore without a baseline is a note, not an error', () => {
  const r = tmp();
  const gh = makeGh(r);
  const arts = path.join(r, 'arts.json');
  fs.writeFileSync(arts, JSON.stringify({ artifacts: [] }));
  const res = restore({ repo: 'o/r', branch: 'main', app: 'cc-demo', base: '', ledgerDir: path.join(r, 'bs'), outDir: path.join(r, 'out'), env: { ...process.env, GH_BIN: gh, STUB_ARTIFACTS: arts, STUB_LOG: path.join(r, 'log') } });
  assert.equal(res.baseline, '');
  assert.match(res.note, /nothing to compare/);
  assert.deepEqual(readRows(path.join(r, 'bs')), []);
});

test('restore: an artifact that is not a baseline folder is ignored', () => {
  const r = tmp();
  const gh = makeGh(r);
  const arts = path.join(r, 'arts.json');
  fs.writeFileSync(arts, JSON.stringify({ artifacts: [{ id: 1, name: 'real-devices-shoot-cc-demo', expired: false, created_at: '2026-10-20T10:00:00Z', workflow_run: { id: 1, head_branch: 'main' } }] }));
  const fixture = path.join(r, 'fx');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'junk.txt'), 'x');
  const res = restore({ repo: 'o/r', branch: 'main', app: 'cc-demo', base: '', ledgerDir: path.join(r, 'bs'), outDir: path.join(r, 'out'), env: { ...process.env, GH_BIN: gh, STUB_ARTIFACTS: arts, STUB_FIXTURE: fixture, STUB_LOG: path.join(r, 'log') } });
  assert.equal(res.baseline, '');
  assert.match(res.note, /unusable/);
});

test('classify: ok, partial, refused (warn), broken (fail)', () => {
  const shot = { gallery_url: '/x/index.html' };
  assert.equal(classify(0, shot).kind, 'ok');
  assert.equal(classify(1, shot).verdict, 'warn');
  assert.deepEqual(classify(3, { ok: false, refused: true, code: 'CAP_SESSIONS_DAY', error: 'this shoot needs 12 sessions' }), { kind: 'refused', verdict: 'warn' });
  assert.deepEqual(classify(3, null), { kind: 'refused', verdict: 'warn' });
  assert.equal(classify(2, null).verdict, 'fail');
  assert.equal(classify(1, null).verdict, 'fail');
  assert.equal(classify(0, null).verdict, 'fail');
});

test('topChanged ranks by ratio and caps at 10; failedShots lists the reasons', () => {
  const r = tmp();
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push({ route_id: 'now', device: `d${i}`, ratio: i / 100 });
  const dir = makeShoot(r, 's1', { changed: [{ route_id: 'goals', device: 'desktop-chrome', ratio: 0.5 }, { route_id: 'now', device: 'desktop-chrome', ratio: 0.01 }], failed: [{ route_id: 'health-ops', device: 'iphone-16-ios18-safari', error: 'timeout' }] });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const top = topChanged(m);
  assert.equal(top[0].route, '#/goals');
  assert.equal(top.length, 2);
  m.shots = many.map((c) => ({ route_id: c.route_id, device: c.device, theme: 'light', ok: true, diff: { ratio: c.ratio, changed: true } }));
  assert.equal(topChanged(m).length, 10);
  assert.equal(topChanged(m)[0].ratio, 0.11);
  const f = failedShots(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  assert.equal(f.total, 1);
  assert.equal(f.rows[0].error, 'timeout');
});

test('buildComment: marker first, counts, changed table, failed table, artifact link', () => {
  const r = tmp();
  const dir = makeShoot(r, 's1', { changed: [{ route_id: 'goals', device: 'desktop-chrome', ratio: 0.0123 }], failed: [{ route_id: 'health-ops', device: 'iphone-16-ios18-safari', error: 'a|b' }] });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const result = { counts: { routes: 3, shots: 6, ok: 5, failed: 1, flows: 0 }, diffs: { compared_to: 'prev-shoot', changed: 1, new: 0, removed: 0, same: 4 }, sessions: [], errors: [] };
  const body = buildComment({ key: 'cc-demo', app: 'cc-demo', kind: 'ok', result, manifest, errText: '', exit: 0, artifactUrl: 'https://github.com/o/r/actions/runs/1/artifacts/9', runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.ok(body.startsWith(marker('cc-demo')));
  assert.match(body, /3 routes, 6 shots: 5 ok, 1 failed/);
  assert.match(body, /\*\*1 changed\*\*/);
  assert.match(body, /\| `#\/goals` \| desktop-chrome \| light \| 1\.23% \|/);
  assert.match(body, /a\\\|b/);
  assert.match(body, /artifacts\/9/);
  const none = buildComment({ key: 'k', app: 'k', kind: 'ok', result: { counts: {}, diffs: { compared_to: null } }, manifest: null, exit: 0 });
  assert.match(none, /No default branch baseline/);
  const refused = buildComment({ key: 'k', app: 'k', kind: 'refused', result: { error: 'this shoot needs 12 sessions; you have 3 left today', estimate: { sessions: 12, minutes: 40 } }, exit: 3 });
  assert.match(refused, /Not shot \(refused, advisory\)\.\*\* this shoot needs 12 sessions/);
  assert.ok(buildComment({ key: 'k', kind: 'broken', exit: 2, errText: 'unknown app' }).includes('exit 2'));
});

test('postComment creates once, then edits the same comment in place', () => {
  const r = tmp();
  const gh = makeGh(r);
  const comments = path.join(r, 'comments.jsonl');
  const log = path.join(r, 'log');
  const env = { ...process.env, GH_BIN: gh, STUB_COMMENTS: comments, STUB_LOG: log };
  fs.writeFileSync(comments, '');
  assert.equal(postComment({ repo: 'o/r', pr: '5', key: 'cc-demo', body: `${marker('cc-demo')}\nfirst`, env }), 'created');
  fs.writeFileSync(comments, [{ id: 11, body: 'someone else' }, { id: 12, body: `${marker('cc-demo')}\nfirst` }, { id: 13, body: `${marker('lizensa')}\nother app` }].map((c) => JSON.stringify(c)).join('\n'));
  assert.equal(postComment({ repo: 'o/r', pr: '5', key: 'cc-demo', body: `${marker('cc-demo')}\nsecond`, env }), 'updated');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'repos/o/r/issues/comments/12');
});

test('static server serves the folder, 404s the rest and cannot leave it', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'site', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(dir, 'site', 'assets', 'a.js'), 'x');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  const server = createServer(path.join(dir, 'site'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p, method = 'GET') => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b })); });
    req.end();
  });
  try {
    assert.equal((await get('/index.html')).body, '<h1>hi</h1>');
    assert.equal((await get('/')).status, 200);
    assert.match((await get('/assets/a.js')).type, /javascript/);
    assert.equal((await get('/missing')).status, 404);
    assert.equal((await get('/../secret.txt')).status === 200, false);
    assert.equal((await get('/%2e%2e/secret.txt')).status === 200, false);
    assert.equal((await get('/index.html', 'POST')).status, 405);
  } finally { server.close(); }
});

test('end to end with a stub CLI: restore -> shoot -> locate -> pack -> report (the workflow, minus Actions)', () => {
  const r = tmp();
  const out = path.join(r, 'out');
  const led = path.join(r, 'bs');
  // a stub CLI that answers the contract: it reads the ledger like the engine, writes a folder and a ledger row
  const cli = path.join(r, 'cli.mjs');
  fs.writeFileSync(cli, `
import fs from 'node:fs'; import path from 'node:path';
const led = process.env.BROWSERSTACK_LEDGER_DIR, out = process.env.BROWSERSTACK_OUT_DIR;
if (!process.env.BROWSERSTACK_USERNAME) { console.error('no creds'); process.exit(2); }
const rows = fs.existsSync(path.join(led, 'shoots.jsonl')) ? fs.readFileSync(path.join(led, 'shoots.jsonl'), 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const base = process.argv[process.argv.indexOf('--base') + 1];
const prev = rows.filter((x) => x.app === process.argv[3] && x.base === base).pop();
const id = '20261021-' + process.argv[3] + '-bbbb2222';
const dir = path.join(out, id); fs.mkdirSync(dir, { recursive: true });
const shots = [['now', 'desktop-chrome', prev ? 0.04 : null], ['goals', 'desktop-chrome', prev ? 0 : null]].map(([route_id, device, ratio]) => ({ route_id, device, theme: 'light', ok: true, png: route_id + '.png', diff: prev ? { prev_png: 'x', ratio, changed: ratio > 0.002 } : null }));
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, shoot: id, app: process.argv[3], routes: [{ id: 'now', route: '#/now' }, { id: 'goals', route: '#/goals' }], shots }));
fs.writeFileSync(path.join(dir, 'index.html'), '<html/>');
const gallery_url = path.join(dir, 'index.html');
fs.appendFileSync(path.join(led, 'shoots.jsonl'), JSON.stringify({ shoot: id, app: process.argv[3], base, created: 'now', caller: 'ci:x', dir, gallery_url, gallery_base: dir + '/', counts: {}, diffs: {}, minutes: 1 }) + '\\n');
console.log(JSON.stringify({ ok: true, caller: 'ci:x', status: 'done', shoot: id, gallery_url, files: dir, counts: { routes: 2, shots: 2, ok: 2, failed: 0, flows: 0 }, diffs: prev ? { compared_to: prev.shoot, changed: 1, new: 0, removed: 0, same: 1 } : { compared_to: null, changed: 0, new: 0, removed: 0, same: 0 }, sessions: [], errors: [] }));
`);
  const baseEnv = (extra) => ({ ...process.env, BROWSERSTACK_LEDGER_DIR: led, BROWSERSTACK_OUT_DIR: out, BROWSERSTACK_USERNAME: 'u', BROWSERSTACK_ACCESS_KEY: 'k', GITHUB_OUTPUT: path.join(r, 'gho'), GITHUB_STEP_SUMMARY: path.join(r, 'sum'), ...extra });
  const bin = (name, env) => spawnSync('node', [path.join(HERE, '..', name), ...(env.ARGS || [])], { env, encoding: 'utf8' });
  const gh = makeGh(r);
  const comments = path.join(r, 'comments.jsonl');
  fs.writeFileSync(comments, '');
  const arts = path.join(r, 'arts.json');
  fs.writeFileSync(arts, JSON.stringify({ artifacts: [] }));
  const log = path.join(r, 'log');
  const shootOnce = (BASE, fixtureDir) => {
    fs.mkdirSync(led, { recursive: true });
    const env = baseEnv({ GH_BIN: gh, STUB_ARTIFACTS: arts, STUB_FIXTURE: fixtureDir || r, STUB_LOG: log, STUB_COMMENTS: comments, RD_REPO: 'o/r', RD_DEFAULT_BRANCH: 'main', RD_APP_KEY: 'cc-demo', RD_BASE: BASE, RD_PR: '7', RD_RUN_URL: 'https://github.com/o/r/actions/runs/1', RD_ARTIFACT_URL: 'https://github.com/o/r/actions/runs/1/artifacts/1' });
    const restored = spawnSync('node', [path.join(HERE, '..', 'baseline.mjs'), 'restore'], { env, encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    const res = spawnSync('node', [cli, 'shoot', 'cc-demo', '--base', BASE, '--json'], { env, encoding: 'utf8' });
    fs.writeFileSync(path.join(r, 'result.json'), res.stdout);
    fs.writeFileSync(path.join(r, 'err.txt'), res.stderr);
    const parsed = JSON.parse(res.stdout);
    const packed = spawnSync('node', [path.join(HERE, '..', 'baseline.mjs'), 'pack'], { env: { ...env, RD_SHOOT: parsed.shoot, RD_SHOOT_DIR: parsed.files }, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const rep = spawnSync('node', [path.join(HERE, '..', 'report.mjs')], { env: { ...env, RD_RESULT: path.join(r, 'result.json'), RD_ERR: path.join(r, 'err.txt'), RD_EXIT: String(res.status) }, encoding: 'utf8' });
    assert.equal(rep.status, 0, rep.stderr);
    return { parsed, env, rep };
  };

  // 1: no baseline yet
  const first = shootOnce('http://127.0.0.1:40001/index.html');
  assert.equal(first.parsed.diffs.compared_to, null);
  assert.match(fs.readFileSync(path.join(r, 'sum'), 'utf8'), /No default branch baseline/);
  assert.match(fs.readFileSync(log, 'utf8'), /"method":"POST"/);
  // the folder of run 1 is what the artifact holds; wipe the runner and simulate run 2 on a fresh one
  fs.writeFileSync(arts, JSON.stringify({ artifacts: [{ id: 1, name: 'real-devices-shoot-cc-demo', expired: false, created_at: '2026-10-21T00:00:00Z', workflow_run: { id: 5, head_branch: 'main' } }] }));
  const fixture = path.join(r, 'artifact');
  fs.cpSync(first.parsed.files, fixture, { recursive: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(led, { recursive: true, force: true });
  fs.writeFileSync(comments, JSON.stringify({ id: 99, body: `${marker('cc-demo')}\nold` }));
  // 2: a PR run: another port, a baseline exists, the comment is edited in place
  const second = shootOnce('http://127.0.0.1:40999/index.html', fixture);
  assert.equal(second.parsed.diffs.compared_to, '20261021-cc-demo-bbbb2222', 'the engine found the restored baseline');
  assert.equal(second.parsed.diffs.changed, 1);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, 'repos/o/r/issues/comments/99');
  assert.match(patch.body, /\*\*1 changed\*\*/);
  assert.match(patch.body, /\| `#\/now` \| desktop-chrome \| light \| 4\.00% \|/);
  assert.match(fs.readFileSync(path.join(r, 'gho'), 'utf8'), /verdict=ok/);
});

test('report with a refusal and with a broken run sets the verdict and annotation', () => {
  const r = tmp();
  const run = (exit, result, err) => {
    fs.writeFileSync(path.join(r, 'result.json'), result);
    fs.writeFileSync(path.join(r, 'err.txt'), err);
    fs.writeFileSync(path.join(r, 'gho'), '');
    return spawnSync('node', [path.join(HERE, '..', 'report.mjs')], { env: { ...process.env, RD_RESULT: path.join(r, 'result.json'), RD_ERR: path.join(r, 'err.txt'), RD_EXIT: String(exit), RD_APP_KEY: 'cc-demo', GITHUB_OUTPUT: path.join(r, 'gho'), GITHUB_STEP_SUMMARY: path.join(r, 'sum') }, encoding: 'utf8' });
  };
  const refused = run(3, JSON.stringify({ ok: false, refused: true, code: 'CAP_SESSIONS_DAY', error: 'this shoot needs 12 sessions / 40 device-minutes; you have 3 sessions left today' }), '');
  assert.match(refused.stdout, /::warning title=real-devices-shoot refused::this shoot needs 12 sessions/);
  assert.match(fs.readFileSync(path.join(r, 'gho'), 'utf8'), /verdict=warn/);
  const broken = run(2, '', 'unknown app "x"');
  assert.match(broken.stdout, /::error title=real-devices-shoot::the shoot run broke: unknown app/);
  assert.match(fs.readFileSync(path.join(r, 'gho'), 'utf8'), /verdict=fail/);
  assert.equal(execFileSync('node', ['--check', path.join(HERE, '..', 'report.mjs')]).length, 0);
});

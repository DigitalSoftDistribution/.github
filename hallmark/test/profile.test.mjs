// node --test hallmark/test. No network, no Chrome, no real sloplint: the tool is a stub that prints a canned report, so
// every branch of the fail-closed logic runs anywhere. The real linter is exercised by the workflow itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GATES, DEFAULT_EXCLUDE, InfraError, applyBaseline, assertRendered, createStaticServer, filterFindings, findChrome, findPuppeteer,
  findingKey, inlineStylesheets, main, playwrightChromium, prepareStatic, renderSummary, resolveSloplint, writeChromeWrapper,
} from '../hallmark-profile.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hp-test-'));
const write = (file, body = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
const quiet = { log: () => {} };
const F = (gate, evidence, extra = {}) => ({ gate, grade: 'FAIL', file: 'x.css', line: 3, evidence, fix: 'fix it', ...extra });

/** A stub hallmark tool: scripts/sloplint.mjs prints stub-static.json or stub-render.json (when --url is given). */
function stubTool(dir, { staticReport, renderReport, exitCode = 0, raw = null } = {}) {
  write(path.join(dir, 'scripts', 'sloplint.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const render = args.includes('--url');
fs.writeFileSync(path.join(process.cwd(), render ? 'called-render.json' : 'called-static.json'), JSON.stringify({ args, chrome: process.env.CHROME_PATH, pup: process.env.HALLMARK_PUPPETEER, cwd: process.cwd() }));
const raw = ${JSON.stringify(raw)};
if (raw !== null) { process.stdout.write(raw); process.exit(${exitCode}); }
const report = ${JSON.stringify({ s: staticReport, r: renderReport })};
process.stdout.write(JSON.stringify(render ? report.r : report.s));
process.exit(${exitCode});
`);
  return dir;
}
const rep = (findings, render = 'off') => ({ summary: { fails: findings.length, render }, findings });

test('the profile keeps the seven audited gates and drops the em-dash rule of gate 19', () => {
  assert.deepEqual(DEFAULT_GATES, ['40', '49a', '73', '75', '25', '34', '19']);
  const { kept, outsideProfile, excluded } = filterFindings([
    F('40', 'a field edge is under 3:1'), F('48', 'colour literal #fff'), F('54', 'eyebrow'), F('19', 'dash "—" in copy'), F('19', 'buzzword "unlock"'), F('49b', 'link wraps'),
  ]);
  assert.deepEqual(kept.map((f) => f.evidence), ['a field edge is under 3:1', 'buzzword "unlock"']);
  assert.equal(outsideProfile, 3);
  assert.equal(excluded, 1);
  assert.ok(DEFAULT_EXCLUDE.length >= 1);
});

test('a config can add a gate and exclude an element, e.g. an accordion trigger that is meant to wrap', () => {
  const list = [F('49a', 'control "Q?" wraps to 3 lines (button.flex.flex-1)'), F('49a', 'control "Buy" wraps to 2 lines (a.btn)'), F('49b', 'x')];
  const { kept } = filterFindings(list, { gates: ['49a', '49b'], exclude: [{ gate: '49a', evidence: 'button\\.flex\\.flex-1' }] });
  assert.deepEqual(kept.map((f) => f.evidence), ['control "Buy" wraps to 2 lines (a.btn)', 'x']);
  assert.throws(() => filterFindings(list, { exclude: [{ gate: '49a', evidence: '(' }] }), InfraError);
});

test('a finding keeps its identity when a measurement moves, and loses it when the element changes', () => {
  const a = findingKey({ gate: '40', file: 'http://127.0.0.1:4601/id/', evidence: "a field's edge is under 3:1: input 1.59:1" });
  const b = findingKey({ gate: '40', file: 'serve:/id/', evidence: "a field's edge is under 3:1: input 1.61:1" });
  const c = findingKey({ gate: '40', file: 'serve:/id/', evidence: "a field's edge is under 3:1: select 1.59:1" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  const { fresh, old } = applyBaseline([F('40', 'x 1:1', { file: 'a' }), F('40', 'y 1:1', { file: 'a' })], [findingKey(F('40', 'x 9:9', { file: 'a' }))]);
  assert.equal(fresh.length, 1);
  assert.equal(old.length, 1);
});

test('a root-relative or relative stylesheet is inlined; an external one, or one outside the site root, is left alone', () => {
  const root = tmp();
  write(path.join(root, 'styles.css'), 'body{overflow-x:clip}');
  write(path.join(root, 'id', 'local.css'), 'h1{color:var(--x)}');
  const outside = write(path.join(tmp(), 'secret.css'), 'x{}');
  const html = [
    '<link rel="stylesheet" href="/styles.css">',
    '<link rel="stylesheet" href="local.css?v=3">',
    '<link rel="stylesheet" href="https://fonts.example/f.css">',
    `<link rel="stylesheet" href="../../${path.relative(path.dirname(root), outside).replace(/\\/g, '/')}">`,
    '<link rel="icon" href="/favicon.svg">',
  ].join('\n');
  const out = inlineStylesheets(html, path.join(root, 'id'), root);
  assert.match(out, /<style>\nbody\{overflow-x:clip\}\n<\/style>/);
  assert.match(out, /<style>\nh1\{color:var\(--x\)\}\n<\/style>/);
  assert.match(out, /href="https:\/\/fonts\.example\/f\.css"/);
  assert.match(out, /rel="icon"/);
  assert.doesNotMatch(out, /x\{\}/, 'a file outside the site root is never read into the lint copy');
});

test('static input is source only: build output is refused, other file types are not copied, html gets its css inlined', () => {
  const repo = tmp();
  write(path.join(repo, 'src', 'a.css'), 'a{}');
  write(path.join(repo, 'src', 'logo.png'), 'png');
  write(path.join(repo, 'src', 'dist', 'bundle.css'), 'b{}');
  write(path.join(repo, 'src', 'page', 'index.html'), '<link rel="stylesheet" href="/a.css"><h1>x</h1>');
  write(path.join(repo, 'dist', 'built.html'), '<p>');
  const t = tmp();
  const copied = prepareStatic(['src'], { tmp: t, cwd: repo, siteRoot: 'src' });
  const rel = copied.map((p) => path.relative(t, p)).sort();
  assert.deepEqual(rel, [path.join('src', 'a.css'), path.join('src', 'page', 'index.html')]);
  assert.match(fs.readFileSync(path.join(t, 'src', 'page', 'index.html'), 'utf8'), /<style>\na\{\}\n<\/style>/);
  assert.throws(() => prepareStatic(['dist'], { tmp: tmp(), cwd: repo }), /build output, not source/);
  assert.throws(() => prepareStatic(['src/logo.png'], { tmp: tmp(), cwd: repo }), /no source files/);
  assert.throws(() => prepareStatic(['nope'], { tmp: tmp(), cwd: repo }), /does not exist/);
  assert.doesNotThrow(() => prepareStatic(['dist'], { tmp: tmp(), cwd: repo, allowBuildOutput: true }));
});

test('the loopback server serves a directory and never a path outside it', async () => {
  const root = tmp();
  write(path.join(root, 'site', 'index.html'), '<h1>home</h1>');
  write(path.join(root, 'site', 'id', 'index.html'), '<h1>id</h1>');
  write(path.join(root, 'site', 'a.css'), 'a{}');
  write(path.join(root, 'secret.txt'), 'nope');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'site', 'leak.txt'));
  const server = createStaticServer(path.join(root, 'site'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };
  try {
    assert.equal((await get('/')).body, '<h1>home</h1>');
    assert.equal((await get('/id/')).body, '<h1>id</h1>');
    assert.match((await get('/a.css')).type, /text\/css/);
    assert.equal((await get('/missing')).status, 404);
    assert.equal((await get('/leak.txt')).status, 404, 'a symlink out of the root is not followed');
    assert.equal((await get('/%2e%2e/secret.txt')).status, 404);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  } finally { await new Promise((ok) => server.close(ok)); }
});

test('puppeteer and Chrome are found where the render tier looks, and Playwright Chromium counts', () => {
  const root = tmp();
  assert.equal(findPuppeteer([root]), null);
  write(path.join(root, 'node_modules', 'puppeteer-core', 'package.json'), '{"name":"puppeteer-core","main":"index.js"}');
  write(path.join(root, 'node_modules', 'puppeteer-core', 'index.js'), 'module.exports={}');
  assert.equal(findPuppeteer([undefined, root])?.name, 'puppeteer-core');
  const pw = tmp();
  write(path.join(pw, 'chromium-1193', 'chrome-linux', 'chrome'));
  write(path.join(pw, 'chromium-1243', 'chrome-linux64', 'chrome'));
  write(path.join(pw, 'chromium_headless_shell-1243', 'chrome-linux', 'headless_shell'));
  assert.equal(playwrightChromium({ PLAYWRIGHT_BROWSERS_PATH: pw }, '/nonexistent'), path.join(pw, 'chromium-1243', 'chrome-linux64', 'chrome'));
  assert.equal(playwrightChromium({ PLAYWRIGHT_BROWSERS_PATH: path.join(pw, 'none') }, '/nonexistent'), null);
  const exe = write(path.join(tmp(), 'my-chrome'));
  assert.equal(findChrome({ CHROME_PATH: exe }), exe);
  assert.equal(findChrome({ CHROME_PATH: '/does/not/exist' }), null, 'a wrong CHROME_PATH is an error, not a fallback');
});

test('the Chrome launcher adds the container flags and limits egress to the hosts of the run', () => {
  const dir = tmp();
  const file = writeChromeWrapper(path.join(dir, 'w.sh'), "/opt/o'dd/chrome", { noSandbox: true, hosts: ['preview.example.com'], limitEgress: true });
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^#!\/bin\/sh\nexec '\/opt\/o'\\''dd\/chrome' /);
  assert.match(body, /'--no-sandbox' '--disable-dev-shm-usage'/);
  assert.match(body, /--host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE 127\.0\.0\.1, EXCLUDE localhost, EXCLUDE preview\.example\.com/);
  assert.equal(fs.statSync(file).mode & 0o111, 0o111);
  const open = fs.readFileSync(writeChromeWrapper(path.join(dir, 'o.sh'), '/c', { noSandbox: false, hosts: [], limitEgress: false }), 'utf8');
  assert.doesNotMatch(open, /no-sandbox|host-resolver/);
});

test('assertRendered fails closed on every way a render can silently not happen', () => {
  assert.doesNotThrow(() => assertRendered(rep([], 'ran')));
  assert.throws(() => assertRendered(rep([], 'not run: render tier not run: no puppeteer-core found')), /did not run/);
  assert.throws(() => assertRendered(rep([], 'off')), /did not run/);
  assert.throws(() => assertRendered(rep([{ gate: 'render', evidence: 'the page did not render (net::ERR_NAME_NOT_RESOLVED)', file: 'u' }], 'ran')), /did not render/);
  assert.doesNotThrow(() => assertRendered(rep([{ gate: 'render', evidence: 'a script threw on load: Failed to load Stripe.js', file: 'u' }], 'ran')), 'a throwing third-party script is a finding, not a dead page');
});

test('the tool path resolves from a checkout, a skill dir or a scripts dir; a wrong path is an infrastructure error', () => {
  const a = stubTool(tmp());
  assert.equal(resolveSloplint(a), path.join(a, 'scripts', 'sloplint.mjs'));
  assert.equal(resolveSloplint(path.join(a, 'scripts')), path.join(a, 'scripts', 'sloplint.mjs'));
  const b = stubTool(path.join(tmp(), 'skills', 'hallmark'));
  assert.ok(resolveSloplint(path.resolve(b, '..', '..')).endsWith(path.join('skills', 'hallmark', 'scripts', 'sloplint.mjs')));
  assert.throws(() => resolveSloplint(tmp()), InfraError);
});

test('static run: only the profile survives, findings are advisory, --fail-on any makes them fatal', async () => {
  const repo = tmp();
  write(path.join(repo, 'src', 'styles.css'), 'body{overflow-x:hidden}');
  const tool = stubTool(tmp(), { staticReport: rep([F('34', 'overflow-x: hidden on body', { file: 'src/styles.css' }), F('48', 'colour literal #fff', { file: 'src/styles.css' }), F('19', 'dash "—" in copy')]) });
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    const out = path.join(repo, 'out');
    assert.equal(await main(['--tool', tool, '--static', 'src', '--out', out], {}, quiet), 0);
    const json = JSON.parse(fs.readFileSync(path.join(out, 'findings.json'), 'utf8'));
    assert.deepEqual(json.findings.map((f) => f.gate), ['34']);
    assert.equal(json.outsideProfile, 1);
    assert.equal(json.excluded, 1);
    assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /advisory/);
    assert.equal(await main(['--tool', tool, '--static', 'src', '--out', out, '--fail-on', 'any'], {}, quiet), 1);
    assert.equal(await main(['--tool', tool, '--static', 'src', '--out', out, '--fail-on', 'none'], {}, quiet), 0);
  } finally { process.chdir(cwd); }
});

test('baseline: --write-baseline records the findings, then only a new one trips --fail-on new', async () => {
  const repo = tmp();
  write(path.join(repo, 'src', 'a.css'), 'a{}');
  const first = stubTool(tmp(), { staticReport: rep([F('34', 'overflow-x: hidden on body', { file: 'src/a.css' })]) });
  const second = stubTool(tmp(), { staticReport: rep([F('34', 'overflow-x: hidden on body', { file: 'src/a.css' }), F('19', 'buzzword "unlock"', { file: 'src/a.css' })]) });
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    const log = { log: () => {} };
    const base = path.join(repo, 'baseline.json');
    assert.equal(await main(['--tool', first, '--static', 'src', '--out', 'o1', '--baseline', base, '--write-baseline'], {}, log), 0);
    assert.equal(JSON.parse(fs.readFileSync(base, 'utf8')).keys.length, 1);
    assert.equal(await main(['--tool', first, '--static', 'src', '--out', 'o2', '--baseline', base, '--fail-on', 'new'], {}, log), 0);
    assert.equal(await main(['--tool', second, '--static', 'src', '--out', 'o3', '--baseline', base, '--fail-on', 'new'], {}, log), 1);
    const json = JSON.parse(fs.readFileSync(path.join(repo, 'o3', 'findings.json'), 'utf8'));
    assert.equal(json.new.length, 1);
    assert.match(json.new[0], /^19\|/);
  } finally { process.chdir(cwd); }
});

test('render run: puppeteer or Chrome missing is exit-2 material, and it says what is missing', async () => {
  const site = tmp();
  write(path.join(site, 'index.html'), '<h1>x</h1>');
  const tool = stubTool(tmp(), { renderReport: rep([], 'ran') });
  const out = path.join(tmp(), 'o');
  const deps = { globalRoot: () => null, cwd: tmp() };
  await assert.rejects(main(['--tool', tool, '--serve', site, '--out', out], { CHROME_PATH: '/x' }, quiet, deps), /puppeteer-core is not installed/);
  const pup = tmp();
  write(path.join(pup, 'node_modules', 'puppeteer-core', 'package.json'), '{"name":"puppeteer-core","main":"index.js"}');
  write(path.join(pup, 'node_modules', 'puppeteer-core', 'index.js'), 'module.exports={}');
  await assert.rejects(main(['--tool', tool, '--serve', site, '--out', out], { HALLMARK_PUPPETEER: pup, CHROME_PATH: '/does/not/exist' }, quiet, deps), /CHROME_PATH does not exist/);
  await assert.rejects(main(['--tool', tool, '--serve', site, '--out', out], { HALLMARK_PUPPETEER: pup, PLAYWRIGHT_BROWSERS_PATH: path.join(tmp(), 'none'), HOME: tmp() }, quiet, { ...deps, chromePaths: [] }), /no Chrome or Chromium found/);
});

test('render run: serves the build on loopback, hands the linter a wrapped Chrome, and reports server-relative locations', async () => {
  const site = tmp();
  write(path.join(site, 'index.html'), '<h1>x</h1>');
  const pup = tmp();
  write(path.join(pup, 'node_modules', 'puppeteer-core', 'package.json'), '{"name":"puppeteer-core","main":"index.js"}');
  write(path.join(pup, 'node_modules', 'puppeteer-core', 'index.js'), 'module.exports={}');
  const chrome = write(path.join(tmp(), 'chrome'), '#!/bin/sh\n');
  fs.chmodSync(chrome, 0o755);
  const tool = stubTool(tmp(), { renderReport: rep([F('40', "a field's edge is under 3:1: input 1.59:1", { file: 'http://127.0.0.1:1/' }), F('44c', 'hero runs past the fold', { file: 'http://127.0.0.1:1/' })], 'ran') });
  const out = path.join(tmp(), 'o');
  const code = await main(['--tool', tool, '--serve', site, '--route', '/', '--route', '/id/', '--out', out], { HALLMARK_PUPPETEER: pup, CHROME_PATH: chrome, GITHUB_ACTIONS: 'true' }, quiet, { globalRoot: () => null });
  assert.equal(code, 0);
  const called = JSON.parse(fs.readFileSync(path.join(out, 'called-render.json'), 'utf8'));
  assert.deepEqual(called.args.filter((a) => a === '--url').length, 2);
  assert.match(called.args.find((a) => a.startsWith('http://127.0.0.1:')), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(called.chrome, path.join(out, 'chrome-wrap.sh'));
  assert.equal(called.pup, pup);
  const wrapper = fs.readFileSync(path.join(out, 'chrome-wrap.sh'), 'utf8');
  assert.match(wrapper, /--no-sandbox/, 'GITHUB_ACTIONS selects the container flags');
  assert.match(wrapper, /host-resolver-rules=MAP \* ~NOTFOUND/);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'findings.json'), 'utf8'));
  assert.equal(json.findings.length, 1);
  assert.equal(json.outsideProfile, 1);
});

test('render run: a stub that did not render, printed nothing, or crashed fails the run (exit 2 material)', async () => {
  const site = tmp();
  write(path.join(site, 'index.html'), '<h1>x</h1>');
  const pup = tmp();
  write(path.join(pup, 'node_modules', 'puppeteer-core', 'package.json'), '{"name":"puppeteer-core","main":"index.js"}');
  write(path.join(pup, 'node_modules', 'puppeteer-core', 'index.js'), 'module.exports={}');
  const chrome = write(path.join(tmp(), 'chrome'), '#!/bin/sh\n');
  const env = { HALLMARK_PUPPETEER: pup, CHROME_PATH: chrome };
  const run = (tool) => main(['--tool', tool, '--serve', site, '--out', path.join(tmp(), 'o')], env, quiet, { globalRoot: () => null });
  // upstream's silent pass: findings clean, render tier "not run", exit 0
  await assert.rejects(run(stubTool(tmp(), { renderReport: rep([], 'not run: no puppeteer-core found locally, globally or via HALLMARK_PUPPETEER') })), /render tier did not run/);
  await assert.rejects(run(stubTool(tmp(), { renderReport: rep([{ gate: 'render', evidence: 'the page did not render (net::ERR_FAILED)', file: 'http://127.0.0.1:1/' }], 'ran') })), /did not render/);
  await assert.rejects(run(stubTool(tmp(), { raw: 'Error: boom', exitCode: 0 })), /no usable JSON/);
  await assert.rejects(run(stubTool(tmp(), { raw: '', exitCode: 2 })), /sloplint exited 2/);
});

test('usage errors are infrastructure errors, never a quiet pass', async () => {
  await assert.rejects(main([], {}, quiet), /--tool/);
  await assert.rejects(main(['--tool', stubTool(tmp())], {}, quiet), /nothing to check/);
  await assert.rejects(main(['--tool', stubTool(tmp()), '--static', 'x', '--fail-on', 'sometimes'], {}, quiet), /--fail-on/);
  await assert.rejects(main(['--tool', stubTool(tmp()), '--bogus'], {}, quiet), /unknown option/);
});

test('the summary names the profile, marks new against known, and says unrendered runs fail', () => {
  const a = F('40', 'x'); const b = F('25', 'y');
  const md = renderSummary({ findings: [a, b], fresh: [a], old: [b], outsideProfile: 4, excluded: 1, mode: ['static source'], gates: DEFAULT_GATES, tool: null, baselineUsed: true });
  assert.match(md, /advisory/);
  assert.match(md, /a run that could not render does/);
  assert.match(md, /\| new \| 40 FAIL/);
  assert.match(md, /\| known \| 25 FAIL/);
  assert.match(renderSummary({ findings: [], fresh: [], old: [], outsideProfile: 2, excluded: 0, mode: ['static source'], gates: DEFAULT_GATES, tool: null, baselineUsed: false }), /No findings in the profile/);
});

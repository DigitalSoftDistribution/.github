#!/usr/bin/env node
// hallmark-profile.mjs -- the advisory design check around Hallmark's sloplint (Nutlope/hallmark, MIT).
//
// Decision 2026-10-26 (coordinator, on the Docs audit "Hallmark audit"): adopt partly. sloplint has ~85 gates written for
// Hallmark's own taste; most clash with our brand contracts. This wrapper keeps the seven that found real defects on
// Orviel, Lizensa and Distivo and drops the rest by gate id:
//   40  form-field edge under 3:1 against its surround      49a control wraps to a second line at 320-1920 px
//   73  text painted under another element                  75  text under 11 px
//   25  prose line over 75 characters                       34  overflow-x on html and body
//   19  copy tells (buzzword, cliche, placeholder name; not the em-dash rule, which is English style)
//
// FAILS CLOSED. Upstream prints "render tier not run" and exits 0 when puppeteer or Chrome is missing, and reports a page
// that never rendered as one more finding. Here either case is exit 2: an unrendered page is never a pass. Findings alone
// never fail the run (advisory) unless --fail-on says so.
//
// Static input is SOURCE (css, html, jsx, tsx, vue, svelte, astro), never build output: a path under dist/ build/ .next/
// out/ is refused. Stylesheets linked from an html file, root-relative ("/styles.css") or relative, are inlined into a
// temporary copy first, because upstream pairs a page with the css next to it and gives false FAILs on nested pages.
// Render input is a served build directory (--serve, a loopback server in this process) or deployed URLs (--url). Chrome
// reaches only 127.0.0.1 plus the hosts you pass, so analytics and chat widgets never load or fire.
//
//   node hallmark-profile.mjs --tool <hallmark checkout or skills/hallmark/scripts dir>
//        [--static <src path>]...            lint source files
//        [--site-root <dir>]                 root that "/x.css" links resolve against (default: the static dir)
//        [--serve <built dir> [--route /]...] render a built site on loopback
//        [--url <https://preview>]...        render deployed pages
//        [--allow-host <host>]...  [--no-egress-limit]
//        [--genre g] [--scope page|component|app]
//        [--config .hallmark-profile.json] [--baseline file] [--write-baseline]
//        [--out dir] [--json file] [--fail-on none|new|any]
// Exit: 0 ran (findings are advisory) / 1 findings and --fail-on said so / 2 could not run or could not render.
//
// Config (.hallmark-profile.json): { "gates": [...], "exclude": [{ "gate": "49a", "evidence": "regex", "file": "regex" }],
//   "static": [...], "siteRoot": "...", "serve": "...", "routes": [...], "genre": "...", "scope": "...", "baseline": "..." }
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_GATES = ['40', '49a', '73', '75', '25', '34', '19'];
// Gate 19 also reports the em dash in copy: an English style rule that flags our German pages. Not a copy tell.
export const DEFAULT_EXCLUDE = [{ gate: '19', evidence: '^dash\\b' }];
export const BUILD_DIRS = new Set(['dist', 'build', 'out', '.next', '_next', '.output', '.nuxt', '.svelte-kit', 'coverage', 'node_modules']);
const SOURCE_EXT = new Set(['.html', '.css', '.jsx', '.tsx', '.vue', '.svelte', '.astro']);
const EXIT_INFRA = 2;

export class InfraError extends Error {}
const infra = (m) => { throw new InfraError(m); };

// ---------------------------------------------------------------------------------------------------------------- filter
const rx = (s) => { try { return new RegExp(s, 'i'); } catch { return infra(`bad regular expression in the profile config: ${s}`); } };

/** Keep the profile's gates, drop the excluded ones; count what was left out. */
export function filterFindings(findings, { gates = DEFAULT_GATES, exclude = DEFAULT_EXCLUDE } = {}) {
  const want = new Set(gates.map(String));
  const ex = exclude.map((e) => ({ gate: String(e.gate), evidence: e.evidence ? rx(e.evidence) : null, file: e.file ? rx(e.file) : null }));
  const kept = [];
  let outsideProfile = 0;
  let excluded = 0;
  for (const f of findings) {
    if (!want.has(String(f.gate))) { outsideProfile += 1; continue; }
    if (ex.some((e) => e.gate === String(f.gate) && (!e.evidence || e.evidence.test(String(f.evidence ?? ''))) && (!e.file || e.file.test(String(f.file ?? ''))))) { excluded += 1; continue; }
    kept.push(f);
  }
  return { kept, outsideProfile, excluded };
}

/** A stable identity for the baseline: measurements are masked, so 1.59:1 becoming 1.60:1 is the same finding. */
export function findingKey(f) {
  const where = String(f.file ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/^serve:/, '') || '/';
  const what = String(f.evidence ?? '').replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 200);
  return `${f.gate}|${where}|${what}`;
}

export function applyBaseline(findings, baselineKeys) {
  const known = new Set(baselineKeys ?? []);
  const fresh = [];
  const old = [];
  for (const f of findings) (known.has(findingKey(f)) ? old : fresh).push(f);
  return { fresh, old };
}

// ----------------------------------------------------------------------------------------------------------- prerequisites
const CHROME_PATHS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];

/** puppeteer-core or puppeteer, searched where upstream's render tier searches (so what we check is what it will find). */
export function findPuppeteer(roots) {
  for (const root of roots.filter(Boolean)) {
    for (const name of ['puppeteer-core', 'puppeteer']) {
      try { return { name, root, path: createRequire(join(root, 'noop.js')).resolve(name) }; } catch { /* next */ }
    }
  }
  return null;
}

/** Playwright's own Chromium (the coolify-ci image bakes it in under PLAYWRIGHT_BROWSERS_PATH). Highest revision wins. */
export function playwrightChromium(env = process.env, home = homedir()) {
  const base = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? env.PLAYWRIGHT_BROWSERS_PATH : join(home, '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { return null; }
  for (const d of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(base, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function findChrome(env = process.env, home = homedir(), candidates = CHROME_PATHS) {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  return candidates.find((p) => existsSync(p)) ?? playwrightChromium(env, home);
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A launcher script so Chrome starts with the flags sloplint cannot pass, and reaches only the hosts the run needs. */
export function writeChromeWrapper(file, chrome, { noSandbox, hosts, limitEgress }) {
  const flags = [];
  if (noSandbox) flags.push('--no-sandbox', '--disable-dev-shm-usage');
  if (limitEgress) flags.push(`--host-resolver-rules=${['MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost', ...hosts.map((h) => `EXCLUDE ${h}`)].join(', ')}`);
  writeFileSync(file, `#!/bin/sh\nexec ${sq(chrome)} ${flags.map(sq).join(' ')} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

export function resolveSloplint(tool) {
  for (const c of [tool, join(tool, 'scripts'), join(tool, 'skills', 'hallmark', 'scripts')]) {
    if (existsSync(join(c, 'sloplint.mjs'))) return join(c, 'sloplint.mjs');
  }
  return infra(`no sloplint.mjs under --tool ${tool}`);
}

// ------------------------------------------------------------------------------------------------------------ static input
function walkSource(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || BUILD_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkSource(p, out);
    else if (SOURCE_EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

const underBuildDir = (p) => resolve(p).split(sep).some((seg) => BUILD_DIRS.has(seg) && seg !== 'node_modules');

/** Inline every local stylesheet an html file links, so upstream sees the css that page really uses. */
export function inlineStylesheets(html, htmlDir, siteRoot) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) return tag;
    const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = (m && (m[1] ?? m[2] ?? m[3])) || '';
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return tag;
    const clean = href.split(/[?#]/)[0];
    const target = clean.startsWith('/') ? join(siteRoot, clean) : resolve(htmlDir, clean);
    const real = existsSync(target) ? realpathSync(target) : null;
    const rootReal = existsSync(siteRoot) ? realpathSync(siteRoot) : siteRoot;
    if (!real || (real !== rootReal && !real.startsWith(rootReal + sep))) return tag;
    return `<style>\n${readFileSync(real, 'utf8')}\n</style>`;
  });
}

/** Copy the source files to a temp tree (paths kept relative to cwd, so findings read like repo paths). */
export function prepareStatic(paths, { tmp, cwd = process.cwd(), siteRoot, allowBuildOutput = false }) {
  const copied = [];
  for (const input of paths) {
    const abs = resolve(cwd, input);
    if (!existsSync(abs)) infra(`static path does not exist: ${input}`);
    if (!allowBuildOutput && underBuildDir(abs)) infra(`static path is build output, not source: ${input} (lint the source files; render the build with --serve)`);
    const st = statSync(abs);
    const files = st.isDirectory() ? walkSource(abs) : SOURCE_EXT.has(extname(abs).toLowerCase()) ? [abs] : [];
    const root = siteRoot ? resolve(cwd, siteRoot) : st.isDirectory() ? abs : dirname(abs);
    for (const f of files) {
      const rel = relative(cwd, f);
      const dest = join(tmp, rel.startsWith('..') || isAbsolute(rel) ? join('_outside', f.replace(/[^\w.-]+/g, '_')) : rel);
      mkdirSync(dirname(dest), { recursive: true });
      if (extname(f).toLowerCase() === '.html') writeFileSync(dest, inlineStylesheets(readFileSync(f, 'utf8'), dirname(f), root));
      else copyFileSync(f, dest);
      copied.push(dest);
    }
  }
  if (copied.length === 0) infra(`no source files (css, html, jsx, tsx, vue, svelte, astro) under: ${paths.join(', ')}`);
  return copied;
}

// ------------------------------------------------------------------------------------------------------------- loopback
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };

/** GET/HEAD static server for a built directory; a path can never leave it. */
export function createStaticServer(root) {
  const base = realpathSync(root);
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    try {
      let file = join(base, rel);
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const real = realpathSync(file);
      if (real !== base && !real.startsWith(base + sep)) throw new Error('outside');
      const body = readFileSync(real);
      res.writeHead(200, { 'content-type': TYPES[extname(real).toLowerCase()] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
}

// ---------------------------------------------------------------------------------------------------------------- run
function runSloplint(sloplint, args, { cwd, env }) {
  const r = spawnSync(process.execPath, [sloplint, ...args, '--json'], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  if (r.error) infra(`could not run sloplint: ${r.error.message}`);
  if (r.status === null) infra('sloplint was killed (timeout or signal)');
  if (r.status > 1) infra(`sloplint exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  let report;
  try { report = JSON.parse(r.stdout); } catch { return infra(`sloplint printed no JSON (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`); }
  if (!report || !Array.isArray(report.findings) || !report.summary) infra('sloplint JSON has no summary and findings');
  return report;
}

/** The render tier ran, or this run is a failure. */
export function assertRendered(report) {
  const state = String(report.summary.render ?? '');
  if (state !== 'ran') infra(`the render tier did not run (${state || 'no state'}): an unrendered page is never a pass`);
  const dead = report.findings.find((f) => String(f.gate) === 'render' && /did not render|could not (?:load|render)/i.test(String(f.evidence ?? '')));
  if (dead) infra(`a page did not render: ${dead.file}: ${dead.evidence}`);
}

const parseArgs = (argv) => {
  const o = { static: [], url: [], route: [], allowHost: [], serve: null, tool: null, siteRoot: null, genre: null, scope: null, config: null, baseline: null, writeBaseline: false, out: 'hallmark-out', json: null, failOn: 'none', noEgressLimit: false, allowBuildOutput: false };
  const need = (i, flag) => { if (i + 1 >= argv.length) infra(`${flag} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--static') o.static.push(need(i++, a));
    else if (a === '--url') o.url.push(need(i++, a));
    else if (a === '--route') o.route.push(need(i++, a));
    else if (a === '--allow-host') o.allowHost.push(need(i++, a));
    else if (a === '--serve') o.serve = need(i++, a);
    else if (a === '--tool') o.tool = need(i++, a);
    else if (a === '--site-root') o.siteRoot = need(i++, a);
    else if (a === '--genre') o.genre = need(i++, a);
    else if (a === '--scope') o.scope = need(i++, a);
    else if (a === '--config') o.config = need(i++, a);
    else if (a === '--baseline') o.baseline = need(i++, a);
    else if (a === '--out') o.out = need(i++, a);
    else if (a === '--json') o.json = need(i++, a);
    else if (a === '--fail-on') o.failOn = need(i++, a);
    else if (a === '--write-baseline') o.writeBaseline = true;
    else if (a === '--no-egress-limit') o.noEgressLimit = true;
    else if (a === '--allow-build-output') o.allowBuildOutput = true;
    else infra(`unknown option ${a}`);
  }
  if (!['none', 'new', 'any'].includes(o.failOn)) infra('--fail-on takes none, new or any');
  return o;
};

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderSummary({ findings, fresh, old, outsideProfile, excluded, mode, gates, tool, baselineUsed }) {
  const lines = [];
  lines.push('### Hallmark design check (advisory)');
  lines.push('');
  lines.push(`Ran: ${mode.join(' + ')}. Profile: gates ${gates.join(', ')}. ${tool ? `Tool: ${tool}. ` : ''}Findings do not fail this job; a run that could not render does.`);
  lines.push('');
  if (findings.length === 0) lines.push(`No findings in the profile (${outsideProfile} outside the profile, ${excluded} excluded).`);
  else {
    lines.push(`${findings.length} finding(s)${baselineUsed ? `: ${fresh.length} new, ${old.length} already in the baseline` : ''}. ${outsideProfile} other finding(s) are outside the profile and ignored; ${excluded} excluded by the config.`);
    lines.push('');
    lines.push('| | gate | where | finding | fix |');
    lines.push('|---|---|---|---|---|');
    const mark = new Set(fresh);
    for (const f of findings.slice(0, 200)) lines.push(`| ${baselineUsed ? (mark.has(f) ? 'new' : 'known') : ''} | ${cell(f.gate)} ${cell(f.grade)} | ${cell(f.file)}${f.line > 1 ? `:${f.line}` : ''} | ${cell(f.evidence)} | ${cell(f.fix)} |`);
    if (findings.length > 200) lines.push(`| | | | ... ${findings.length - 200} more in the JSON | |`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function main(argv, env = process.env, log = console, deps = {}) {
  const cli = parseArgs(argv);
  const cfgFile = cli.config ?? (existsSync('.hallmark-profile.json') ? '.hallmark-profile.json' : null);
  let cfg = {};
  if (cfgFile) { try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8')); } catch (e) { infra(`cannot read ${cfgFile}: ${e.message}`); } }
  const o = {
    ...cli,
    static: cli.static.length ? cli.static : cfg.static ?? [],
    serve: cli.serve ?? cfg.serve ?? null,
    route: cli.route.length ? cli.route : cfg.routes ?? ['/'],
    siteRoot: cli.siteRoot ?? cfg.siteRoot ?? null,
    genre: cli.genre ?? cfg.genre ?? null,
    scope: cli.scope ?? cfg.scope ?? null,
    baseline: cli.baseline ?? cfg.baseline ?? null,
  };
  const gates = (cfg.gates ?? DEFAULT_GATES).map(String);
  const exclude = [...DEFAULT_EXCLUDE, ...(cfg.exclude ?? [])];
  if (!o.tool) infra('--tool <hallmark checkout or its scripts dir> is required');
  if (o.static.length === 0 && !o.serve && o.url.length === 0) infra('nothing to check: pass --static, --serve or --url');
  const sloplint = resolveSloplint(resolve(o.tool));
  const wantRender = Boolean(o.serve) || o.url.length > 0;
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'hallmark-profile-'));
  const mode = [];
  const all = [];
  let server = null;
  try {
    const runEnv = { ...env };
    const extra = [];
    if (o.genre) extra.push('--genre', o.genre);
    if (o.scope) extra.push('--scope', o.scope);

    if (o.static.length) {
      mode.push('static source');
      const copied = prepareStatic(o.static, { tmp: join(tmp, 's'), siteRoot: o.siteRoot, allowBuildOutput: o.allowBuildOutput });
      const staticRoot = join(tmp, 's');
      const rep = runSloplint(sloplint, ['.', ...extra], { cwd: staticRoot, env: runEnv });
      for (const f of rep.findings) all.push({ ...f, file: String(f.file ?? '').startsWith(staticRoot) ? relative(staticRoot, f.file) : f.file });
      log.log(`static: ${copied.length} source file(s), ${rep.findings.length} raw finding(s)`);
    }

    if (wantRender) {
      const hosts = new Set(o.allowHost);
      for (const u of o.url) { try { hosts.add(new URL(u).hostname); } catch { infra(`bad --url ${u}`); } }
      const globalRoot = deps.globalRoot ?? (() => { try { const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }); return g.status === 0 ? dirname(g.stdout.trim()) : null; } catch { return null; } });
      const pp = findPuppeteer([env.HALLMARK_PUPPETEER, deps.cwd ?? process.cwd(), dirname(sloplint), globalRoot()]);
      if (!pp) infra('puppeteer-core is not installed (local, global or HALLMARK_PUPPETEER): the render tier cannot run');
      const chrome = findChrome(env, env.HOME || homedir(), deps.chromePaths);
      if (!chrome) infra(env.CHROME_PATH ? `CHROME_PATH does not exist: ${env.CHROME_PATH}` : 'no Chrome or Chromium found (set CHROME_PATH, or install Playwright Chromium): the render tier cannot run');
      runEnv.HALLMARK_PUPPETEER = pp.root;
      const ci = env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
      runEnv.CHROME_PATH = writeChromeWrapper(join(out, 'chrome-wrap.sh'), chrome, { noSandbox: env.HALLMARK_CHROME_NO_SANDBOX ? env.HALLMARK_CHROME_NO_SANDBOX !== '0' : ci, hosts: [...hosts], limitEgress: !o.noEgressLimit });
      const urls = [...o.url];
      let origin = null;
      if (o.serve) {
        if (!existsSync(o.serve) || !statSync(o.serve).isDirectory()) infra(`--serve is not a directory: ${o.serve}`);
        server = createStaticServer(o.serve);
        await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
        origin = `http://127.0.0.1:${server.address().port}`;
        for (const r of o.route) urls.push(`${origin}${r.startsWith('/') ? r : `/${r}`}`);
      }
      mode.push(o.serve ? `render of ${o.serve}` : 'render of deployed pages');
      const args = urls.flatMap((u) => ['--url', u]);
      // sloplint is async (puppeteer); the loopback server lives in this process, so run it without blocking the loop.
      const rep = await new Promise((ok, bad) => {
        const child = spawn(process.execPath, [sloplint, ...args, ...extra, '--json'], { cwd: out, env: runEnv });
        let so = ''; let se = '';
        child.stdout.on('data', (d) => { so += d; });
        child.stderr.on('data', (d) => { se += d; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); bad(new InfraError('sloplint --render timed out after 15 minutes')); }, 15 * 60 * 1000);
        child.on('error', (e) => { clearTimeout(timer); bad(new InfraError(`could not run sloplint: ${e.message}`)); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === null || code > 1) return bad(new InfraError(`sloplint exited ${code}: ${(se || so).trim().slice(0, 400)}`));
          try { const r = JSON.parse(so); if (!r || !Array.isArray(r.findings) || !r.summary) throw new Error('shape'); ok(r); } catch { bad(new InfraError(`sloplint printed no usable JSON (exit ${code}): ${(se || so).trim().slice(0, 400)}`)); }
        });
      });
      assertRendered(rep);
      for (const f of rep.findings) all.push({ ...f, file: origin && String(f.file ?? '').startsWith(origin) ? `serve:${String(f.file).slice(origin.length) || '/'}` : f.file });
      log.log(`render: ${urls.length} page(s), ${rep.findings.length} raw finding(s)`);
    }

    const { kept, outsideProfile, excluded } = filterFindings(all, { gates, exclude });
    let baselineKeys = null;
    if (o.baseline && existsSync(o.baseline) && !o.writeBaseline) { try { baselineKeys = JSON.parse(readFileSync(o.baseline, 'utf8')).keys ?? []; } catch (e) { infra(`cannot read baseline ${o.baseline}: ${e.message}`); } }
    const { fresh, old } = baselineKeys ? applyBaseline(kept, baselineKeys) : { fresh: kept, old: [] };
    if (o.writeBaseline) {
      if (!o.baseline) infra('--write-baseline needs --baseline <file>');
      writeFileSync(o.baseline, JSON.stringify({ v: 1, gates, keys: [...new Set(kept.map(findingKey))].sort() }, null, 2) + '\n');
      log.log(`baseline written: ${o.baseline} (${new Set(kept.map(findingKey)).size} keys)`);
    }
    const summary = renderSummary({ findings: kept, fresh, old, outsideProfile, excluded, mode, gates, tool: null, baselineUsed: Boolean(baselineKeys) });
    writeFileSync(join(out, 'summary.md'), summary);
    writeFileSync(o.json ? resolve(o.json) : join(out, 'findings.json'), JSON.stringify({ v: 1, ran: mode, gates, outsideProfile, excluded, findings: kept, new: fresh.map(findingKey), known: old.map(findingKey) }, null, 2) + '\n');
    if (env.GITHUB_STEP_SUMMARY) { try { writeFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n', { flag: 'a' }); } catch { /* summary is a courtesy */ } }
    if (env.GITHUB_ACTIONS === 'true') {
      for (const f of fresh.slice(0, 50)) {
        const staticFile = f.file && !/^(?:serve:|https?:)/.test(f.file);
        log.log(`::warning ${staticFile ? `file=${esc(f.file)},line=${Number(f.line) || 1},` : ''}title=${esc(`hallmark ${f.gate}${staticFile ? '' : ` ${f.file}`}`)}::${esc(`${f.evidence} | fix: ${f.fix ?? ''}`)}`);
      }
    }
    log.log(summary);
    if (o.failOn === 'any' && kept.length > 0) return 1;
    if (o.failOn === 'new' && fresh.length > 0) return 1;
    return 0;
  } finally {
    if (server) await new Promise((ok) => server.close(ok));
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      const msg = e instanceof InfraError ? e.message : `unexpected: ${e?.stack ?? e}`;
      console.error(`hallmark-profile: ${msg}`);
      if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=hallmark design check could not run::${esc(msg)}`);
      process.exit(EXIT_INFRA);
    },
  );
}

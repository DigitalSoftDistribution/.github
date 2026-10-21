// PR comment + job summary for the real-devices-shoot workflow (G-218). Dependency-free, node >= 20.
//
// Reads the CLI's `--json` output (RD_RESULT), its exit code (RD_EXIT) and stderr (RD_ERR), and the shoot's
// manifest.json, and writes ONE comment per (PR, app) that is edited in place, found by a hidden marker.
// Advisory: this script only reports; the workflow decides the job verdict.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const TOP = 10;
const MAX_BODY = 60000;
export const marker = (key) => `<!-- real-devices-shoot:${String(key || 'urls')} -->`;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** What happened, from the exit code and the parsed output. verdict: ok | warn | fail. */
export function classify(exit, result) {
  const shot = Boolean(result && result.gallery_url);
  if (exit === 0 && shot) return { kind: 'ok', verdict: 'ok' };
  if (exit === 3 || (result && result.refused)) return { kind: 'refused', verdict: 'warn' };
  if (exit === 1 && shot) return { kind: 'partial', verdict: 'warn' };
  return { kind: 'broken', verdict: 'fail' };
}

const pct = (r) => (typeof r === 'number' ? `${(r * 100).toFixed(2)}%` : 'n/a');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 120);

export function topChanged(manifest, n = TOP) {
  const routes = new Map((manifest?.routes || []).map((r) => [r.id, r.route]));
  return (manifest?.shots || [])
    .filter((s) => s.ok && s.diff && s.diff.changed)
    .sort((a, b) => (b.diff.ratio ?? 0) - (a.diff.ratio ?? 0))
    .slice(0, n)
    .map((s) => ({ route: routes.get(s.route_id) || s.route_id, device: s.device, theme: s.theme, ratio: s.diff.ratio }));
}

export function failedShots(manifest, n = TOP) {
  const routes = new Map((manifest?.routes || []).map((r) => [r.id, r.route]));
  const bad = (manifest?.shots || []).filter((s) => !s.ok);
  return { total: bad.length, rows: bad.slice(0, n).map((s) => ({ route: routes.get(s.route_id) || s.route_id, device: s.device, theme: s.theme, error: s.error || 'no screenshot' })) };
}

export function buildComment({ key, app, kind, result, manifest, errText, exit, artifactUrl, runUrl, baseline }) {
  const lines = [marker(key), `### Real-device shots: ${cell(app || key)}`, ''];
  if (kind === 'refused') {
    lines.push(`**Not shot (refused, advisory).** ${cell(result?.error || errText || 'the engine refused the shoot')}`);
    if (result?.estimate) lines.push('', `The shoot needed ${result.estimate.sessions} sessions / ${result.estimate.minutes} device-minutes.`);
  } else if (kind === 'broken') {
    lines.push(`**The shoot run broke** (exit ${exit}).${errText ? ` ${cell(errText)}` : ''} See the run log.`);
  } else {
    const c = result.counts || {};
    const d = result.diffs || {};
    lines.push(`${kind === 'partial' ? '**Some sessions failed.** ' : ''}${c.routes ?? '?'} routes, ${c.shots ?? '?'} shots: ${c.ok ?? '?'} ok, ${c.failed ?? 0} failed${c.flows ? `, ${c.flows} journeys` : ''}.`);
    lines.push('', d.compared_to
      ? `Compared with the default branch shoot \`${d.compared_to}\`: **${d.changed} changed**, ${d.new} new, ${d.removed} gone, ${d.same} same.`
      : `No default branch baseline to compare with${baseline ? '' : ' yet (the first run on the default branch creates it)'}.`);
    const top = topChanged(manifest);
    if (top.length) {
      lines.push('', `Top ${top.length} changed shots`, '', '| route | device | theme | changed pixels |', '|---|---|---|---|');
      for (const t of top) lines.push(`| \`${cell(t.route)}\` | ${cell(t.device)} | ${cell(t.theme)} | ${pct(t.ratio)} |`);
    }
    const bad = failedShots(manifest);
    if (bad.total) {
      lines.push('', `Failed shots (${bad.total}${bad.total > bad.rows.length ? `, first ${bad.rows.length}` : ''})`, '', '| route | device | theme | error |', '|---|---|---|---|');
      for (const b of bad.rows) lines.push(`| \`${cell(b.route)}\` | ${cell(b.device)} | ${cell(b.theme)} | ${cell(b.error)} |`);
    }
    for (const s of (result.sessions || []).filter((x) => !x.ok)) lines.push('', `Session ${cell(s.device)} ${cell(s.theme)} failed: ${cell(s.error || 'no reason given')}`);
    for (const e of result.errors || []) lines.push('', `Note: ${cell(e)}`);
  }
  const links = [];
  if (artifactUrl) links.push(`[Gallery and screenshots (artifact, open index.html)](${artifactUrl})`);
  if (runUrl) links.push(`[Run](${runUrl})`);
  if (links.length) lines.push('', links.join(' · '));
  lines.push('', '_Advisory: a diff never fails the check. Updated in place on every push._');
  const body = lines.join('\n');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 40)}\n\n_(truncated)_` : body;
}

const gh = (args, input, env = process.env) => execFileSync(env.GH_BIN || 'gh', args, { encoding: 'utf8', input, env, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

/** Create the comment, or edit the one that carries the marker. -> 'created' | 'updated' */
export function postComment({ repo, pr, key, body, env = process.env }) {
  const all = JSON.parse(`[${gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[] | {id, body}'], undefined, env).trim().split('\n').filter(Boolean).join(',')}]`);
  const mine = all.filter((c) => typeof c.body === 'string' && c.body.startsWith(marker(key))).pop();
  const payload = JSON.stringify({ body });
  if (mine) {
    gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '--input', '-'], payload, env);
    return 'updated';
  }
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], payload, env);
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const e = process.env;
  const exit = Number(e.RD_EXIT ?? 1);
  const result = e.RD_RESULT ? readJson(e.RD_RESULT) : null;
  const errText = e.RD_ERR && fs.existsSync(e.RD_ERR) ? fs.readFileSync(e.RD_ERR, 'utf8').trim().split('\n').slice(-3).join(' ') : '';
  const { kind, verdict } = classify(exit, result);
  const dir = result?.files ? String(result.files) : '';
  const manifest = dir ? readJson(path.join(dir, 'manifest.json')) : null;
  const body = buildComment({ key: e.RD_APP_KEY, app: e.RD_APP_KEY, kind, result, manifest, errText, exit, artifactUrl: e.RD_ARTIFACT_URL, runUrl: e.RD_RUN_URL, baseline: e.RD_BASELINE });
  if (e.GITHUB_STEP_SUMMARY) fs.appendFileSync(e.GITHUB_STEP_SUMMARY, `${body.replace(/^<!--.*-->\n/, '')}\n`);
  const text = cell(result?.error || errText || `exit ${exit}`);
  if (kind === 'refused') console.log(`::warning title=real-devices-shoot refused::${text}`);
  else if (kind === 'partial') console.log(`::warning title=real-devices-shoot::some sessions failed: ${text}`);
  else if (kind === 'broken') console.log(`::error title=real-devices-shoot::the shoot run broke: ${text}`);
  if (e.RD_PR && e.RD_REPO) {
    try { console.log(`PR comment ${postComment({ repo: e.RD_REPO, pr: e.RD_PR, key: e.RD_APP_KEY, body })}`); } catch (err) {
      console.log(`::warning title=real-devices-shoot::could not post the PR comment: ${String(err.stderr || err.message).slice(0, 200)}`);
    }
  }
  if (e.GITHUB_OUTPUT) fs.appendFileSync(e.GITHUB_OUTPUT, `verdict=${verdict}\nkind=${kind}\n`);
}

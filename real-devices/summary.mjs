// Renders real-devices-results.json as the job summary (Markdown on stdout).
//   node summary.mjs out/real-devices-results.json >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';

const file = process.argv[2];
let r;
try {
  r = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.log(`### real devices\n\nNo results file (${String(err?.message || err).slice(0, 160)}). The run ended before Playwright wrote one; see the log.`);
  process.exit(0);
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const lines = [];
lines.push(`### real devices: ${esc(r.project || r.repo)} (${r.mode})`);
lines.push('');
lines.push(`Target ${esc(r.base_url)} · status **${esc(r.status)}** · ${esc(r.started_at)} to ${esc(r.finished_at)}`);
lines.push('');
lines.push('| Device | Passed | Failed | Skipped | Time | Sessions |');
lines.push('|---|---:|---:|---:|---:|---|');
for (const d of r.devices || []) {
  const sessions = (d.session_urls || []).map((u, i) => `[${i + 1}](${u})`).join(' ') || 'none';
  lines.push(`| ${esc(d.label || d.device)} | ${d.passed} | ${d.failed} | ${d.skipped} | ${d.duration_s} s | ${sessions} |`);
}
const metrics = (r.devices || []).flatMap((d) => (d.metrics || []).map((m) => ({ device: d.device, ...m })));
if (metrics.length) {
  lines.push('', '**Metrics** (reported, never a failure)', '', '| Device | Test | Metric | Value |', '|---|---|---|---|');
  for (const m of metrics) {
    const value = m.value === null ? `unknown (${esc(m.note || 'no data')})` : esc(JSON.stringify(m.value));
    const hosts = m.by_host && Object.keys(m.by_host).length ? ` ${esc(JSON.stringify(m.by_host))}` : '';
    lines.push(`| ${esc(m.device)} | ${esc(m.test)} | ${esc(m.name)}${m.source ? ` (${esc(m.source)})` : ''} | ${value}${hosts} |`);
  }
}
const failures = (r.devices || []).flatMap((d) => (d.tests || []).filter((t) => t.status === 'failed').map((t) => ({ device: d.device, ...t })));
if (failures.length) {
  lines.push('', '**Failures**', '');
  for (const f of failures) lines.push(`- ${esc(f.device)} · ${esc(f.title)}: ${esc(f.error || 'failed')}${f.session_url ? ` ([session](${f.session_url}))` : ''}`);
}
lines.push('', 'Artifacts: `real-devices-results` (this JSON, read by the CC realdevice feed) and `real-devices-report` (Playwright HTML).');
console.log(lines.join('\n'));

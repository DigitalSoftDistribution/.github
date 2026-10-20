// Writes real-devices-results.json, the one file the CC realdevice feed reads (artifact `real-devices-results`).
//
// Shape (extra keys are additive; the feed must ignore what it does not know):
// { schema, configured, mode, repo, sha, run_url, project, base_url, started_at, finished_at, status,
//   devices: [{ device, label, passed, failed, skipped, flaky, duration_s, session_urls, metrics, tests }] }
// metrics: [{ test, name, value, source? }]; a `source: "har"` metric is filled in by har-metrics.mjs after the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEVICES } from './devices.mjs';

const strip = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

export default class RealDevicesReporter {
  constructor(options = {}) {
    this.outputFile = options.outputFile || process.env.RD_RESULTS_FILE || 'real-devices-results.json';
    this.byDevice = new Map();
    this.startedAt = new Date().toISOString();
  }

  onBegin(config) {
    for (const project of config.projects) this.row(String(project.metadata?.device || project.name));
  }

  row(id) {
    if (!this.byDevice.has(id)) {
      this.byDevice.set(id, {
        device: id,
        label: DEVICES[id]?.label || id,
        passed: 0,
        failed: 0,
        skipped: 0,
        flaky: 0,
        duration_s: 0,
        session_urls: [],
        metrics: [],
        tests: [],
      });
    }
    return this.byDevice.get(id);
  }

  onTestEnd(test, result) {
    const project = test.parent.project();
    const row = this.row(String(project?.metadata?.device || project?.name || 'unknown'));
    const title = test.titlePath().slice(3).join(' > ') || test.title;
    // Runtime annotations (info.annotations.push) are on the result since Playwright 1.52; older ones put them on the test.
    const notes = result.annotations?.length ? result.annotations : test.annotations || [];
    row.duration_s = Math.round((row.duration_s + result.duration / 1000) * 10) / 10;
    // Every attempt opened a session worth linking; only the final attempt counts toward totals and metrics.
    for (const a of notes) {
      if (a.type === 'rd-session' && a.description && !row.session_urls.includes(a.description)) row.session_urls.push(a.description);
    }
    if (result.retry < test.retries && result.status !== 'passed' && result.status !== 'skipped') return;
    for (const a of notes.filter((n) => n.type === 'rd-metric' && n.description)) {
      try {
        const m = JSON.parse(a.description);
        row.metrics.push({ test: title, name: m.name, value: m.value });
      } catch {
        // A malformed metric is dropped, never fatal.
      }
    }
    const outcome = test.outcome();
    if (outcome === 'expected') row.passed++;
    else if (outcome === 'flaky') {
      row.passed++;
      row.flaky++;
    } else if (outcome === 'skipped') row.skipped++;
    else row.failed++;
    const harCounts = [];
    for (const a of notes.filter((n) => n.type === 'rd-har-count' && n.description)) {
      try {
        harCounts.push(JSON.parse(a.description));
      } catch {
        // dropped, as for metrics
      }
    }
    const harUrl = notes.find((n) => n.type === 'rd-har')?.description;
    if (harCounts.length && !harUrl) {
      // Local mode, or a session that gave no network-log URL: the count is unknown, never zero.
      for (const c of harCounts) row.metrics.push({ test: title, name: c.name, value: null, source: 'har', note: 'no BrowserStack network log for this session' });
    }
    row.tests.push({
      title,
      status: outcome === 'expected' || outcome === 'flaky' ? 'passed' : outcome === 'skipped' ? 'skipped' : 'failed',
      duration_s: Math.round(result.duration / 100) / 10,
      ...(notes.find((n) => n.type === 'rd-session') ? { session_url: notes.find((n) => n.type === 'rd-session').description } : {}),
      ...(harUrl && harCounts.length ? { har_logs_url: harUrl, har_counts: harCounts } : {}),
      ...(outcome === 'unexpected' ? { error: strip(result.error?.message).split('\n')[0].slice(0, 300) } : {}),
    });
  }

  onEnd(result) {
    const devices = [...this.byDevice.values()];
    const out = {
      schema: 1,
      configured: true,
      mode: process.env.RD_MODE === 'local' ? 'local' : 'browserstack',
      repo: process.env.GITHUB_REPOSITORY || null,
      sha: process.env.RD_SHA || process.env.GITHUB_SHA || null,
      run_url: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
      event: process.env.GITHUB_EVENT_NAME || null,
      project: process.env.RD_PROJECT || null,
      base_url: process.env.RD_BASE_URL || null,
      started_at: this.startedAt,
      finished_at: new Date().toISOString(),
      status: result.status,
      devices,
    };
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(out, null, 2)}\n`);
  }

  printsToStdio() {
    return false;
  }
}

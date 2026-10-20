// Resolves the network-log counts the specs asked for (countInNetworkLog) and writes them into
// real-devices-results.json as metrics with source "har". Runs after `playwright test`, once every session has
// ended: BrowserStack serves a session's HAR only after the session is complete, and sometimes a minute later.
//
//   BROWSERSTACK_USERNAME=... BROWSERSTACK_ACCESS_KEY=... node har-metrics.mjs out/real-devices-results.json
//
// A count that cannot be fetched is reported as null with a note, never as 0 and never as a failure.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node har-metrics.mjs <real-devices-results.json>');
  process.exit(2);
}
const user = process.env.BROWSERSTACK_USERNAME;
const key = process.env.BROWSERSTACK_ACCESS_KEY;
const WAIT_MS = Number(process.env.RD_HAR_WAIT_MS || 180_000);
const auth = user && key ? `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}` : null;

/** Base64url-decoded query values, so a hit hidden in a parameter (e.g. a Stape loader path) can be matched. */
function decodedParams(url) {
  const out = [];
  try {
    for (const value of new URL(url).searchParams.values()) {
      if (value.length < 12 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) continue;
      const text = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^[\x20-\x7e\r\n\t]+$/.test(text)) out.push(text);
    }
  } catch {
    // not a URL
  }
  return out;
}

async function fetchHar(url) {
  const deadline = Date.now() + WAIT_MS;
  let last = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (res.ok) {
        const har = await res.json();
        if (Array.isArray(har?.log?.entries)) return har;
        last = 'response has no log.entries';
      } else last = `HTTP ${res.status}`;
    } catch (err) {
      last = String(err?.message || err);
    }
    if (Date.now() > deadline) throw new Error(last);
    await new Promise((r) => setTimeout(r, Math.min(30_000, 5_000 * (attempt + 1))));
  }
}

function count(har, spec) {
  const hosts = new RegExp(spec.hosts, spec.hostsFlags || '');
  const match = new RegExp(spec.match, (spec.matchFlags || '').replace('g', ''));
  const byHost = {};
  let total = 0;
  for (const entry of har.log.entries) {
    const url = String(entry?.request?.url || '');
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    if (!hosts.test(host) && !hosts.test(url)) continue;
    const text = [url, String(entry?.request?.postData?.text || ''), ...decodedParams(url)].join('\n');
    if (!match.test(text)) continue;
    total++;
    byHost[host] = (byHost[host] || 0) + 1;
  }
  return { total, byHost };
}

const results = JSON.parse(readFileSync(file, 'utf8'));
let pending = 0;
for (const dev of results.devices || []) {
  for (const t of dev.tests || []) {
    if (!t.har_logs_url || !Array.isArray(t.har_counts) || t.har_counts.length === 0) continue;
    pending++;
    let har = null;
    let note = '';
    if (!auth) note = 'no BrowserStack credentials to fetch the network log';
    else {
      try {
        har = await fetchHar(t.har_logs_url);
      } catch (err) {
        note = `network log not available: ${String(err?.message || err).slice(0, 160)}`;
      }
    }
    for (const spec of t.har_counts) {
      if (!har) {
        dev.metrics.push({ test: t.title, name: spec.name, value: null, source: 'har', note });
        continue;
      }
      const { total, byHost } = count(har, spec);
      dev.metrics.push({ test: t.title, name: spec.name, value: total, by_host: byHost, source: 'har' });
      console.log(`${dev.device} · ${t.title} · ${spec.name} = ${total} ${JSON.stringify(byHost)}`);
    }
  }
}
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
console.log(`har-metrics: ${pending} session log(s) processed`);

// @dsd/real-devices: the Playwright fixtures every opt-in repo's tests/real-devices/*.spec.ts imports.
//
//   import { test, expect, device, recordMetric, countInNetworkLog } from '@dsd/real-devices';
//
// One test = one BrowserStack session on one device (the project name is the device id). The `page` and `context`
// fixtures are replaced, so no local browser is ever launched in BrowserStack mode, and the session ends in teardown
// whatever the test did. Write each flow as ONE test with test.step()s and clean up in try/finally: a session costs
// device-minutes, and real iOS allows one context and one page per session.
//
// RD_MODE=local runs the same specs on a local Chromium/WebKit with the device's emulation descriptor. That is how a
// spec is proven before the key exists, and how an agent debugs one without spending plan minutes.
import { test as base, expect, devices as pwDevices } from '@playwright/test';
import { createRequire } from 'node:module';
import { DEVICES } from './devices.mjs';

export { expect };

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require('@playwright/test/package.json').version;

const MODE = process.env.RD_MODE === 'local' ? 'local' : 'browserstack';
const CONNECT_TIMEOUT_MS = 5 * 60_000; // BrowserStack queues a session while the plan's parallels are busy
const EXECUTOR_TIMEOUT_MS = 15_000;

/**
 * The device of the running test.
 * @param {import('@playwright/test').TestInfo} [info]
 */
export function device(info = base.info()) {
  const id = String(info.project.metadata?.device || info.project.name);
  const spec = DEVICES[id];
  if (!spec) throw new Error(`real-devices: project ${info.project.name} has no known device`);
  return { id, mode: MODE, ...spec };
}

/**
 * Reports a number (or small JSON value) for this test and device into real-devices-results.json. A metric never
 * fails a test; assert separately when it should.
 * @param {string} name
 * @param {unknown} value
 * @param {import('@playwright/test').TestInfo} [info]
 */
export function recordMetric(name, value, info = base.info()) {
  info.annotations.push({ type: 'rd-metric', description: JSON.stringify({ name, value }) });
}

function wsEndpoint(caps) {
  return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
}

function sessionCaps(spec, info) {
  const user = process.env.BROWSERSTACK_USERNAME;
  const key = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!user || !key) throw new Error('real-devices: BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY are not set (use RD_MODE=local without a key)');
  const project = process.env.RD_PROJECT || 'real-devices';
  const build = process.env.RD_BUILD || `${project} local ${new Date().toISOString().slice(0, 16)}`;
  const caps = {
    ...spec.caps,
    project,
    build,
    name: `${info.titlePath.slice(1).join(' > ')}`.slice(0, 255),
    'browserstack.username': user,
    'browserstack.accessKey': key,
    'browserstack.networkLogs': 'true',
    'browserstack.debug': 'true',
    'client.playwrightVersion': PLAYWRIGHT_VERSION,
  };
  // Real iOS rejects consoleLogs (docs: unsupported capabilities on iOS); elsewhere errors are kept for the dashboard.
  if (spec.kind !== 'ios') caps['browserstack.consoleLogs'] = 'errors';
  return caps;
}

async function executor(page, action, args) {
  const payload = `browserstack_executor: ${JSON.stringify(args ? { action, arguments: args } : { action })}`;
  return Promise.race([
    page.evaluate(() => {}, payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${action} timed out`)), EXECUTOR_TIMEOUT_MS)),
  ]);
}

/** Opens the session for this test: { page, context, close() }. */
async function openSession(playwright, spec, info, contextOptions) {
  if (MODE === 'local') {
    const descriptor = pwDevices[spec.emulate];
    if (!descriptor) throw new Error(`real-devices: Playwright has no device descriptor "${spec.emulate}"`);
    // RD_LOCAL_ENGINE=chromium emulates every device on Chromium, for hosts where WebKit cannot run.
    const engine = process.env.RD_LOCAL_ENGINE || spec.engine;
    const browser = await playwright[engine].launch();
    const { defaultBrowserType: _ignored, ...emulation } = descriptor;
    const context = await browser.newContext({ ...emulation, ...contextOptions });
    const page = await context.newPage();
    return { page, context, close: () => browser.close() };
  }

  const endpoint = wsEndpoint(sessionCaps(spec, info));
  if (spec.kind === 'android') {
    const dev = await playwright._android.connect(endpoint, { timeout: CONNECT_TIMEOUT_MS });
    await dev.shell('am force-stop com.android.chrome');
    const context = await dev.launchBrowser(contextOptions);
    const page = await context.newPage();
    return { page, context, close: () => dev.close() };
  }
  const browser = await playwright[spec.engine].connect({ wsEndpoint: endpoint, timeout: CONNECT_TIMEOUT_MS });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { page, context, close: () => browser.close() };
}

export const test = base.extend({
  /** Extra BrowserContext options (locale, timezoneId, ...). Real iOS honours a subset; keep it small. */
  rdContextOptions: [{}, { option: true }],

  rdSession: async ({ playwright, baseURL, rdContextOptions }, use, info) => {
    const spec = DEVICES[String(info.project.metadata?.device || info.project.name)];
    if (!spec) throw new Error(`real-devices: project ${info.project.name} has no known device`);
    const session = await openSession(playwright, spec, info, { ...(baseURL ? { baseURL } : {}), ...rdContextOptions });
    const { page, context } = session;

    if (MODE === 'browserstack') {
      try {
        const details = JSON.parse(String(await executor(page, 'getSessionDetails')));
        const url = details.public_url || details.browser_url;
        if (url) info.annotations.push({ type: 'rd-session', description: String(url) });
        // Fetched after the session has ended, with the account's credentials (har-metrics.mjs).
        if (details.har_logs_url) info.annotations.push({ type: 'rd-har', description: String(details.har_logs_url) });
      } catch (err) {
        info.annotations.push({ type: 'rd-note', description: `session url unavailable: ${String(err?.message || err).slice(0, 160)}` });
      }
    }
    // Real iOS (BrowserStack Playwright): a page.route() registered before the first goto left every navigation
    // hanging ("Failed to navigate ... Timed out waiting for event"; KS and Lizensa, 2026-10-21, both specs route
    // tracking requests first, Android passed the same specs). iOS cannot see subresource requests anyway
    // (BrowserStack supported-ios-commands: page.on('request') fires for main navigations only), so a route there
    // never blocked a tracking hit. On iOS, route()/unroute() become no-ops and the run says so; consent "reject" in
    // the specs is what keeps those visits out of analytics, and the HAR still counts what was sent.
    if (MODE === 'browserstack' && spec.kind === 'ios') {
      const noop = async () => undefined;
      for (const target of [page, context]) {
        target.route = noop;
        target.unroute = noop;
        target.unrouteAll = noop;
      }
      info.annotations.push({ type: 'rd-note', description: 'iOS: page.route() is a no-op here (real iOS hangs navigation on it; tracking requests are not blocked, consent decides)' });
    }
    await use(session);

    const failed = info.status !== info.expectedStatus;
    if (failed) {
      try {
        await info.attach('screenshot-at-failure', { body: await page.screenshot({ timeout: 20_000 }), contentType: 'image/png' });
      } catch {
        // A dead session has no screenshot to give; the session video on BrowserStack still has it.
      }
    }
    if (MODE === 'browserstack') {
      const reason = failed ? String(info.error?.message || 'failed').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 250) : 'passed';
      await executor(page, 'setSessionStatus', { status: failed ? 'failed' : 'passed', reason }).catch(() => undefined);
    }
    await session.close().catch(() => undefined);
  },

  context: async ({ rdSession }, use) => {
    await use(rdSession.context);
  },

  page: async ({ rdSession }, use) => {
    await use(rdSession.page);
  },
});

/**
 * Asks for a count of the requests in this test's BrowserStack network log (HAR) whose host matches `hosts` and whose
 * URL, body or base64url-encoded query values match `match`. The HAR is recorded by BrowserStack's proxy, so it also
 * sees what a page cannot (a service worker's requests, e.g. gtag's sGTM transport on Safari). It is fetched and
 * counted after the session ends (har-metrics.mjs), and lands in the results as a metric with source "har".
 * In local mode there is no proxy log: the metric is reported as null.
 * @param {string} name
 * @param {{ hosts: RegExp, match: RegExp }} opts
 * @param {import('@playwright/test').TestInfo} [info]
 */
export function countInNetworkLog(name, { hosts, match }, info = base.info()) {
  info.annotations.push({
    type: 'rd-har-count',
    description: JSON.stringify({ name, hosts: hosts.source, hostsFlags: hosts.flags, match: match.source, matchFlags: match.flags }),
  });
}

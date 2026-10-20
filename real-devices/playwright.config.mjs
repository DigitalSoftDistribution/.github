// Playwright config of the org real-devices harness. Driven entirely by environment, so the reusable workflow and a
// local run (RD_MODE=local, see README.md) use the same file.
//
//   RD_SPEC_DIR   absolute dir of the caller's specs (*.spec.ts|mjs|js)       required
//   RD_BASE_URL   site under test                                             required
//   RD_DEVICES    comma list of ids from devices.mjs                          default iphone + pixel
//   RD_OUT        output dir (results JSON, HTML report, test-results)        default ./out
//   RD_MODE       browserstack | local                                        default browserstack
//   RD_GLOBAL_TIMEOUT_MS  whole-run budget; the workflow sets it below the job timeout so results still get written
//   RD_RETRIES    retries per test (each retry is another device session)     default 0
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { DEFAULT_DEVICES, parseDevices } from './devices.mjs';

const specDir = process.env.RD_SPEC_DIR;
if (!specDir) throw new Error('real-devices: RD_SPEC_DIR is not set');
const baseURL = process.env.RD_BASE_URL;
if (!baseURL || !/^https?:\/\//.test(baseURL)) throw new Error(`real-devices: RD_BASE_URL must be an http(s) URL, got "${baseURL || ''}"`);
const out = resolve(process.env.RD_OUT || 'out');
const local = process.env.RD_MODE === 'local';

export default defineConfig({
  testDir: resolve(specDir),
  testMatch: /.*\.spec\.(ts|mts|mjs|js)$/,
  // One session at a time: the plan's parallels are shared by the whole org and every agent.
  workers: 1,
  fullyParallel: false,
  retries: Number(process.env.RD_RETRIES || 0),
  // A real-device session needs time to start (queue + device boot) before the first step runs.
  timeout: 6 * 60_000,
  globalTimeout: Number(process.env.RD_GLOBAL_TIMEOUT_MS || 0),
  expect: { timeout: 20_000 },
  outputDir: `${out}/test-results`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${out}/html`, open: 'never' }],
    ['./reporter.mjs', { outputFile: `${out}/real-devices-results.json` }],
  ],
  use: {
    baseURL: baseURL.replace(/\/+$/, ''),
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    // Traces are not supported on real iOS; the BrowserStack session video and network log replace them.
    trace: local ? 'retain-on-failure' : 'off',
    screenshot: 'off',
  },
  projects: parseDevices(process.env.RD_DEVICES || DEFAULT_DEVICES).map((id) => ({ name: id, metadata: { device: id } })),
});

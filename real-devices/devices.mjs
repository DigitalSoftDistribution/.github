// The device catalog of the org real-devices harness (beast-infra openspec/changes/real-device-testing, G-218).
//
// Each id is what a caller passes in the workflow's `devices` input. `caps` are BrowserStack Automate capabilities
// for its Playwright endpoint (wss://cdp.browserstack.com/playwright); `emulate` is the Playwright device descriptor
// used in local mode (RD_MODE=local), which runs the same specs on a local browser to prove selectors without a key.
//
// Real iOS Safari and real Android Chrome are both Playwright targets on BrowserStack:
//   https://www.browserstack.com/docs/automate/playwright/playwright-ios/nodejs
//   https://www.browserstack.com/docs/automate/playwright/playwright-android/nodejs
// Android is listed only up to Playwright 1.59 (https://www.browserstack.com/docs/automate/playwright/browsers-and-os),
// which is why package.json pins @playwright/test to 1.59.1. Raise it only when that table lists Android again.

/** @typedef {'ios' | 'android' | 'desktop'} DeviceKind */

/**
 * @typedef {object} DeviceSpec
 * @property {DeviceKind} kind
 * @property {'webkit' | 'chromium'} engine  local engine, and the connect() type for ios/desktop
 * @property {string} label                  human name for summaries
 * @property {Record<string, string>} caps   BrowserStack capabilities (credentials and names are added at connect)
 * @property {string} emulate                Playwright `devices[...]` key for local mode
 */

/** @type {Record<string, DeviceSpec>} */
export const DEVICES = {
  'iphone-16-ios18-safari': {
    kind: 'ios',
    engine: 'webkit',
    label: 'iPhone 16, iOS 18, Safari (real device)',
    caps: { browser: 'safari', browserName: 'safari', deviceName: 'iPhone 16', osVersion: '18', realMobile: 'true' },
    emulate: 'iPhone 15',
  },
  'pixel-9-android15-chrome': {
    kind: 'android',
    engine: 'chromium',
    label: 'Google Pixel 9, Android 15, Chrome (real device)',
    caps: { browser: 'chrome', browserName: 'chrome', deviceName: 'Google Pixel 9', osVersion: '15.0', realMobile: 'true' },
    emulate: 'Pixel 7',
  },
  'desktop-chrome': {
    kind: 'desktop',
    engine: 'chromium',
    label: 'Windows 11, Chrome latest',
    caps: { browser: 'chrome', browser_version: 'latest', os: 'Windows', os_version: '11' },
    emulate: 'Desktop Chrome',
  },
  'desktop-safari': {
    kind: 'desktop',
    engine: 'webkit',
    label: 'macOS Sequoia, Playwright WebKit',
    caps: { browser: 'playwright-webkit', os: 'OS X', os_version: 'Sequoia' },
    emulate: 'Desktop Safari',
  },
};

export const DEFAULT_DEVICES = 'iphone-16-ios18-safari,pixel-9-android15-chrome';

/**
 * Parses a comma list of device ids and refuses an unknown one, so a typo fails the run at config load
 * instead of silently testing nothing.
 * @param {string} list
 * @returns {string[]}
 */
export function parseDevices(list) {
  const ids = [...new Set(String(list || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('real-devices: no devices given');
  const unknown = ids.filter((id) => !(id in DEVICES));
  if (unknown.length) {
    throw new Error(`real-devices: unknown device id(s) ${unknown.join(', ')}; known: ${Object.keys(DEVICES).join(', ')}`);
  }
  return ids;
}

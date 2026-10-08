// Init-latency harness, emulated mobile (desktop Chromium).
//
// Loads each variant page cold, with third-party tags blocked, under a fixed
// throttle (150 ms RTT, 1.6 Mbps down, 768 kbps up, 4x CPU), and records when
// the SDK puts `next-display-ready` on <html>. One JSON line per run.
//
// The 4x CPU throttle exaggerates main-thread cost. Treat these numbers as
// directional and confirm on a real device (measure-init-latency-device.mjs).
//
//   node scripts/measure-init-latency.mjs                       # defaults below
//   node scripts/measure-init-latency.mjs --variants "a=/checkout/" --runs 5
//   node scripts/measure-init-latency.mjs --help
//
// Setup and method: docs/init-latency-harness.md

import { chromium } from 'playwright';
import { parseArgs } from './harness-args.mjs';

const {
  base: BASE,
  runs: RUNS,
  timeout: READY_TIMEOUT,
  query: QUERY,
  variants: VARIANTS,
} = parseArgs(process.argv.slice(2), {
  base: 'http://127.0.0.1:8899',
  runs: 3,
  timeout: 45000,
  query: 'ignore=true',
  // The corrected-rig set from EXPERIMENTS.md: the velin silver-sheets
  // checkout copy served mounted at /silver-sheets/, one folder per SDK SHA.
  variants: [
    { name: 'baseline@39f806a2', path: '/silver-sheets/checkout-poc/' },
    { name: 'exp-a@0b57fd98', path: '/silver-sheets/checkout-exp-a/' },
    { name: 'exp-b@2ab9dc70', path: '/silver-sheets/checkout-exp-b/' },
    { name: 'exp-c2@d83b8c43', path: '/silver-sheets/checkout-exp-c2/' },
  ],
});

// --- Fixed measurement constants. Change these and results stop being comparable. ---
const NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (768 * 1024) / 8,
};
const CPU_RATE = 4;
const BLOCKED = [
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'doubleclick.net',
  'google.ca',
  'google.com/ads',
  'convertexperiments.com',
  'sd2rew.com',
  'datadoghq-browser-agent.com',
  'facebook.net',
  'facebook.com',
];
const SDK_HOST = 'jsdelivr';
const API_HOST = 'campaigns.apps.29next.com';

const round = n => (n == null ? null : Math.round(n));

async function runOnce(variant) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  await page.route('**/*', route =>
    BLOCKED.some(h => route.request().url().includes(h))
      ? route.abort()
      : route.continue()
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NETWORK);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

  await page.addInitScript(() => {
    window.__readyAt = null;
    const check = () => {
      if (document.documentElement.classList.contains('next-display-ready')) {
        window.__readyAt = performance.now();
        return true;
      }
      return false;
    };
    const mo = new MutationObserver(() => {
      if (check()) mo.disconnect();
    });
    document.addEventListener('DOMContentLoaded', () => {
      if (!check())
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class'],
        });
    });
  });

  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 120)));

  await page.goto(BASE + variant.path + (QUERY ? '?' + QUERY : ''), {
    waitUntil: 'domcontentloaded',
    timeout: READY_TIMEOUT,
  });
  let ready = null;
  try {
    await page.waitForFunction(() => window.__readyAt !== null, null, {
      timeout: READY_TIMEOUT,
    });
    ready = await page.evaluate(() => window.__readyAt);
  } catch {
    /* ready never fired; reported as null */
  }

  const data = await page.evaluate(
    ({ SDK_HOST, API_HOST }) => {
      const res = performance.getEntriesByType('resource').map(e => ({
        url: e.name,
        start: e.startTime,
        end: e.responseEnd,
        bytes: e.transferSize,
      }));
      const sdk = res.filter(r => r.url.includes(SDK_HOST));
      const loader = sdk.find(r => r.url.includes('loader.js'));
      const api = res
        .filter(r => r.url.includes(API_HOST))
        .sort((a, b) => a.start - b.start);
      const pick = frag => api.find(r => r.url.includes(frag));
      return {
        loaderEnd: loader?.end,
        sdkFiles: sdk.length,
        sdkBytes: sdk.reduce((s, r) => s + (r.bytes || 0), 0),
        sdkLastEnd: sdk.length ? Math.max(...sdk.map(r => r.end)) : null,
        firstApiStart: api[0]?.start,
        api: {
          location: pick('/location'),
          campaigns: pick('/campaigns/'),
          jsCampaign: pick('/js/v1/campaign'),
          calculate: pick('calculate'),
        },
      };
    },
    { SDK_HOST, API_HOST }
  );

  await browser.close();
  return { ready, consoleErrors: consoleErrors.slice(0, 3), ...data };
}

const span = r => r && [round(r.start), round(r.end)];

for (const variant of VARIANTS) {
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce(variant);
    console.log(
      JSON.stringify({
        variant: variant.name,
        run: i,
        loaderEnd_ms: round(r.loaderEnd),
        sdkFiles: r.sdkFiles,
        sdkKB: Math.round(r.sdkBytes / 1024),
        sdkLastEnd_ms: round(r.sdkLastEnd),
        firstApiStart_ms: round(r.firstApiStart),
        location: span(r.api.location),
        campaigns: span(r.api.campaigns),
        jsCampaign: span(r.api.jsCampaign),
        calculate: span(r.api.calculate),
        ready_ms: round(r.ready),
        errors: r.consoleErrors,
      })
    );
  }
}

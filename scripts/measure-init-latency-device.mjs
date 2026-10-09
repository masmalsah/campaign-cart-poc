// Init-latency harness, real Android device (Chrome over adb).
//
// Same page set, block list, ready signal and network throttle as
// measure-init-latency.mjs (150 ms RTT, 1.6 Mbps down, 768 kbps up). The CPU
// is NOT throttled: real silicon is the point. HTTP cache is cleared per run
// without touching the phone's Chrome profile.
//
// Requires:
//   - An Android phone with USB debugging on and authorised, Chrome installed.
//   - `adb` on PATH. The phone reaches the Mac's static server through
//     `adb reverse`, which this script sets up for the port in --base.
//   - Playwright's experimental Android support (ships with the playwright
//     package; no extra install).
//
//   node scripts/measure-init-latency-device.mjs
//   node scripts/measure-init-latency-device.mjs --variants "a=/checkout/" --runs 5
//
// Setup and method: docs/init-latency-harness.md

import { execFileSync } from 'node:child_process';
import { _android as android } from 'playwright';
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
  variants: [
    { name: 'device-baseline@39f806a2', path: '/silver-sheets/checkout-poc/' },
    { name: 'device-exp-a@0b57fd98', path: '/silver-sheets/checkout-exp-a/' },
    { name: 'device-exp-c2@d83b8c43', path: '/silver-sheets/checkout-exp-c2/' },
    {
      name: 'device-exp-d-async@d83b8c43',
      path: '/silver-sheets/checkout-exp-d/',
    },
  ],
});

// --- Fixed measurement constants. Change these and results stop being comparable. ---
const NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (768 * 1024) / 8,
};
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

// The phone must reach the Mac's server at the same host:port as --base.
const port = new URL(BASE).port || '80';
try {
  execFileSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], {
    stdio: 'ignore',
  });
} catch {
  console.error(
    `adb reverse tcp:${port} failed. Is adb on PATH and the phone authorised?`
  );
  process.exit(1);
}

const [device] = await android.devices();
if (!device) {
  console.error('No Android device found. Is USB debugging on and authorised?');
  process.exit(1);
}
console.error(`device: ${device.model()} (${device.serial()})`);
await device.shell('am force-stop com.android.chrome');

for (const variant of VARIANTS) {
  for (let i = 1; i <= RUNS; i++) {
    const context = await device.launchBrowser();
    const page = await context.newPage();
    await page.route('**/*', route =>
      BLOCKED.some(h => route.request().url().includes(h))
        ? route.abort()
        : route.continue()
    );
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    // Main-thread cost and memory on real silicon, read at ready
    // (campaigns-app#615: ScriptDuration, TaskDuration, JSHeapUsedSize).
    await cdp.send('Performance.enable');

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
    const metrics = await readMetrics(cdp);

    const data = await page.evaluate(
      ({ SDK_HOST, API_HOST }) => {
        const res = performance.getEntriesByType('resource');
        const sdk = res.filter(r => r.name.includes(SDK_HOST));
        const loader = sdk.find(r => r.name.includes('loader.js'));
        const api = res
          .filter(r => r.name.includes(API_HOST))
          .sort((a, b) => a.startTime - b.startTime);
        return {
          loaderEnd: loader?.responseEnd,
          sdkFiles: sdk.length,
          firstApiStart: api[0]?.startTime,
          firstApiEnd: api[0]?.responseEnd,
        };
      },
      { SDK_HOST, API_HOST }
    );

    console.log(
      JSON.stringify({
        variant: variant.name,
        run: i,
        loaderEnd_ms: round(data.loaderEnd),
        sdkFiles: data.sdkFiles,
        firstApiStart_ms: round(data.firstApiStart),
        ready_ms: round(ready),
        script_ms: round(metrics.scriptMs),
        task_ms: round(metrics.taskMs),
        heap_kb: round(metrics.heapKB),
      })
    );
    await context.close();
  }
}
await device.close();

// CDP Performance.getMetrics at the moment ready fires (or at timeout).
// ScriptDuration and TaskDuration are seconds since Performance.enable;
// JSHeapUsedSize is bytes.
async function readMetrics(cdp) {
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = name => metrics.find(m => m.name === name)?.value;
    return {
      scriptMs: get('ScriptDuration') * 1000,
      taskMs: get('TaskDuration') * 1000,
      heapKB: get('JSHeapUsedSize') / 1024,
    };
  } catch {
    return { scriptMs: null, taskMs: null, heapKB: null };
  }
}

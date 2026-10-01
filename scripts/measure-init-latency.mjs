import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const VARIANTS = [{ name: 'exp-b-bootset@2ab9dc70', path: '/checkout-exp-b/' }];
const RUNS = 3;
const READY_TIMEOUT = 45000;

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
  const BLOCKED = [
    'googletagmanager.com', 'google-analytics.com', 'doubleclick.net',
    'google.ca', 'google.com/ads', 'convertexperiments.com', 'sd2rew.com',
    'datadoghq-browser-agent.com', 'facebook.net', 'facebook.com',
  ];
  await page.route('**/*', route =>
    BLOCKED.some(h => route.request().url().includes(h))
      ? route.abort()
      : route.continue()
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (768 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

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

  await page.goto(BASE + variant.path + '?ignore=true', {
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
    /* ready never fired */
  }

  const data = await page.evaluate(() => {
    const res = performance.getEntriesByType('resource').map(e => ({
      url: e.name,
      start: e.startTime,
      end: e.responseEnd,
      bytes: e.transferSize,
    }));
    const sdk = res.filter(r => r.url.includes('jsdelivr'));
    const loader = sdk.find(r => r.url.includes('loader.js'));
    const api = res
      .filter(r => r.url.includes('campaigns.apps.29next.com'))
      .sort((a, b) => a.start - b.start);
    const pick = frag => api.find(r => r.url.includes(frag));
    return {
      loaderEnd: loader?.end,
      sdkFiles: sdk.length,
      sdkBytes: sdk.reduce((s, r) => s + (r.bytes || 0), 0),
      sdkLastEnd: Math.max(...sdk.map(r => r.end)),
      firstApiStart: api[0]?.start,
      api: {
        location: pick('/location'),
        campaigns: pick('/campaigns/'),
        jsCampaign: pick('/js/v1/campaign'),
        calculate: pick('calculate'),
      },
      apiUrls: api.slice(0, 8).map(r => r.url.replace(/\?.*/, '')),
    };
  });

  await browser.close();
  return { ready, consoleErrors: consoleErrors.slice(0, 3), ...data };
}

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
        location: r.api.location && [round(r.api.location.start), round(r.api.location.end)],
        campaigns: r.api.campaigns && [round(r.api.campaigns.start), round(r.api.campaigns.end)],
        jsCampaign: r.api.jsCampaign && [round(r.api.jsCampaign.start), round(r.api.jsCampaign.end)],
        calculate: r.api.calculate && [round(r.api.calculate.start), round(r.api.calculate.end)],
        ready_ms: round(r.ready),
        errors: r.consoleErrors,
      })
    );
  }
}

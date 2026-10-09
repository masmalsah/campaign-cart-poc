# Init-latency harness

The measurement rig behind the numbers in [EXPERIMENTS.md](../EXPERIMENTS.md) and on
[campaigns-app#575](https://github.com/NextCommerceCo/campaigns-app/issues/575). Two scripts,
same method:

| Script                                    | Runs on                       | CPU           | Use for                        |
| ----------------------------------------- | ----------------------------- | ------------- | ------------------------------ |
| `scripts/measure-init-latency.mjs`        | Desktop Chromium (Playwright) | 4x throttled  | Quick, repeatable, directional |
| `scripts/measure-init-latency-device.mjs` | Real Android Chrome over adb  | Not throttled | The number to quote            |

Both print one JSON line per run to stdout. Report the **median of 3 runs** per variant.

## What is measured

- **Ready** = the SDK adds `next-display-ready` to `<html>`. That is the moment the shopper sees
  prices and a usable form. Everything the SDK loads after that (idle feature preloads) is
  outside this number.
- **Network:** 150 ms RTT, 1.6 Mbps down, 768 kbps up, applied through CDP on both rigs.
  This is deliberately slow mobile. Compare variants against each other on the same rig,
  not absolute numbers against another machine or phone.
- **Cold cache** every run. The desktop rig uses a fresh browser per run; the device rig
  clears Chrome's HTTP cache per run through CDP.
- **Third-party tags blocked** at the network layer (GTM, GA4, Convert, Everflow, Datadog,
  Facebook) so only SDK and page time is measured, and test loads stay out of production
  analytics. Pages are loaded with `?ignore=true` for the same reason.
- **Live API:** `GET /campaigns/` and the stateless `POST /carts/calculate/` are real
  requests. No carts or orders are created.

These constants are fixed in the scripts on purpose. Change them and your numbers stop being
comparable with everyone else's.

## Setup

1. `npm install` in this repo (Playwright is a dev dependency; `npx playwright install chromium`
   if the browser is missing).
2. Put the test pages under one directory and serve it on port 8899:

   ```sh
   python3 -m http.server 8899 --bind 127.0.0.1 --directory <siteroot>
   ```

   Serve the site at the same mount path its assets expect. The velin page used in
   EXPERIMENTS.md references `/silver-sheets/...` absolutely, so its folder is mounted at
   `<siteroot>/silver-sheets/`. Check the page's `config.js` and CSS load with 200s before
   measuring. A wrong mount is silent: the page renders, `window.nextConfig` is missing, and
   every number is wrong. That mistake cost us a day; see the erratum in EXPERIMENTS.md.

3. One folder per variant, each pointing its loader tag at a different SDK build, for example
   `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<sha>/dist/loader.js`.
4. **Warm the CDN first.** A new SHA means every chunk URL is cold on jsDelivr, and a cold run
   reads 7 to 40 s. Load each variant once in a normal browser, or discard run 1 if it is an
   outlier. The harness does not do this for you.
5. Device rig only: USB debugging on and authorised, Chrome installed on the phone, `adb` on
   PATH. The script runs `adb reverse` so the phone's `127.0.0.1:8899` reaches your server.

## Running

```sh
# Defaults: the four EXPERIMENTS.md variants on http://127.0.0.1:8899, 3 runs each
node scripts/measure-init-latency.mjs

# Your own pages
node scripts/measure-init-latency.mjs \
  --variants "v0.4.40=/checkout/,overlay-fix=/checkout-overlay/" --runs 3

# Same on the phone
node scripts/measure-init-latency-device.mjs --variants "v0.4.40=/checkout/,overlay-fix=/checkout-overlay/"

# Variants as JSON if you prefer
node scripts/measure-init-latency.mjs --variants '[{"name":"a","path":"/checkout/"}]'
```

Flags: `--base`, `--variants`, `--runs`, `--timeout`, `--query`, `--help`. `VARIANTS`, `RUNS`
and `BASE` environment variables work too; flags win.

## Reading the output

Desktop line:

```json
{
  "variant": "baseline@39f806a2",
  "run": 2,
  "loaderEnd_ms": 547,
  "sdkFiles": 45,
  "sdkKB": 289,
  "sdkLastEnd_ms": 6669,
  "firstApiStart_ms": 5492,
  "campaigns": [5492, 5827],
  "calculate": [6035, 6204],
  "ready_ms": 6672,
  "script_ms": 1840,
  "task_ms": 2410,
  "heap_kb": 9876,
  "errors": []
}
```

- `loaderEnd_ms`: `loader.js` finished downloading.
- `sdkFiles` / `sdkKB`: SDK requests to the CDN host and bytes transferred before the page was
  sampled.
- `sdkLastEnd_ms`: the last SDK file finished.
- `firstApiStart_ms`: first request to the campaigns API. The gap from `loaderEnd_ms` to here
  is module download plus evaluation.
- `location`, `campaigns`, `jsCampaign`, `calculate`: `[start, end]` of each API call, absent if
  the call never happened (the SDK caches location for an hour and campaigns for ten minutes,
  and the experiment C2 loader prefetch replaces the page's own `/campaigns/` call).
- `ready_ms`: the number. `null` means ready never fired inside `--timeout`.
- `script_ms`, `task_ms`, `heap_kb`: Chrome's `ScriptDuration`, `TaskDuration` and
  `JSHeapUsedSize` (CDP `Performance.getMetrics`) read the moment ready fires, or at timeout.
  Script and task time are main-thread totals since navigation; heap is live JS memory. On the
  desktop rig the two durations are inflated by the 4x CPU throttle; quote the device figures.
- `errors`: first three uncaught page errors. "Failed to fetch dynamically imported module" on
  a jsDelivr URL means the CDN edge was cold or the SHA is wrong; rerun.

The device line carries `loaderEnd_ms`, `sdkFiles`, `firstApiStart_ms`, `ready_ms`, `script_ms`,
`task_ms` and `heap_kb`.

## Caveats

- The 4x CPU throttle on the desktop rig exaggerates main-thread work. On the Pixel 4a 5G the
  same variants ran within about 0.1 s of the desktop rig, but a change that mostly moves JS
  evaluation can look bigger on desktop than it is. Confirm on the device.
- Device numbers depend on the phone. Compare before and after on one phone. Our figures are
  from a Pixel 4a 5G.
- Run-to-run spread is about 0.1 to 0.2 s on both rigs once the CDN is warm. Differences
  under that are noise.
- Reproducibility check, 2026-10-08: the baseline variant measured 6.65 s median on this
  script against 6.77 s recorded on 2026-10-01.

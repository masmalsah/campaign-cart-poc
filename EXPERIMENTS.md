# SDK init-latency experiments

Proof-of-concept work for the SDK-side questions raised on
[campaigns-app#575](https://github.com/NextCommerceCo/campaigns-app/issues/575#issuecomment-5895241070):
flatten the module graph, skip or parallelize the location lookup, and start
the campaign/calculate calls earlier.

> **⚠️ ERRATUM (2026-10-01): every measurement dated 2026-09-30 below was taken
> on a broken test rig and is superseded by the "Corrected results" section at
> the end.** The test page was served with the wrong site root, so all of its
> absolute `/silver-sheets/...` asset references 404'd — including `config.js`.
> Consequences: `window.nextConfig` never existed at loader time, so the
> experiment C/D/E prefetch **never executed in any 09-30 run** (its guard
> no-op'd) and every "prefetch bought nothing" conclusion was wrong; the page
> was also missing its CSS bundle and head scripts, making absolute times
> optimistic. The "No nextConfig found" template observation was this same
> artifact — the shipped config-before-loader order is correct (verified
> independently three ways on the template side). The 09-30 sections are kept
> for the record of what was tried, not for their numbers.

## Method

- **Page:** local copy of the built velin `silver-sheets/checkout/` page
  (the direct-landing scenario from the issue comment), served from
  `127.0.0.1`, loaded with `?ignore=true`.
- **SDK delivery:** this repo via jsDelivr, pinned to a commit SHA per
  variant (`cdn.jsdelivr.net/gh/masmalsah/campaign-cart-poc@<sha>/dist/loader.js`).
  All chunk URLs are warmed on the CDN edge before measuring — a new SHA means
  every URL is cold, and a cold first run reads 7–14s.
- **Profile:** Playwright Chromium, CDP-throttled: 150 ms RTT, 1.6 Mbps down,
  4× CPU, cold browser cache per run, 3 runs per variant, medians reported.
- **Blocked:** all third-party tags (GTM/GA4, Convert, Everflow, Datadog,
  Facebook) are aborted at the network layer — this isolates SDK time and
  keeps test loads out of production analytics.
- **Ready signal:** the `next-display-ready` class on `<html>`.
- Live API calls are reads only: `GET /campaigns/` and the stateless
  `POST /carts/calculate/`. No carts or orders are created.

Harness: `measure.mjs` (Playwright + CDP), kept in the session scratchpad;
copy lives with whoever reruns this. Stock-SDK reference numbers, same rig,
tags *not* blocked: v0.4.38 ready ≈ 7.8 s, v0.4.40 ≈ 6.8 s.

## Results

| Variant (SHA) | First `/campaigns/` | `next-display-ready` | Delta vs baseline |
|---|---|---|---|
| Baseline v0.4.40 import (`39f806a2`) | 3.47 s | **4.81 s** | — |
| A: static-graph modulepreload (`0b57fd98`) | 3.05 s | **4.31 s** | −0.5 s |
| B: full 40-chunk boot-set preload (`2ab9dc70`) | 3.56 s | **4.52 s** | −0.3 s |

## Findings

1. **The static import graph is shallow but serial.** 44 files load at boot;
   only 8 are static imports of the entry (4 waterfall levels), the rest are
   dynamic `import()`s. Preloading the static 8 from the loader (Experiment A)
   is a ~20-line, zero-behavior change worth ~10%.
2. **Download time is not the dominant cost after A.** Experiment B finishes
   all SDK downloads by 3.2 s (vs 4.8 s baseline) yet *ready regresses vs A*:
   the preload burst competes with the entry chunks for bandwidth, and the
   remaining floor is JS evaluation on throttled CPU plus the sequential API
   chain. B is a ceiling probe, not a shippable mechanism (its list is
   page-profile-specific).
3. **The API chain is the next prize.** `/campaigns/` starts only after ~3 s
   of module evaluation, but everything it needs (`window.nextConfig.apiKey`)
   exists when the loader runs at ~0.6 s. Experiment C: the loader fires the
   geo + campaigns requests immediately; the SDK adopts the in-flight
   responses instead of starting its own.
4. v0.4.40 already loads ~1 s faster than v0.4.38 on this profile
   (287 KB vs 453 KB transferred).

## Experiment C — loader-initiated API prefetch

Goal: overlap the `geo → campaigns` network time with module download and
evaluation. The loader fires the geo trio and the campaigns request as soon
as `window.nextConfig.apiKey` is readable; results are parked on
`window.__nextPrefetch`; the SDK adopts an in-flight result only when its
resolved currency/lang match, else falls through to its normal request.

| Variant (SHA) | `next-display-ready` |
|---|---|
| C1: main-thread prefetch (`d16e9878`) | 4.36 s — no gain over A |
| C2: Web Worker prefetch (`d83b8c43`) | 4.34 s — no gain over A |
| D: C2 + classic `async` loader tag (page-side) | 4.74 s |

The adoption mechanism itself works: an unthrottled probe shows geo at
1.0 s, campaigns at 1.2 s, and zero duplicate requests (the SDK adopted
every prefetched response). Under 4× CPU throttle it never wins:

- **C1:** module evaluation keeps the main thread in long tasks, so the
  geo→campaigns promise chain starves until the SDK is booted anyway.
- **C2:** the worker thread is throttled too and its startup/dispatch is
  starved the same way — fetches dispatch ~2.7 s after worker creation.
- **D:** `type="module"` had been deferring the loader until HTML parsing
  finished (~2.4 s); a classic `async` tag runs it at ~0.55 s and pulls
  `index.js` from 2.5 s to 0.53 s — but ready got slightly *worse*: the
  early SDK download competes with the page's own HTML/CSS for the
  throttled link, delaying the parse that `waitForDOM` gates boot on.

### Structural findings

1. **The loader runs ~2 s later than it could.** Templates load it with
   `type="module"`, deferring execution until HTML parse completes. The
   loader is a plain IIFE; a classic `async` tag runs it at ~0.55 s. On its
   own this reshuffles rather than wins (see D), but it is the precondition
   for any loader-side head start.
2. **After Experiment A, the floor is not the network.** It is HTML parse
   (`waitForDOM` gates boot) → module evaluation → the sequential
   `campaigns → calculate` chain → DOM enhance, all on a throttled main
   thread.
3. **Emulated 4× CPU throttle penalizes workers and promise chains alike**,
   which may overstate the starvation vs real mid-range hardware. The
   prefetch mechanism (built, safe, fall-through on mismatch) should be
   re-measured on a physical device before being written off.

### Real-device validation (Pixel 4a 5G, 2026-09-30)

Same page, same network throttle (150 ms RTT / 1.6 Mbps via CDP), real
Chrome on a physical Pixel 4a 5G (Snapdragon 765G) over adb, no CPU
throttle, cold HTTP cache per run, 3 runs, medians:

| Variant | First `/campaigns/` | `next-display-ready` |
|---|---|---|
| Baseline (`39f806a2`) | 3.66 s | **5.46 s** |
| A: static modulepreload (`0b57fd98`) | 3.34 s | **4.69 s** (−0.77 s, −14%) |
| C2: + worker prefetch (`d83b8c43`) | 3.30 s | 4.77 s (no gain over A) |
| D: + classic `async` loader tag | 3.58 s | 4.96 s (noisy; no gain) |

Follow-up device runs after the trace finding (below):

| Variant | First `/campaigns/` | `next-display-ready` |
|---|---|---|
| B: 40-chunk boot-set preload (`2ab9dc70`) | 3.37 s | **4.35 s (−1.1 s, −20%)** |
| E: B + classic `async` loader tag | 3.52 s | 4.55 s (no gain over B) |

The real device is *slower* than the emulated profile (5.46 s vs 4.81 s
baseline). Experiment A's gain is real and larger on device, and the worker
prefetch still adds nothing — but the device *reverses* the emulated verdict
on B: the boot-set preload is the best result measured (−20%), and its
emulated regression was a CPU-throttle artifact.

### Trace finding: the device is idle, not CPU-bound

A CDP performance trace of the exp-A page on the Pixel (ready at 4.28 s)
shows the main thread busy only **1.44 s** of the window — idle/waiting
**2.84 s**. ParseHTML is 73 ms, SDK compile 4 ms, style/layout 293 ms. The
emulated 4× CPU profile made evaluation look like the floor; on real
hardware the floor is network waiting: the dynamic-import waterfall and the
serialized geo → campaigns → calculate chain. This is why B wins on device
and why first `/campaigns/` stays pinned at ~3.4 s in every variant — the
boot's serial step structure, not the CPU, holds it there.

### Next investigation

First API dispatch sits at ~3.4 s on device in every variant, including
with all chunks preloaded and the loader running at 0.55 s. The gap between
DOMContentLoaded (~1.5 s) and the campaigns call (~3.4 s) needs per-boot-step
timestamps (the SDK's debug logs carry them) to find which initializer step
owns it — suspects are the geo round trip inside the location/currency step
and sequential dynamic-import rounds during boot.

### Open levers

- Dispatch the prefetch without any chaining: guess the currency from
  `navigator.language` in the loader (country→currency table for the
  common cases) and fire campaigns at 0.55 s; geo confirms later; a wrong
  guess costs one wasted request and falls through — same safety contract.
- Origin-side edge caching (campaigns-app#575 proper) shortens the same
  calls for every integration shape without any scheduling fight.
- Re-run C2/D on real hardware (mid-range Android) to check how much of the
  starvation is an artifact of CDP throttling.

## Corrected results (2026-10-01, fixed rig)

Rig fix: the built site is now served mounted at `/silver-sheets/` so every
absolute asset path resolves — `config.js`, both first-party head scripts, the
CSS bundle, fonts. Same throttle profile, tags blocked, `?ignore=true`,
3 runs, medians (cold-CDN outlier runs excluded).

### Desktop (emulated: 150 ms RTT, 1.6 Mbps, 4× CPU)

| Variant | First page-level API | `next-display-ready` |
|---|---|---|
| Baseline (`39f806a2`) | 5.43 s (`/campaigns/`) | 6.77 s |
| A: static modulepreload (`0b57fd98`) | 5.36 s (`/campaigns/`) | 6.57 s |
| B: 40-chunk boot-set preload (`2ab9dc70`) | 5.99 s | 7.15 s (noisy) |
| C2: worker prefetch + A (`d83b8c43`) | 5.37 s (`/calculate/`) | **6.34 s** |

### Pixel 4a 5G (real Chrome, network throttle only)

| Variant | `next-display-ready` | vs baseline |
|---|---|---|
| Baseline | 6.77 s | — |
| A: static modulepreload | 6.50 s | −0.27 s |
| B: boot-set preload | 6.64 s | within noise |
| C2: worker prefetch + A | **6.19 s** | **−0.58 s (−9%)** |

### Corrected conclusions

1. **The loader-side API prefetch (experiment C2) is the best verified win:
   −0.58 s on a real device, with the tightest run-to-run variance measured
   (6.18/6.25/6.19 s).** Adoption is confirmed: in every C2 run the page's
   resource log contains no `/campaigns/` request at all — the worker fetched
   it early and the SDK adopted the response. The 09-30 "no gain" verdicts
   existed only because the broken rig prevented the prefetch from ever
   arming.
2. **Experiment A (static-graph modulepreload) is a real but smaller win**
   (−0.27 s device) than the broken rig suggested. Still ~20 lines and
   zero-behavior-change; C2 includes it.
3. **Experiment B does not survive the corrected rig**: with the page's real
   assets loading, the 40-chunk preload burst competes for bandwidth and adds
   nothing over A.
4. Realistic baseline for a direct mobile landing on this page is **~6.8 s**,
   not the ~5.5 s previously reported.
5. The 09-30 trace/boot-log phase breakdown was taken on the asset-less page
   and needs re-capture before being quoted.

Open: re-run the template side's "classic async loader + inlined nextConfig"
idea on this fixed rig — with config inlined in `<head>`, an async classic
loader could arm the C2 prefetch at ~0.6 s instead of ~2.4 s, which is now
worth testing properly since the prefetch demonstrably works.

# SDK init-latency experiments

Proof-of-concept work for the SDK-side questions raised on
[campaigns-app#575](https://github.com/NextCommerceCo/campaigns-app/issues/575#issuecomment-5895241070):
flatten the module graph, skip or parallelize the location lookup, and start
the campaign/calculate calls earlier.

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

## Experiment C — loader-initiated API prefetch (in progress)

Goal: overlap the `geo → campaigns` network time with module download and
evaluation. Loader fires both fetches as soon as `window.nextConfig.apiKey`
is readable; results are parked on `window.__nextPrefetch`; the campaign
API slice consumes a matching in-flight promise before issuing its own
request.

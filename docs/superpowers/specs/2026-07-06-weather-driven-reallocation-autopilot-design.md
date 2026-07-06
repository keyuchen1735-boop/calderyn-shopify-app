# Weather-Driven Reallocation Autopilot — Design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Surface:** Calderyn dashboard (active). No embedded/legacy work.

## Summary

A new daily candidate generator that ranks the 4 US regions by their 3-day
weather forecast and proposes ad-budget reallocations between **geo-segmented
campaigns**, flowing into the existing Action Queue for human approval.

The hypothesis: worse/colder weather (rain, snow, cold, short daylight) drives
more indoor mobile browsing and e-commerce traffic, independent of day-of-week.
Forecasts are only marginally-above-chance accurate at a 3-day horizon, and the
weather→traffic correlation has **not** been measured on Calderyn merchants'
data. Both facts are why this ships as a **propose-only** feature with a
per-shop dampening knob and an **opt-in (default OFF)** posture — never
auto-execute on an unvalidated, weak signal.

This is a *signal source + suggester* bolted onto machinery that already moves
money. It is not a new autopilot engine.

## What already exists (reused, not rebuilt)

- **Money mover:** `app/lib/actions/reallocate.server.ts` (`executeReallocation`)
  moves N cents/day from a source campaign to a dest campaign, cross-platform
  (Meta/Google/TikTok), with idempotency, fail-safe ordering (source cut first),
  and a single `action_audit` row.
- **Existing suggester to mirror:** `app/lib/actions/reallocation-suggest.server.ts`.
- **Campaign model:** `ad_campaign_dim` (`daily_budget_cents`, `geo_targets`,
  `status`), normalized via `app/lib/ads/adapter.ts` (`NormalizedCampaign`).
- **Geo buckets:** `app/lib/ads/geo-regions.ts` — 4 internal `RegionCode`s
  (`us-west`, `us-east`, `us-south`, `us-central`), each mapped to US states and
  to platform geo-target IDs.
- **Approval flow:** the Action Queue — `app/routes/dashboard.api.queue._index.tsx`,
  `calderynClient(shopId).queue`, reject/approve routes.
- **Guardrails:** `app/lib/actions/guardrails.server.ts` + `guardrail_config`
  table (daily action cap, `max_budget_cut_pct`, cooldowns, etc.), UI via
  `app/components/dashboard/GuardrailField.tsx`.
- **Cron pattern:** `app/routes/cron.autopilot.tsx` (auth via
  `isAuthorizedCron`, list opted-in shops, `mapWithConcurrency`, JSON summary),
  schedules declared in `vercel.json`.

## Architecture

New code is intentionally small; everything downstream of "enqueue a proposal"
is existing machinery.

| Piece | Responsibility | Depends on |
|---|---|---|
| `app/lib/weather/regions.ts` | Map the 4 `RegionCode`s to a representative centroid `{lat, lon}`. | `app/lib/ads/geo-regions.ts` (RegionCode) |
| `app/lib/weather/open-meteo.server.ts` | Fetch a 3-day forecast for the 4 centroids in one batched Open-Meteo call. Returns per-region daily `{temp_c, precip_mm, snow_cm, daylight_h}`. Plain `fetch`, no SDK, **no new npm dependency**. Timeout + typed parse. | Open-Meteo HTTP API |
| `app/lib/weather/score.ts` | **Pure** function: forecast → favorability score per region in [0,1], normalized across the 4 regions. Colder + more precip/snow + shorter daylight → higher. Carries a `demo()`/self-check asserting the core invariants. | none (pure) |
| `app/lib/actions/weather-reallocation-suggest.server.ts` | For a shop: load campaigns, keep only **geo-segmented** ones (a campaign's `geo_targets` map cleanly to exactly one `RegionCode`), group by region, fetch scores, pick source region (lowest score, has eligible spend) → dest region (highest score), size the move within existing guardrail caps × `weather_sensitivity`, emit `reallocate_budget` candidate(s) tagged `source: 'weather'` with a human-readable reason. Mirrors `reallocation-suggest.server.ts`. | weather/score, weather/open-meteo, ads adapter, guardrails |
| `app/routes/cron.weather-autopilot.tsx` | Daily cron. Auth via `isAuthorizedCron`; list shops with `weather_sensitivity > 0`; `mapWithConcurrency` → call the suggester → enqueue proposals into the Action Queue; return a JSON summary (proposed / skipped-ineligible / errored per shop). | cron-auth, the suggester, queue enqueue |
| `guardrail_config.weather_sensitivity` | New `numeric` column, range 0..1, **default 0 (OFF)**. Scales reallocation aggressiveness; 0 disables. Exposed as one `GuardrailField` slider/row. | guardrail migration + UI |

### Cadence
Daily (weather is a daily signal). The existing autopilot runs every 30 min —
wrong cadence here; it would re-propose constantly against a slow-moving 3-day
forecast. Hence a **separate** `cron.weather-autopilot.tsx` + one `vercel.json`
`crons` entry.

### Action kind
Reuse `reallocate_budget` — no new `action_kind` enum value. Weather proposals
are distinguished by a `source: 'weather'` tag / reason string
(e.g. `weather_demand_shift`) so the queue card can explain itself.

## Data flow

```
daily cron (cron.weather-autopilot)
  └─ for each shop with weather_sensitivity > 0  (mapWithConcurrency)
       ├─ fetch 4-region 3-day forecast (Open-Meteo)         [open-meteo.server]
       ├─ score → favorability[region] in [0,1]              [score.ts, pure]
       ├─ load geo-segmented campaigns, group by region      [ads adapter]
       ├─ rank: source = lowest-score region w/ eligible spend
       │        dest   = highest-score region
       ├─ size move = f(guardrail caps, weather_sensitivity) [guardrails]
       └─ enqueue reallocate_budget proposal (source:'weather', reason)
                                                              [existing queue]
── human approves in Action Queue ──▶ executeReallocation moves money  [existing]
```

Example proposal reason: *"Next 3 days: us-east forecast cold + rain
(favorability 0.82) vs us-west warm/clear (0.31) → shift $X/day."*

## Eligibility & scope

- **Geo-segmented campaigns only.** A campaign is eligible when its `geo_targets`
  resolve to exactly one `RegionCode`. Merchants running purely **national**
  campaigns get **no proposals** — the feature has nothing to reallocate
  *between*. Accepted MVP limitation (national-campaign fallback is explicitly
  out of scope; see Deferred).
- **Opt-in, default OFF** (`weather_sensitivity = 0`) → zero regression, no
  surprise money moves for any existing shop.

## Error handling & integrity (fail visibly — never fabricate)

- Open-Meteo timeout/error → skip that shop's run, log it, **propose nothing**.
  Never synthesize or stale-fill a forecast.
- Campaign with no clean single-region mapping → ineligible; counted in the cron
  summary's `skipped` tally (not silently dropped).
- Idempotency: **one open weather proposal per (shop, source-region,
  dest-region) per day.** A re-run the same day enqueues no duplicates.
- `weather_sensitivity = 0`, guardrail cap 0, or no eligible source spend →
  clean no-op.
- All existing guardrail caps (`max_budget_cut_pct`, daily action cap,
  cooldowns, min spend) apply unchanged — weather proposals are ordinary
  `reallocate_budget` actions.

## Testing (behavior, not coverage theater)

- `score.ts` (pure): cold+rain region outranks warm+clear; score monotonic in
  each factor (↑precip → ↑score, ↓temp → ↑score, ↓daylight → ↑score);
  normalization keeps values in [0,1]; ties handled.
- `weather-reallocation-suggest.server.ts`: correct source/dest selection;
  national/multi-region campaigns skipped; guardrail caps respected;
  `weather_sensitivity = 0` → empty; no eligible source spend → empty.
- Idempotency: second same-day run → no duplicate proposals.
- `open-meteo.server.ts`: parse a mocked API response into the typed shape;
  timeout path → throws / caller skips.

## Honest limitations (in-spec, not hidden)

1. **No per-geo ROAS exists.** `ad_spend_fact` is keyed by campaign+day, not
   region. We rank regions by *predicted traffic favorability*, not measured
   per-geo *return*. More traffic ≠ more profit if regional CAC differs.
   Mitigations: human approves every move; opt-in default off; per-shop knob.
2. **Weak signal.** Forecasts are marginally-above-chance at 3 days and the
   weather→traffic correlation is unvalidated on Calderyn data. That is the
   entire reason for propose-only + dampening knob + default OFF.
3. The proposal/outcome history this generates is the **training data** for a
   future v2 that learns per-merchant weather coefficients.

## Deferred (YAGNI now — recorded for later)

- **Forecast-persistence table + ingest cron** — only needed for the v2 learned
  model. MVP fetches live per run.
- **National-campaign fallback (total-budget modulation)** — option 2 from
  brainstorming; applies to everyone but changes total spend and the signal is
  heavily averaged-out for national reach. Revisit after core lands.
- **Geo include/exclude toggling** (the "extra feat") — a real second lever, but
  platforms penalize frequent targeting churn, so it ships *after* the core
  reallocation, gated behind its own flag.
- **Finer geo** than the 4 buckets.
- **Auto-execute / graduation** — only after the v2 model demonstrates the
  signal pays off on real outcomes.

## Rollout

1. Migration: add `weather_sensitivity` to `guardrail_config` (default 0).
2. Ship weather lib + suggester + cron behind the default-OFF knob (no shop
   affected until they opt in).
3. Add the `GuardrailField` UI row so a merchant can enable + tune it.
4. Dogfood on one geo-segmented test shop; verify proposals appear in the queue
   with correct reasons and that approval triggers a real reallocation.

# Weather-Driven Reallocation Autopilot — Design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Surface:** Calderyn dashboard (active). No embedded/legacy work.

## Summary

A new daily candidate generator that ranks the 4 US regions by their 3-day
weather forecast and proposes ad-budget reallocations between **geo-segmented
campaigns**, surfaced as a **standalone suggestions panel under Customers →
Segments** for human approval. (The 4 geo-weather buckets are themselves
geographic customer segments — hence the placement.)

> **Approval-surface decision (2026-07-06, revised after codebase discovery):**
> The original "flows into the existing Action Queue" plan is not achievable —
> the queue is *derived from open `alert` rows*, and `reallocate_budget` is
> deliberately excluded from being an approvable queue item
> (`queueActionRunnable` in `app/lib/calibration/queue.server.ts`). Rather than
> edit shared calibration code (regression risk to all reallocations) or build a
> new alert-emitting detector, weather suggestions live in their own
> `weather_suggestion` table and render in a dedicated Segments panel. Each row's
> **Approve** button POSTs to a thin new dashboard API route that calls the
> existing `executeReallocation` directly (guardrail-checked). Lowest blast
> radius on shared code; fully human-in-the-loop.

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
- **Money mover (human path):** the existing manual reallocate call in
  `app/routes/app.campaigns._index.tsx` (`executeReallocation`, no guardrail
  gate) is the convention the new dashboard Approve route mirrors.
- **Guardrail knob UI:** `guardrail_config` table + `GuardrailField`
  (`app/components/dashboard/GuardrailField.tsx`) + `PATCHABLE_KEYS` allowlist
  (`app/routes/dashboard.api.guardrails.tsx`) — reused only to host the new
  `weather_sensitivity` dial (not the autopilot cap evaluator).
- **Screen/panel host:** the Customers screen's Segments subtab
  (`app/components/dashboard/screens/Customers.tsx`), fed by
  `/dashboard/api/customers` (`app/routes/dashboard.api.customers._index.tsx`,
  `CustomersPage`) — the weather panel rides this existing payload + cache key,
  so no new screen-cache/`WARM_TARGETS` wiring is needed.
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
| `weather_suggestion` table | Persisted daily suggestions: `id, shop_id, suggested_on (date), source_region, dest_region, source_campaign_id, dest_campaign_id, amount_cents, source_score, dest_score, narrative, status ('pending'\|'applied'\|'dismissed'), created_at`. Idempotent on `(shop_id, suggested_on, source_campaign_id, dest_campaign_id)`. | New migration |
| `app/routes/cron.weather-suggest.tsx` | Daily cron. Auth via `isAuthorizedCron`; list shops with `weather_sensitivity > 0`; `mapWithConcurrency` → call the suggester → **upsert** rows into `weather_suggestion`; JSON summary (suggested / skipped-ineligible / errored per shop). | cron-auth, the suggester, mapWithConcurrency |
| Segments panel (Weather) | A `<Card>` under the Customers → Segments screen listing today's `pending` `weather_suggestion` rows with narrative + **Approve** / **Dismiss** buttons. | New component + loader wiring |
| `app/routes/dashboard.api.weather-reallocation.tsx` | Thin write route. `requireSameOrigin` + `requireDashboardSession`; body `{ suggestionId, intent: "apply"\|"dismiss" }`. Apply: load the `pending` suggestion (shop-scoped), call `executeReallocation` (alertId `null`, actor `"merchant"`, triggerReason `"weather"`, `idempotencyKey = "weather:" + suggestionId`), mark the row `applied`. Dismiss: mark `dismissed`. **Mirrors the existing manual reallocate path (`app.campaigns._index.tsx`) — no `checkGuardrails` (those caps require `autopilot_enabled` and are an autopilot concept; the human approver is the gate here).** | requireDashboardSession, executeReallocation |
| `guardrail_config.weather_sensitivity` | New `int` column (0..100, percent), **default 0 (OFF)**. Scales reallocation aggressiveness; 0 disables. Exposed as one `GuardrailField` row. | guardrail migration + UI |

### Cadence
Daily (weather is a daily signal). The existing autopilot runs every 30 min —
wrong cadence here; it would re-propose constantly against a slow-moving 3-day
forecast. Hence a **separate** `cron.weather-suggest.tsx` + one `vercel.json`
`crons` entry (schedule `0 7 * * *`).

### Action kind
The Approve route reuses the existing `reallocate_budget` action via
`executeReallocation` — no new `action_kind` enum value. The
`weather_suggestion.status` column (not the action queue) tracks
pending/applied/dismissed.

## Data flow

```
daily cron (cron.weather-suggest)
  └─ for each shop with weather_sensitivity > 0  (mapWithConcurrency)
       ├─ fetch 4-region 3-day forecast (Open-Meteo)         [open-meteo.server]
       ├─ score → favorability[region] in [0,1]              [score.ts, pure]
       ├─ load geo-segmented campaigns, group by region      [suggester]
       ├─ rank: source = lowest-score region w/ eligible spend
       │        dest   = highest-score region
       ├─ size move = f(guardrail caps, weather_sensitivity) [suggester]
       └─ upsert pending row into weather_suggestion         [new table]

Segments panel (rides /dashboard/api/customers payload) ── today's pending rows
merchant clicks Approve ─▶ dashboard.api.weather-reallocation {intent:"apply"}
     └─ executeReallocation (moves money) ─▶ mark row 'applied'
merchant clicks Dismiss ─▶ same route {intent:"dismiss"} ─▶ mark row 'dismissed'
```

### Sizing (deterministic, in the suggester — not the model, not the route)
`amount_cents = round(source_daily_budget_cents × (weather_sensitivity/100) ×
scoreGap)`, where `scoreGap = dest_score − source_score` (both in [0,1]).
Guards: skip if `scoreGap < 0.15` (noise floor), skip if `amount_cents < 100`
($1 floor), and clamp to `floor(source_daily_budget_cents × 0.9)` so the move
always leaves the source budget positive (`executeReallocation` rejects
amounts ≥ source budget). `weather_sensitivity` is the merchant's single dial.

Example narrative: *"Next 3 days: us-east forecast cold + rain
(favorability 0.82) vs us-west warm/clear (0.31) → shift $X/day."*

## Eligibility & scope

- **Geo-segmented campaigns only.** A campaign is eligible when its `geo_targets`
  resolve to exactly one `RegionCode` (via `regionForGeoTargets`). Campaigns
  targeting multiple regions or with empty `geo_targets` are ineligible.
  Merchants running purely **national** campaigns get **no suggestions** — the
  feature has nothing to reallocate *between*. Accepted MVP limitation.
- **Google-campaign-only in practice.** `geo_targets` is populated only for
  Google campaigns (`geoTargetConstants/<id>` resource names) and for seeded
  demo shops (`RegionCode` literals). Meta and TikTok transforms write
  `geo_targets: []`, so their campaigns are never geo-attributable and cannot be
  a source or dest. `regionForGeoTargets` therefore accepts two input forms:
  `RegionCode` literals (seed) and Google geoTargetConstants (live). A move
  requires **both** source and dest to resolve to a single region.
- **Opt-in, default OFF** (`weather_sensitivity = 0`) → zero regression, no
  surprise money moves for any existing shop.

## Error handling & integrity (fail visibly — never fabricate)

- Open-Meteo timeout/error → skip that shop's run, log it, **write nothing**.
  Never synthesize or stale-fill a forecast.
- Campaign with no clean single-region mapping → ineligible; counted in the cron
  summary's `skipped` tally (not silently dropped).
- Idempotency: **one row per (shop, suggested_on, source_campaign, dest_campaign)**
  via a unique constraint + upsert. A re-run the same day updates in place, never
  duplicates.
- `weather_sensitivity = 0`, guardrail cap 0, or no eligible source spend →
  clean no-op (no rows written).
- Sizing caps are applied in the **suggester** (see Sizing above); the Approve
  route does not re-gate through autopilot guardrails (deliberate — matches the
  manual reallocate path). `executeReallocation` re-validates ownership + that
  the move leaves the source budget positive at click time.
- Approving a stale/already-applied suggestion is rejected (status must be
  `pending` → else 409); `executeReallocation`'s deterministic
  `idempotencyKey = "weather:" + suggestionId` is the final replay backstop.

## Testing (behavior, not coverage theater)

- `score.ts` (pure): cold+rain region outranks warm+clear; score monotonic in
  each factor (↑precip → ↑score, ↓temp → ↑score, ↓daylight → ↑score);
  normalization keeps values in [0,1]; ties handled.
- `weather-reallocation-suggest.server.ts`: correct source/dest selection;
  national/multi-region campaigns skipped; guardrail caps respected;
  `weather_sensitivity = 0` → empty; no eligible source spend → empty.
- Cron upsert idempotency: second same-day run → no duplicate rows (unique
  constraint holds).
- Apply route: success → `executeReallocation` called + row `applied`;
  non-pending row → 409; wrong-shop suggestion id → 404; dismiss → row
  `dismissed`, no reallocation.
- Sizing (pure): `scoreGap < 0.15` → skipped; amount clamped below source
  budget; `weather_sensitivity = 0` → amount 0 → skipped.
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
4. **Google-only reach** (see Eligibility): until Meta/TikTok ingest starts
   populating `geo_targets`, only advertisers running region-split Google
   campaigns (or seeded demo shops) see any suggestions. Adding Meta/TikTok geo
   ingest is the highest-leverage way to widen reach later.

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

1. Migrations: `weather_suggestion` table + `weather_sensitivity` column on
   `guardrail_config` (default 0).
2. Ship weather lib + suggester + cron behind the default-OFF knob (no shop
   affected until they opt in).
3. Add the Segments panel + Approve/Dismiss route + client function.
4. Add the `GuardrailField` UI row so a merchant can enable + tune it.
5. Dogfood on one geo-segmented test shop: set `weather_sensitivity > 0`, run the
   cron, confirm suggestions render in the Segments panel with correct
   narratives, and that Approve triggers a real reallocation (audit row written).

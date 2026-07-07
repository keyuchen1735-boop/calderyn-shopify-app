# Weather Demand Signal v2 — re-home onto the action spine (Phase 1)

Date: 2026-07-07
Status: Design (awaiting review)
Owner: John
Related: `app/lib/weather/*`, `app/lib/actions/weather-suggest.server.ts`, the alert/deck/calibration spine

## 1. Context

A weather feature already ships and works (landed 2026-07-06). A daily cron pulls a
3-day Open-Meteo forecast for four coarse US regions, scores each region for
demand-favorability, picks the worst-weather region and the best-weather region,
sizes a daily ad-budget move between the two biggest single-region campaigns, and
writes a `weather_suggestion` row. The merchant sees it in **Customers -> Weather**
and clicks Approve or Dismiss; approving performs a real, concurrency-safe,
idempotent budget reallocation. A `weather_sensitivity` dial in Settings gates and
sizes it.

The plumbing is solid. The problem is that the feature is a **bespoke island**: it
has its own table, cron, apply/dismiss route, Settings dial, and UI tab, and it
does not ride the generic spine every other smart action uses:

```
detector -> alerts (+ alert_context) -> v_alerts_view -> fetchOpenAlerts
   -> Alerts screen
   -> Home deck (queue.list)
   -> Autopilot -> guardrails -> executeAction -> action_audit.reward_signal
        -> pair_calibration (trust + dollar outcomes -> graduation to hands-off)
```

Because weather is off this spine, it has two concrete gaps this spec closes:

1. **Almost nobody sees it.** Two causes: (a) suggestions are buried in a Customers
   tab instead of the Home deck where merchants triage, and (b) suggestions rarely
   exist at all, because the ad mover requires two or more single-region campaigns
   with budgets, which most stores do not have.
2. **It never proves it worked.** Approving moves budget, then silence. No dollar
   outcome is recorded, which is out of step with the platform's outcome-gated
   design.

A third gap, that the favorability score may point the wrong direction for many
stores (the research on asymmetric weather effects), is explicitly **out of scope**
for this phase. The outcome loop this phase adds is what will reveal empirically
whether the score needs correcting, so we measure before we rewrite.

## 2. Goals and non-goals

### Goals (Phase 1)

- **Visibility.** Weather suggestions surface in the **Home deck and Alerts screen**
  like every other action, by writing them as `weather_demand` alerts.
- **Activation.** Weather becomes useful to stores without geo-split campaigns by
  adding an **inventory restock/relocation** consumer keyed off regional demand and
  days-of-cover.
- **Proof.** Weather actions run through the **generic proposal -> executeAction ->
  autopilot** path so that (a) merchant approvals accrue trust signals and (b) once
  graduated, autopilot executes autonomously and `reward_signal` records the dollars
  earned or lost.
- **Consolidation.** Retire the bespoke `weather_suggestion` table, apply/dismiss
  route, and Customers -> Weather tab.

### Non-goals (deferred)

- Rewriting the favorability score for the research-backed asymmetry. Deferred until
  outcome data justifies it.
- Storefront merchandising / weather product-boosting (Phase 2).
- Finer-grained or global geo. The four-bucket US model is carried unchanged and
  documented as a known limitation.
- Any change to the frozen Shopify embedded app.

## 3. Architecture

One shared signal, two consumers, all on the existing spine.

```
cron.weather-suggest (daily)
  |
  |-- fetchRegionForecasts (Open-Meteo, existing)
  |-- signal: per-region demand favorability + gating (existing score, unchanged this phase)
  |
  |-- for each shop with weather_sensitivity > 0:
  |     |
  |     |-- AD consumer (existing logic, re-homed):
  |     |     rank regions -> size reallocate_budget move
  |     |     -> write alert(detector_id='weather_demand', entity_ref={campaign_id,...},
  |     |                     action params via evidence) + alert_context
  |     |
  |     |-- INVENTORY consumer (new):
  |           cross region favorability with v_sku_regional_demand days-of-cover
  |           -> if a suppressed-demand region has surplus and another region is short:
  |                write alert(detector_id='weather_demand', entity_ref={sku_id,...})
  |                action = reallocate_inventory (reward-eligible)
  |           -> else if genuinely short everywhere and reorder makes sense:
  |                action = create_po_draft (activation only, no dollar reward)
  |
  v
alerts (+ alert_context)  ->  Home deck + Alerts  ->  approve (trust) or, once graduated, autopilot (dollars)
```

Nothing about the forecast fetch, the region model, the favorability score, or the
`executeReallocation` executor changes in behavior this phase. What changes is
**where suggestions are written** (alerts instead of `weather_suggestion`) and
**how they execute** (the generic path instead of the bespoke route).

## 4. Components

### 4.1 `app/lib/weather/signal.server.ts` (new, thin)

Purpose: given the region forecasts and a shop's eligible entities, produce the set
of proposed weather actions for that shop, as plain data ready to be written as
alerts. This is the seam that both consumers share.

- Input: `Map<RegionCode, RegionForecast>` (from `fetchRegionForecasts`), the shop's
  eligible campaigns (`loadGeoSegmentedCampaigns`, existing) and regional SKU demand
  rows (`v_sku_regional_demand`).
- Output: `WeatherAlertDraft[]`, each carrying `detectorId='weather_demand'`,
  `entityRef`, `severity`, `dollarImpact`, `narrative`, `actionKind`, and the
  `params` the executor needs (campaign ids or sku id + amount).
- Depends on: `score.ts` (`favorability`, unchanged), `regions.ts`,
  `inventory-demand.ts` (`demandFromRow`, days-of-cover helpers).

The existing `buildSuggestion` in `weather-suggest.server.ts` is refactored into this
module as the ad-consumer branch; its ranking and sizing logic is preserved verbatim.

### 4.2 `app/lib/weather/alert-writer.server.ts` (new)

Purpose: write a `WeatherAlertDraft` to the database as a real alert the deck and
autopilot accept. This exists as its own unit because the one existing TS alert
writer (`detect-free-ship-leakage.server.ts`) has a schema mismatch we must not copy.

- Copies the canonical column contract from `engine/calderyn_engine/alerts_repo.py`:
  upsert into `alerts (shop_id, detector_id, entity_ref, severity, dollar_impact,
  day_bucket, claude_narrative, claude_rank, first_seen_at, last_seen_at)` with
  `onConflict: 'shop_id,detector_id,entity_ref'` (the live partial-unique dedup key,
  scoped to active statuses), then upsert `alert_context (alert_id, shop_id,
  evidence)` with the action params and forecast drivers.
- `entity_ref` carries `title` plus `campaign_id` or `sku_id` so `v_alerts_view` can
  resolve a human name.
- Idempotent by construction: a second run the same day updates `last_seen_at`
  rather than creating a duplicate, because the dedup key excludes `day_bucket`.

### 4.3 Rebuilt `app/routes/cron.weather-suggest.tsx`

Purpose: unchanged responsibility (daily, authorized, iterate shops with
`weather_sensitivity > 0`, bounded concurrency), new body. For each shop it calls the
signal module and writes each resulting draft via the alert writer, instead of
upserting `weather_suggestion`. Fail-closed on Open-Meteo error stays: a shop whose
forecast fetch fails is skipped, never acted on with a fabricated forecast.

### 4.4 Registration (the spine's contract)

For a `weather_demand` alert to render a real card and be reward-eligible, register:

- `DetectorId` union in `app/lib/types.ts`: add `weather_demand`.
- `DETECTOR_TO_ACTIONS` in `app/lib/labels.ts`: map `weather_demand` to
  `[reallocate_budget, reallocate_inventory, create_po_draft, snooze_alert]` (the
  card offers the action carried in that alert's evidence).
- `DETECTOR_LABELS` and `DETECTOR_TERMS` in `app/lib/labels.ts`: plain-language label
  and hover term, per the repo's terminology rule.
- `GRADUATABLE` in the calibration layer: add the `weather_demand` pairs so the
  action can graduate to autonomous once trusted.
- `HAS_UNDO_BRANCH` in `app/lib/calibration/undo-branches.ts`: mark the reversible
  weather action kinds so graduation is scored correctly.

No new `ActionKind` is introduced: weather reuses `reallocate_budget`,
`reallocate_inventory`, and `create_po_draft`, whose executors already exist.

### 4.5 Retirements

- `weather_suggestion` table: stop writing. Keep the table for historical rows or
  drop it in the migration (decision in section 6).
- `app/routes/dashboard.api.weather-reallocation.tsx`: remove. Weather approvals now
  go through the standard alert action flow (`executeAction`, `one-click.ts`).
- Customers -> Weather tab in `app/components/dashboard/screens/Customers.tsx`:
  remove. Weather now lives in the deck and Alerts. `WeatherSuggestionDTO`, the
  customers-loader `loadWeatherSuggestions`, and the client wrapper are removed.
- `weather_sensitivity` dial in Settings stays: it still gates the cron and sizes
  the ad move magnitude.

## 5. The autonomy and reward lifecycle

This is the mechanism that closes "prove it worked", and it is worth stating
explicitly because it constrains the design.

- The reward engine (`engine/calderyn_engine/moat/persist_action_rewards.py` and the
  `*_reward_inputs.py` kernels) computes `action_audit.reward_signal` **only for
  actions with `actor_user_id='autopilot'` and `outcome='succeeded'`**. Merchant
  approvals never get a dollar reward computed. The computation is generic across
  `detector_id` and gated on `action_kind`.
- `reallocate_budget` (campaign path: before/after ROAS + profit delta) and
  `reallocate_inventory` (SKU path: unit-margin/units) are already registered reward
  kinds. A `weather_demand` alert using either gets its dollars computed with no
  engine change, provided the executed action's `params` carry `campaign_id` or
  `sku_id` respectively.
- `create_po_draft` earns no reward (not a reward kind, and merchant-collected rather
  than autopilot-executed). It is an activation-only fallback.

Lifecycle for a weather action:

| Stage | Executor | Actor | Proof produced |
| --- | --- | --- | --- |
| Trust-building | merchant approves in deck | `merchant` | clean-approval and no-undo trust signals |
| Graduated | autopilot autonomous | `autopilot` | `reward_signal` dollar outcome -> calibration |

Dollar-proof therefore arrives only after graduation, which is the same lifecycle
every other graduatable action follows. Before graduation the merchant still sees the
suggestion, still approves it, and still builds the trust record that leads to
graduation.

## 6. Data model changes

- No new columns on `alerts`; it already has everything (verified: required insert
  columns are `shop_id`, `detector_id`, `entity_ref`, `day_bucket`).
- No new columns on `alert_context`; `evidence jsonb` carries action params and
  forecast drivers.
- Migration: decide keep-vs-drop for `weather_suggestion`. Recommendation: **keep the
  table but stop writing to it** for one release (so any in-flight pending rows can be
  inspected), then drop in a follow-up. The `weather_suggestion_status_states`
  constraint and indexes are untouched by this phase.
- `guardrail_config.weather_sensitivity` unchanged.

## 7. Error handling and idempotency

- Open-Meteo failure: skip the shop (existing fail-closed behavior preserved).
- Alert write idempotency: the `(shop_id, detector_id, entity_ref)` active dedup key
  means re-running the cron the same day refreshes `last_seen_at` rather than
  duplicating. `entity_ref` must be stable per logical suggestion (for example keyed
  by the source and dest campaign ids, or the sku id) so re-runs collapse correctly.
- Execution idempotency: unchanged. `executeAction` already guards replays via
  `action_idempotency`, and autopilot serializes per shop with a lock.
- A weather alert whose underlying entity has changed (campaign paused, stock moved)
  is re-validated at execute time by the existing executors, which leave source
  budget positive and re-check ownership.

## 8. Testing

Pure unit:

- `signal.server` ad branch reproduces the current `buildSuggestion` output for the
  same inputs (a characterization test locking behavior through the refactor).
- `signal.server` inventory branch emits a `reallocate_inventory` draft only when a
  suppressed-demand region has surplus and another region is short on cover, and
  falls back to `create_po_draft` only when nothing can be relocated.
- `alert-writer` produces a payload whose columns are exactly the `alerts` /
  `alert_context` schema (guard against the free-ship-writer class of bug); assert no
  stray non-columns and that `day_bucket` is present.

Integration:

- Cron writes a `weather_demand` alert plus its `alert_context`, and the row surfaces
  through `v_alerts_view` / `fetchOpenAlerts` with a resolved title and narrative.
- `queue.list` renders the alert as a deck card with the correct action.
- Sizing: the ad move still respects `weather_sensitivity` and leaves source budget
  positive; the inventory move respects available surplus.

Registration:

- `weather_demand` has entries in `DETECTOR_TO_ACTIONS`, `DETECTOR_LABELS`,
  `DETECTOR_TERMS`, `GRADUATABLE`, `HAS_UNDO_BRANCH`; a test asserts the detector is
  in the calibration weight universe (not snooze-only), so it can graduate.

## 9. Known limitations (carried, not fixed this phase)

- Four coarse US regions, one forecast point each. Global and finer geo deferred.
- Favorability score direction unchanged; may be wrong for some catalogs. The outcome
  loop is the instrument that will tell us, per store, whether it is.
- `create_po_draft` weather nudges produce no dollar reward by design.

## 10. Open verification points for the implementation plan

These are confirmed enough to design against but must be nailed down in the plan:

1. **Autopilot candidacy.** Confirm a `weather_demand` alert surfaces in
   `v_autopilot_candidates` and that autopilot's routing dispatches the weather
   action kinds to the right executors (it dispatches by `action_kind`, and the
   executors exist, but the routing branch must be verified or added).
2. **`create_po_draft` in the deck.** Confirm a non-autopilot, merchant-collected
   action renders and completes cleanly through the standard card flow (it will never
   graduate, which is intended).
3. **Keep-vs-drop** decision for `weather_suggestion` finalized with the team.

## 11. Phasing beyond this spec

- Phase 2: storefront merchandising (weather product-boost at the
  `catalog.owned.server.ts` `listProducts` ordering choke point, driven by a
  per-product category-relevance signal from `product_dim.category` / `tags`).
- Phase 3 (conditional on outcome data): rewrite the favorability score for the
  research-backed asymmetry (good weather as the strong suppressor) and per-store
  direction.

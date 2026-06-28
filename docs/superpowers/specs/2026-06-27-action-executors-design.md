# Design: Wire two missing action executors (create_po_draft quick-approve + exclude_geo)

Date: 2026-06-27
Status: Approved (design), pending spec review
Branch / worktree: `feat/action-executors` / `../calderyn-action-executors`

## Problem

Two merchant actions surface in the "Needs You" / Action Queue but fail when the merchant clicks Approve:

1. **`create_po_draft`** (detectors `reorder_timing`, `scaling_sku_fulfillment_risk`): the executor (`app/lib/actions/po-action.server.ts`) requires an order `quantity`, but the one-click Approve sends none, so it 422s with "Order quantity must be a positive whole number." The quantity only exists as a typed field on the alert detail page.

2. **`exclude_geo`** (detectors `regional_spend_starved_stock`, `sku_stockout_vs_spend`): the kind is listed in `DETECTOR_TO_ACTIONS` (`app/lib/labels.ts`) and is offered as the recommended action, but **no executor exists anywhere**. Approve 422s with "This action can't be run automatically yet." There is no `ActionAdapter` method, no `executeAction` branch, and no platform implementation.

Both are real product gaps, not seed-data issues (they fail the same way on the seeded showcase store).

## Goals

- `create_po_draft` one-click Approve succeeds with a sensible, auto-computed reorder quantity that the merchant can still adjust on the detail page.
- `exclude_geo` becomes a real, wired action that removes a region from a campaign's ad targeting on the live platform (Meta, Google, TikTok), with demo_mode simulation, audit, idempotency, and undo, following the existing pause/budget executor pattern.
- Both changes mirrored into the Calderyn dashboard action path (parity rule in CLAUDE.md).

## Non-goals

- No change to which detectors recommend which actions (`DETECTOR_TO_ACTIONS` stays as-is).
- No new detectors or alert evidence shapes from the engine. We consume the evidence that already exists.
- No geo granularity finer than the existing internal region buckets (`us-west`, `us-east`, `us-south`, `us-central`).

## Feature A: create_po_draft suggested quantity

### Behavior
The reorder alert evidence already carries `daily_velocity_units`, `lead_time_days`, and `days_of_cover`. Compute a target-cover reorder quantity so the merchant lands enough stock to cover the lead time plus a safety buffer:

```
suggestedReorderQty(ev) =
  max(1, ceil(daily_velocity_units * (lead_time_days + COVER_BUFFER_DAYS - days_of_cover)))
```

`COVER_BUFFER_DAYS` is a single named constant (proposed 14). If any input is missing or non-positive, fall back to `max(1, ceil(daily_velocity_units * lead_time_days))`; if velocity is also unusable, the quantity cannot be auto-suggested and the card routes the merchant to the detail page instead of submitting (no phantom).

### Code
- New pure helper `app/lib/actions/reorder-qty.ts` exporting `suggestedReorderQty(evidence: Record<string, unknown>): number | null`. Pure, unit-tested, no IO.
- Embedded approve path (`app/routes/app.alerts.$id.tsx`, and the queue/Needs-You approve handler that submits `create_po_draft`) computes the quantity from `alert.evidence` and passes it to `executeCreatePoDraft` when the merchant did not type one. A typed quantity always wins.
- Unit cost stays optional ("" = TBD), unchanged.

### Tests
- `reorder-qty.test.ts`: normal case, missing fields fallback, zero/negative velocity returns null, rounding, floor at 1.
- Approve-handler test: one-click create_po_draft with no typed quantity succeeds using the suggested value; a typed value overrides it.

## Feature B: exclude_geo real executor

### Adapter contract
Extend `ActionAdapter` (`app/lib/ads/actions.ts`):

```
excludeGeo(externalId: string, region: RegionCode): Promise<void>
includeGeo(externalId: string, region: RegionCode): Promise<void>   // undo
```

`RegionCode` is the existing internal bucket union (`"us-west" | "us-east" | "us-south" | "us-central"`).

### Executor wiring
`app/lib/actions/execute.server.ts` gains an `exclude_geo` branch:
- Resolve the campaign (ownership-checked, as today).
- Read `region` from the alert evidence (`entity_ref.region`, falling back to `alert_context.evidence.region`). Missing region fails visibly (no phantom).
- `pre_state` / `post_state` record the excluded region so undo can reverse exactly what changed.
- Resolve the adapter via `actionAdapterForShop`; call `adapter.excludeGeo(externalId, region)`.
- Idempotency, audit row, retry classification: identical to pause/budget.
- Undo: a reversal audit calls `adapter.includeGeo(externalId, region)`.

`exclude_geo` is added to `ExecutableKind` and the kind dispatch.

### Region to platform-geo mapping
New `app/lib/ads/geo-regions.ts`:
- `REGION_STATES: Record<RegionCode, UsState[]>` — canonical region to US state list (the single source of truth).
- Per-platform translation tables:
  - Meta: state to Meta region key (e.g. `US:CA`).
  - Google: state to `geoTargetConstant` numeric id.
  - TikTok: state to TikTok `location_id`.
- Pure, table-driven, unit-tested. Building the three state-id tables (50 states x 3 platforms) is part of the work and lives entirely in this file.

### Per-platform implementations
| Platform | Where targeting lives | Implementation |
|---|---|---|
| Google | Campaign criterion (campaign-level) | One `CampaignCriterion` mutate adding negative `LocationInfo` for each geoTargetConstant in the region. Simplest, fully campaign-scoped. **Phase 1.** |
| Meta | Ad-set targeting | Fan out over the campaign's ad sets: GET each `targeting`, merge `excluded_geo_locations.regions`, POST. **Phase 2.** |
| TikTok | Ad-group targeting | Fan out over the campaign's ad groups: exclude the region's `location_ids`. **Phase 2.** |

`includeGeo` reverses each (remove the negative criterion / drop from `excluded_geo_locations` / drop the excluded location_ids).

### Demo + parity
- `showcaseActionAdapter` (`app/lib/demo/showcase.server.ts`) gets `excludeGeo`/`includeGeo` as no-op successes, so demo_mode stores approve cleanly.
- Dashboard action path mirrors the `exclude_geo` branch and suggested-quantity logic (match the contract, re-implement on the dashboard's stack, do not copy Polaris).

### Tests
- `geo-regions.test.ts`: every region maps to a non-empty state list; every state resolves to a geo id on each platform (no gaps).
- `execute.server` test: `exclude_geo` builds the right pre/post state, calls `adapter.excludeGeo`, records audit, is idempotent, and undo calls `includeGeo`.
- Per-platform adapter tests with mocked clients: Google criterion mutate body, Meta ad-set fan-out merge, TikTok ad-group fan-out.

## Phasing

- **Phase 1 (unblocks the demo, ships verified):** Feature A in full; Feature B interface + executor wiring + demo no-op + Google real implementation + region/state/Google-id tables. After Phase 1, every "Needs You" card approves: demo stores via simulation, real Google-connected shops for real.
- **Phase 2:** Meta and TikTok real implementations + their state-id tables, with the ad-set / ad-group fan-out.

Each phase is independently shippable behind the same wired executor.

## Verification reality

- Everything is unit-testable with mocked platform clients and runs in the pre-commit gate.
- A true live check of the real platform calls needs a connected ad account with live campaigns. calderyn-test is demo_mode (simulated) and shop-tester's ad accounts were disconnected. Live verification of Phase 1 Google (and Phase 2 Meta/TikTok) requires reconnecting a real ad account first; flagged, not assumed.

## Risks

- Writing to live ad targeting is consequential. Mitigations: ownership checks (existing), exact-reverse undo, permanent-vs-transient error classification (existing `ActionError` pattern), and no auto-act for these pairs unless graduated.
- Region-to-geo-id tables can have gaps. Mitigation: a test asserts full coverage so a missing mapping fails the build, never silently no-ops.

## Pre-commit gate

Standard CLAUDE.md gate before any commit: `/code-review`, patch sanity, `npm run typecheck`, `npm run lint`, `npm run build`, plus targeted vitest for the new files. No commit until green, evidence pasted.

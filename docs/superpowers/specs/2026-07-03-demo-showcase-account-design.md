# Demo showcase account + resettable demo shop — design

**Date:** 2026-07-03
**Status:** approved-by-request (built autonomously from John's ask; decisions recorded below)
**Surfaces:** first-party dashboard + tenant storefront only. No embedded-admin mirror — the
embedded surface has no first-party login, so this is dashboard-only *by design* (same
precedent as Calderyn Labs).

## What John asked for

A shared demo login (john@calderyncompany.com — John, Kenneth, Eric all use it) backed by a
fully seeded fake store with a real visitable storefront, good enough to screen-share:
approve/deny engine proposals, watch calibration rise, enable autopilot and see it act,
create a product, browse customers — plus a Settings button (demo account only) that resets
the whole demo back to its opening state so every demo starts like a live user session.

## Decisions (with alternatives considered)

1. **New dedicated first-party shop, not calderyn-test or calderyn-review-store.**
   Both existing demo shops carry load-bearing state (calderyn-test is the staged `dual_run`
   cutover-rehearsal + Google-demo-video store). A reset button that wipes shop-scoped rows
   must never point at them. The demo shop is a pure first-party shop
   (`shop_domain = NULL`, `org_slug = 'peakandpine'`), so it also demos the platform-pivot
   story — no Shopify anywhere in the loop.
2. **Identity: "Peak & Pine Outfitters".** The repo already ships a deterministic seed
   dataset for exactly this fictional DTC outdoor brand (`app/lib/seed/dataset.ts`) with
   detector scenarios embedded (stockout-while-ads-spend, margin erosion, hidden return
   losses, regional shortage…). The demo shop *is* Peak & Pine.
3. **Reset = deterministic regenerate, not snapshot-restore.** The dataset is generated
   relative to an anchor day, so after any reset the store's last order is always "today" —
   a snapshot would age and look dead. Reset and first-time setup run the same code path.
4. **Seed alerts directly instead of waiting for the engine scan.** The queue must be full
   the moment a demo starts. Seeded alerts mirror the engine's evidence contract
   (`alerts` + `alert_context.evidence`), keyed on the dataset's scenario SKUs/campaigns.
   The engine's unique key `(shop_id, detector_id, entity_ref, day_bucket)` dedupes any
   overlap when the real engine also scans the seeded facts.
5. **demo_mode = true, org_mode = 'live'.** `demo_mode` flips the existing showcase seam:
   external side effects (Meta/Google/TikTok, Shopify inventory) are simulated; everything
   internal (audit rows, calibration math, alert acks, undo tokens) is real. `org_mode='live'`
   makes owned-write actions (price changes, inventory moves) hit the owned tables for real —
   which is what we want visible in the demo. Column set directly by the seed (the demo shop
   never does a cutover ceremony).
6. **One shared credential.** Single `users` row + `membership(owner)` to the demo shop.
   John explicitly does not care about per-person accounts or security here. Password is
   generated at setup, stored in `.env.local` (`DEMO_ACCOUNT_PASSWORD`), and reported once.

## Architecture

```
scripts/setup-demo-account.ts      one-time: user + shop + membership + domain notes
        └── app/lib/demo/reset.server.ts   resetDemoShowcase(shopId, sb)
                ├── wipe: extended child→parent list (see below)
                ├── writeSeedDataset(generateSeedDataset(...))     [existing]
                ├── rpc promote_shop_from_mirror(shopId)           [existing]
                └── seedOwnedShowcaseLayer(...)                    [new: app/lib/demo/showcase-seed.ts]
app/routes/dashboard.api.demo-reset.tsx    POST, demo_mode-gated → resetDemoShowcase
app/components/dashboard/screens/Settings.tsx   "Demo" card, demo shops only → confirm → POST
```

### New pure generator: `app/lib/demo/showcase-seed.ts`

Pure (no I/O, anchor-day injected) like `dataset.ts`, so it's unit-testable. Produces:

- **sku_dim enrichment**: the existing `SkuRow` lacks `retail_price_cents` /
  `product_status` / `inventory_tracked`; `promote_shop_catalog` copies these into
  `variant_dim`, and a NULL price renders "not for sale" on the storefront. The seed rows
  get prices from the dataset's `listPriceCentsBySkuId`, `product_status='active'`,
  `inventory_tracked=true`. (Additive columns on insert — no change to existing callers.)
- **Buyer spine + owned orders**: ~28 `buyer_dim` buyers (name-derived emails), owned
  `orders` (+ `order_line`, `order_state_transition`) spread over the last 45 days in
  terminal states, linked to buyers — populates the Customers directory and its
  detail/order views. (Warehouse `order_fact` history stays the analytics source; owned
  orders are the commerce spine the Customers screen reads.)
- **Seeded alerts**: 8–10 `alerts` (status `open`) + `alert_context.evidence` matching each
  scenario SKU/campaign, shaped after real prod evidence rows per detector so the approve
  executors are runnable (evidence contract, not invented shapes).
- **Calibration baseline**: `pair_calibration` rows — most pairs mid-progress, 1–2 pairs
  near graduation (an approval or two graduates them live on screen), 2 pairs already
  `graduated + autonomy_enabled` so flipping autopilot ON mid-demo executes immediately
  (`dashboard.api.autopilot` fires a run on dashboard load; cron every 30 min otherwise).
  `shops.calibration_pct` reset to the low baseline.
- **Audit history**: a handful of past `action_audit` rows (`succeeded`, actor autopilot +
  merchant) so the audit view isn't empty at demo start.
- **Store branding**: `store_settings` row (Peak & Pine name, palette, tagline);
  `variant_shipping` defaults so quotes work; guardrail_config reset with
  `autopilot_enabled=false` (they switch it on during the demo).

### Reset wipe surface (extends `WIPE_ORDER`)

Everything demo activity can write, children→parents, all `.eq(shop_id)` deletes:
existing `WIPE_ORDER` (audit/alerts/facts/sku_dim/location_dim) **plus**
`undo_token, action_feedback, alert_feedback, alert_thresholds, calibration_rule,
pair_calibration, autopilot_run_lock, campaign_direction_reason, purchase_order_draft,
sku_reorder_belief, creative_screen_run, campaign_draft, assistant_messages,
assistant_conversations, cart_line, cart, checkout_session, order_state_transition,
order_line, orders, payment_intent, storefront_event, commerce_quote_fact,
inventory_reservation, inventory_transfer, inventory_ledger, inventory_balance,
buyer_address, buyer_consent, buyer_dim, product_media, variant_option_value,
product_option_value, product_option, product_collection, collection_dim,
variant_shipping, variant_dim, product_dim, import_map, import_run`
and column resets on `shops` (`calibration_pct`, `calibration_updated_at`) +
`guardrail_config` autopilot fields.

**Safety:** `resetDemoShowcase` re-reads `shops.demo_mode` inside the call and throws
unless it is `true` — the wipe is unreachable for real shops even if the route gate
regressed. The API route additionally requires a first-party session (`userId` set).

### API route: `dashboard.api.demo-reset.tsx`

Canonical skeleton (`requireSameOrigin` → `requireDashboardSession` → method guard →
mutate → `dashboardJson`). Returns the writer summary (tables wiped / rows inserted).
Rate-limited (1 per minute per shop) — resets take seconds and double-clicks shouldn't
race two wipes.

### Settings UI

A "Demo" `SettingsCard` in the General tab, rendered only when the shell context says the
shop is a demo shop (new `demoMode` boolean threaded through the existing bootstrap
payload). Button copy: "Reset demo data" with `DANGER:`-tone description matching the
existing convention, two-step confirm (same pattern as existing destructive controls),
busy state, success toast with row summary, then `app.refresh()`.

### Account + storefront provisioning (one-time, on prod)

`scripts/setup-demo-account.ts` (vite-node, `.env.local` env — pepper must match prod,
verified by a live login test): `createUser` → `provisionOwnedShop("Peak & Pine
Outfitters")` → override `org_slug='peakandpine'` → `linkMembership(owner)` →
`markEmailVerified` → set `demo_mode=true, org_mode='live', onboarding complete` →
`resetDemoShowcase`. Storefront reachable at `peakandpine.calderyncompany.com` (wildcard
DNS live) once `vercel domains add` runs; `peakandpine.vercel.app` as backup alias.
Product photos: generated once, uploaded to the media storage bucket, `product_media`
rows re-linked by every reset (assets themselves are never wiped) — best-effort polish
step, storefront renders cleanly without them.

## Error handling

- Seed writer aborts on first error (existing rule-12 behavior); a failed reset leaves an
  obviously-broken half state and the button can simply be pressed again (wipe-first makes
  the whole operation idempotent).
- Route maps failures to `dashboardJson` 500s with the writer's table-level error message.

## Testing

- Unit (vitest, patterned on `app/lib/seed/__tests__`): generator determinism, FK
  integrity (every owned order line → seeded variant; every alert evidence → scenario
  SKU/campaign), evidence shape per detector, wipe-order children-before-parents check
  against the FK graph, reset refuses non-demo shops.
- Live verification on prod (testing-on-prod is the norm): login via curl, queue approve,
  calibration read, autopilot toggle + run, storefront 200 with products, reset round-trip.

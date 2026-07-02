# Dual-run drift report (platform pivot, Step 9 follow-on)

Date: 2026-07-01
Status: approved (handoff item 1, HANDOFF-mvp-next-session-2026-07-01)
Surfaces: Calderyn dashboard only (owned-platform surface, per cutover precedent; no embedded-admin mirror)

## Problem

The go-live parity gate (`app/lib/cutover/go-live.server.ts`) checks id-level linkage only:
every Shopify-originated owned row is bridged through `import_map`, the sku_dim projection
matches, and stock records exist. It never compares values. During `dual_run`, the owned
source of truth (`variant_dim.retail_price_cents`, `inventory_balance`) can silently drift
from the real Shopify store when writes happen outside the mirrored executors, most commonly
a merchant editing a price or stock level directly in Shopify admin:

- `PRODUCTS_UPDATE` webhooks are acknowledged and dropped (`applyProduct` in
  `app/lib/ingest/transform.server.ts`), so a Shopify price edit never reaches the owned catalog.
- `INVENTORY_LEVELS_UPDATE` webhooks only append to the analytics stream
  (`inventory_level_fact`), never to `inventory_balance`.
- Products created in Shopify after the import are invisible to Calderyn entirely.

Without a value-level check, "Dual run: confirm everything matches" is a promise the product
cannot keep. This feature makes dual_run verifiable before the merchant goes live.

## Approaches considered

1. **Live Shopify sweep at check time (chosen).** Reuse the existing import pull
   (`fetchProducts` in `app/lib/ingest/shopify-admin.server.ts`, which already yields variant
   price and per-location available quantities) and diff against the owned tables on demand.
   Compares against the actual current Shopify store, needs no schema change and no new
   ingest path. Cost is one paged Admin API sweep per button click, fine at pilot scale
   (25 products/page).
2. **Mirror-based compare.** Rejected: `inventory_level_fact` is a mixed stream (owned writes
   project into the same table with no source column, so a Shopify-side change can be masked),
   and there is no maintained price mirror at all since Slice 1 retired the product mirror.
3. **New webhook-fed drift mirror tables.** Rejected: schema plus ingest complexity, and it
   still misses anything that does not emit a webhook. Overkill for a pre-live verification
   report.

## Design

### Module: `app/lib/cutover/drift.server.ts`

`checkDualRunDrift(shopId): Promise<DriftReport>`

1. Resolve `shops.shop_domain`. It is nullable since first-party auth: a null domain means
   a native Calderyn shop with no Shopify side, answered as CalderynError 409
   `not_connected` (permanent state, not a transient failure).
2. Load bridges from `import_map` (entity_type `variant` and `location`): `external_id` (GID)
   to `owned_id`. All owned reads go through the shared `pagedRows` helper
   (`app/lib/cutover/paged.server.ts`, extracted from go-live's pagedIds so the two modules
   share one PostgREST-truncation backstop).
3. Load owned values, paged: `variant_dim` (id, sku, title, retail_price_cents, with the
   product title riding along as a PostgREST embed `product:product_dim(title)`) and
   `inventory_balance` (variant_id, location_id, on_hand, unavailable). Labels use the
   shared `buildSkuTitle` vocabulary plus the sku.
4. Sweep `fetchProducts(shopDomain)`. Only the transport (`iterator.next()`) is wrapped in
   try/catch: a failing page fetch becomes CalderynError 502 `shopify_unreachable` (logged
   via console.warn), while a bug in the compare logic stays an unwrapped 500. For each
   Shopify variant that has a bridge:
   - **Price**: Shopify `price` converted to cents vs `retail_price_cents` (owned null is
     treated as 0 cents). A Shopify-null price skips the compare.
   - **Stock**: only when `inventoryItem.tracked`. For each inventory level at a bridged
     location: Shopify `available` vs owned sellable, where sellable =
     `max(0, on_hand - unavailable)` (the same projection the engine reads via
     projectLevelFact; a missing `inventory_balance` row counts as 0). Transient checkout
     reservations do not decrement either side until commit, so in-flight checkouts cannot
     fake drift; the UI still advises re-checking on small deltas.
   - Levels at unbridged locations increment an `unmatchedLocations` counter (visible, never
     silently skipped).
5. Unbridged Shopify variants on ACTIVE products are collected as `shopifyOnly` (created in
   Shopify after the import; drafts/archived cannot sell and are ignored). Owned variants
   with no bridge are native Calderyn products and are NOT drift.
6. The reverse direction: bridged owned variants the sweep never returned (deleted or hidden
   in Shopify during dual run) are counted as `ownedOnly`.
7. `fetchProducts` caps nested lists at one page (variants first:40, inventoryLevels
   first:20). A product whose list sits AT a cap may have been cut, so it is counted in
   `truncated` rather than treated as fully verified — `pass` never overstates coverage.

Report shape (all counts exact for what the sweep can see, and what it cannot see is itself
counted; detail rows capped at 50 per list with the total kept, samples at 10):

```ts
interface DriftRow {
  variantId: string;        // owned variant_dim.id
  label: string;            // buildSkuTitle(product, variant) + " (sku)"
  locationId?: string;      // stock rows only
  owned: number;            // cents or units
  shopify: number;
}
interface DriftReport {
  variantsChecked: number;
  pass: boolean;            // every count below is 0
  price: { count: number; rows: DriftRow[] };
  stock: { count: number; rows: DriftRow[] };
  shopifyOnly: { count: number; sample: string[] };
  ownedOnly: { count: number; sample: string[] };
  truncated: { count: number; sample: string[] };
  unmatchedLocations: number;
}
```

The report is informational, not a gate: `transitionOrgMode` and `assertGoLiveGates` are
untouched. (Making value parity a hard gate is a possible follow-up once dual-write has
soaked; out of scope here.)

Scale note: the sweep is synchronous and full-catalog (25 products per Admin API round
trip) inside one request — fine at pilot scale; a multi-thousand-product shop needs a
background run (import_run-style) before onboarding.

### API: `app/routes/dashboard.api.cutover-drift.tsx`

Resource route, GET only (the check is read-only; loaders stay read-only). Flat sibling of
`dashboard.api.cutover` so the existing status loader never runs as a parent.
`requireDashboardSession`, then `checkDualRunDrift(session.shopId)` inside the standard
`dashboardJson` envelope — the CalderynError throws above ride the envelope's status/code
mapping (409 not_connected, 502 shopify_unreachable), everything else stays a 500 that
never masquerades as a comparison result.

### Client + UI

- `app/lib/dashboard/client.ts`: `DriftReportVM` mirroring the report, plus
  `fetchCutoverDrift()` calling `/dashboard/api/cutover-drift`.
- `app/components/dashboard/screens/Cutover.tsx`: a new "Does everything still match?" card,
  rendered only when `mode === "dual_run"`. Contents:
  - One line of plain-language copy: during dual run, changes made directly in Shopify admin
    do not flow into Calderyn; this compares live values.
  - "Compare with Shopify" button (secondary style, busy state while the sweep runs).
  - Results: a pass line when clean; otherwise compact rows per mismatch showing the item
    label with the Calderyn value vs the Shopify value (prices formatted as dollars, stock as
    units), plus the Shopify-only, owned-only, and truncated counts with sample titles and
    the unmatched-location count when nonzero. Counts above the 50-row cap say "showing
    first 50 of N".
  - Errors with a server message (502/409 path) render verbatim; a bare 500 renders a
    plain-language fallback instead of the literal code string.
  - Any successful mode move clears the drift state, so a pre-move "Everything matches"
    never survives into the new mode as if current.

No new icons needed. No em or en dashes in merchant copy. Existing `cd-*` classes only.

## Error handling

- DB errors from paged reads throw; the API envelope surfaces a 500 (real system failure).
- Shopify transport errors map to CalderynError 502 `shopify_unreachable` (expected,
  actionable, non-fatal), logged via console.warn; the wrap covers only `iterator.next()`,
  never the compare logic.
- A shop with no `shop_domain` maps to CalderynError 409 `not_connected`.
- The shared paged-read backstop throws above MAX_PAGES rather than using a truncated set.

## Testing

- `app/lib/cutover/__tests__/drift.server.test.ts`: mock `getSupabase` and
  `fetchProducts` (vi.mock, same pattern as go-live tests). Cases: clean pass; price
  mismatch; stock mismatch at a bridged location; missing balance row counts as 0;
  untracked variant skipped for stock; Shopify-only variant counted with sample; unbridged
  location counted; row cap keeps exact counts; DB error propagates; sellable clamps at 0.
- `app/routes/__tests__/dashboard.api.cutover-drift.test.ts` (or repo's route-test location):
  session required; happy path returns the report; Shopify failure returns 502 envelope.
- UI is covered by typecheck plus existing screen conventions (no screen test precedent for
  Cutover.tsx).

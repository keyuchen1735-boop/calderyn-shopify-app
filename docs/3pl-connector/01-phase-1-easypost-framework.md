# Phase 1 — Framework + EasyPost Adapter

> Implements the frozen contract in `00-overview-and-contract.md` §3 (C1–C9), §4 (Phase-1 migrations), §6, §7.
> This phase builds the **entire reusable spine** plus **EasyPost as adapter #1** (API-key connect) and the **both-surface integration UI**. Phases 2/3 are drop-in adapters against this spine.
>
> Status: **design only** — no code written. Grounded in real code at the `file:line` citations throughout.

---

## ⚠️ Contract concerns (for the coordinator — written *against* the contract, not diverging)

Per the brief, I do not re-decide frozen clauses. Three items I flag for the coordinator; all are implemented as the contract specifies, with the concern noted:

1. **C2 connectable-status set is under-specified and the contract's own ⚠️ trap applies here verbatim.** I verified the real connect flow against `auth.quickbooks.$.tsx:84-98`: a freshly-connected non-OAuth integration is written at **`sync_status='ready'`**. The ad registry (`registry.server.ts:25`) filters `IN ('pending','live')` — which would **never** pick up a `'ready'` EasyPost shop. `shop_integrations.list` (`calderyn.server.ts:974-979`) treats `ready | ok | live` as connected and `pending` as a fresh-backfill state. **Resolution (pinned in §6.1):** `shipAdaptersForShops` selects `sync_status IN ('ready','live','pending')`. The EasyPost connect action writes `'ready'`; the cron flips it to `'live'` on first successful pull (mirroring the ad cron's `setSync(... 'live')` at `cron.ingest-ads.tsx:39,46`). No `'error'` shop is re-pulled until the merchant re-connects. **Coordinator: confirm `'pending'` is harmless to include — EasyPost has no separate backfill state, so we never write `'pending'`; it is listed only for forward-compat.**

2. **C4.4 delete-by-keyset can silently drop a row whose key changed between pulls (rule-12 surface).** The delete is scoped by `tracking_no IN (window keys) OR (tracking_no IS NULL AND order_ref IN (window keys))`. If EasyPost mutates a shipment's `tracking_code` between two pulls inside the window (re-print, carrier swap), the *old* line keyed by the *old* tracking number is **not** in the new key-set, so it survives as a stale duplicate. The contract's "optional hardening" (`external_charge_id` + unique index) closes this deterministically. **I keep D1's delete-by-keyset as the default (no line-table change) but make `externalId` (`Shipment.id`) flow all the way to the row via `order_ref`/`tracking_no` is *not* sufficient** — so §7 ships the `external_charge_id` column **in Phase 1** as a nullable column **without** changing the upsert strategy, purely so a Phase-3 migration to true `onConflict` upsert needs no backfill. This is a strictly-additive column (no behavior change), which I judge inside D1's spirit ("the line *table* does not change [semantically]"). **Coordinator: approve shipping the nullable `external_charge_id` column now (additive, unused by C4.4) vs. deferring it entirely to Phase 3.**

3. **C6 fence + manual-period UI exclusion: the manual-period list site does not yet exist for synthetic periods to leak into.** I searched: there is currently **no merchant-facing list of `shipping_cost_period` rows** in either surface — `app.settings.tsx` only *writes* periods (CSV/typed via `ingestInvoiceCsv`/`saveTypedPeriodTotal`, `inputs.server.ts:17-31,46-109`); it never lists them back. So the C6 "companion requirement" (exclude `source='connector'` from any manual-period UI list) is **vacuously satisfied today** and becomes a **forward-looking rule**: §6 records it as a guard to apply *if/when* such a list is built. The one real fence (`runner.server.ts:35-36`) is the only code change required now. **Coordinator: acknowledge there is no existing period-list query to patch; the fence alone is sufficient for Phase 1.**

---

## 1. Goal & success criteria

**Goal:** A merchant who buys labels through EasyPost pastes their EasyPost API key in the embedded app; within one cron cycle their real per-label cost lands as `shipping_invoice_line` rows that the existing resolver reads as **`actual_invoice` / confidence `high`** for every matched order — the top automatic tier (`resolve.ts:6-7`), beaten only by a manual override.

**Done = all verifiable:**

1. **Connect:** Pasting a valid key in `app/routes/app.settings.tsx` writes one encrypted row to `integration_credentials (shop_id, kind='easypost_ship', access_token_encrypted)` (`auth.quickbooks.$.tsx:71-81` pattern) and one `shop_integrations` row at `sync_status='ready'`. Disconnect deletes the `shop_integrations` row (mirrors `calderyn.server.ts:1085-1090`). An invalid key is rejected at the action boundary with a visible error, no row written.
2. **Pickup:** `shipAdaptersForShops(sb)` returns the `'ready'` shop (NOT skipped — the C2 trap is closed). Verified by a unit test asserting a `'ready'` row is selected (§10).
3. **Land:** `/cron/ingest-ship-costs` pulls `GET /v2/shipments?purchased=true`, matches to orders, **pre-aggregates per `matched_order_id`**, and upserts under a single synthetic `shipping_cost_period (source='connector', carrier='easypost')`. Re-running the cron does **not** duplicate rows for the same shipments (idempotent delete-by-keyset).
4. **Resolve:** After landing, `runShipCostResolution` runs; a matched order with no manual override reads `order_fact.ship_cost_source='actual_invoice'`, `ship_cost_confidence='high'`, `ship_cost_cents = Σ(its EasyPost labels)` (`runner.server.ts:41-46,63-79`).
5. **Fence:** The synthetic `source='connector'` period is **excluded** from period-allocation (`runner.server.ts:35-36` patched). Verified: an order with **no** EasyPost shipment does **not** receive any allocated slice of EasyPost money (test §10).
6. **Surface, never drop (rule 12):** EasyPost charges that match no order land with `matched_order_id=NULL` and are surfaced as a visible "unmatched carrier charges" count in both surfaces — never silently discarded (`inputs.server.ts:93-105` already inserts unmatched; we mirror it).
7. **Bookkeeping:** Success → `shop_integrations` row `sync_status='live', sync_error=null, last_sync_at=now`; failure → `sync_status='error', sync_error=<msg≤500>` (`cron.ingest-ads.tsx:39,46,54`).
8. **Parity:** The dashboard (`app/components/dashboard/screens/Settings.tsx:380-401`) shows the `easypost_ship` integration as a read-only status pill, auto-rendered via `adaptIntegrations` once display constants are added (C7/§12).
9. **Gates green:** `npm run typecheck`, `npm run lint`, `npm run build`, all ship-cost vitest suites, `npx prisma validate`, migration diff — per repo Pre-commit gate.

---

## 2. Scope

**In:**
- The provider-blind framework: `ShipCostAdapter` interface (C1), registry + shop selection (C2), poll cron (C3), landing (C4), matching reuse (C5), allocation fence (C6).
- EasyPost adapter #1: API-key connect, `connect()` → `ShipSource`, `fetchCharges(since)` hitting `GET /v2/shipments?purchased=true` with `before_id`/`after_id` pagination, normalizing `selected_rate.rate` → `costCents`.
- Phase-1 migrations (§4 of contract): `'connector'` source CHECK, race-safe partial unique index, `integration_kind += 'easypost_ship'`, (flagged) additive `external_charge_id` column.
- Integrations wiring both surfaces: `IntegrationProvider`, `PROVIDER_TO_KIND`/`KIND_TO_PROVIDER`, embedded Connect/Disconnect card, dashboard read-only pill + display constants.
- Cron registration in `vercel.json`.
- Tests at the existing ship-cost behavior level.

**Out (deferred — §13):** Shippo (Phase 2), 3PL house adapters & carrier-adjustment reconciliation (Phase 3), EasyPost **webhooks** (`shipment.invoice.*` post-purchase adjustments — contract §5 risk #1, Phase 3), EasyPost **Forge** sub-account provisioning (C8 — a different product), EasyPost **Report API** bulk reconciliation (Phase 3).

---

## 3. Prerequisites

| # | Prerequisite | Source / note |
|---|---|---|
| P1 | `INTEGRATION_ENCRYPTION_KEY` (32-byte hex) present in env | `crypto.server.ts:4-8` throws without it; already required for Meta/Google/QBO. |
| P2 | `CRON_SECRET` present | cron auth `isAuthorizedCron(...)` (`cron.ingest-ads.tsx:70`). |
| P3 | Service-role Supabase client in crons | `getSupabase()` (`cron.ingest-ads.tsx:3,29`); RLS on both ship tables is deny-by-default (`20260616120000_true_ship_cost.sql:62-66`) — cron uses BYPASSRLS key, keep it. |
| P4 | `integration_kind` enum must gain `'easypost_ship'` **in its own migration** before any code references it | `20260606120000_tiktok_platform.sql:5-7` precedent — a freshly-added enum value can't be used in the same transaction. |
| P5 | `.env.example` updated | EasyPost needs **no** app-level client ID/secret (merchant pastes their own key); add only an optional `EASYPOST_API_BASE=https://api.easypost.com/v2` override key. Per repo rule, document it. |
| P6 | No new top-level dependency | Use the built-in `fetch` (Node 18+) with HTTP Basic — **do not** add the `@easypost/api` SDK (bundle/maintenance cost, contract "no new deps without flagging"). |

---

## 4. Data contract — EasyPost Shipment → `NormalizedShipmentCost`

`NormalizedShipmentCost` is frozen (C1). EasyPost field names confirmed against `docs.easypost.com/docs/shipments` (top-level: `id`, `reference`, `tracking_code`, `created_at`, `status`; rate sub-object: `rate`, `currency`, `carrier`, `service`, `list_rate`, `retail_rate`; `postage_label.label_url`; list response `{ shipments: [...], has_more }`).

| `NormalizedShipmentCost` field | EasyPost source | Mapping rule |
|---|---|---|
| `externalId` | `shipment.id` (e.g. `"shp_..."`) | **Idempotency key.** Stable per shipment. Stored into `external_charge_id` (§7, flagged) for future onConflict; also the dedup anchor in landing. |
| `orderRef` | `shipment.reference` | `null` if absent. The merchant *may* set `reference` to the Shopify order name at label-buy time; if they don't, this is null and matching falls back to tracking (C5 caveat). |
| `trackingNo` | `shipment.tracking_code` | top-level (NOT under a rate). `null` if absent. **Primary match key** when `reference` is empty — aligns with `fulfillment_fact.tracking_no` (`inputs.server.ts:59-69`). |
| `costCents` | `shipment.selected_rate.rate` | **ACTUAL paid** amount. Decimal **string** (e.g. `"7.39"`) → `Math.round(parseFloat(rate) * 100)`. **NOT** `list_rate`/`retail_rate` (those are sticker prices, not what the merchant paid). Guard: if `selected_rate` is null (shipment created but no rate bought), skip the shipment. |
| `currency` | `shipment.selected_rate.currency` | e.g. `"USD"`. |
| `shippedAt` | `shipment.created_at` | ISO-8601. Used for the re-pull window comparison and the line's cosmetic timestamp. |
| `carrier` | `shipment.selected_rate.carrier` | e.g. `"USPS"`, `"UPS"`. Distinct from the **provider** `"easypost"` (the synthetic period's `carrier` column is the provider; this is the underlying carrier, informational only). |

**Decimal-parse rigor (C1 "parse provider decimal strings carefully"):** EasyPost returns money as decimal strings. Parse with `parseFloat` then `Math.round(... * 100)` to integer cents; never store the float. Reject `NaN`/negative (defensive — a malformed rate is surfaced as a skipped shipment in the sync summary, rule 12, not silently coerced to 0).

**`fees[]`:** top-level array of fee objects. Phase 1 cost = `selected_rate.rate` only (the label price). Insurance/other `fees` are **out of scope for Phase 1** (noted §13) — `selected_rate.rate` is the contract's defined "actual label cost at purchase" (§5 risk #1).

---

## 5. Connect flow

**Mechanism (C8): API-key paste**, not OAuth. EasyPost auth is HTTP Basic with the key as username + empty password (`Authorization: Basic base64("KEY:")`). We read the merchant's *existing* account; Forge sub-account provisioning is out of scope (§13).

### 5.1 Credential storage
- New intent on `app/routes/app.settings.tsx` action: `connect_easypost` (EasyPost can't reuse `connect_integration`, which assumes an OAuth `startOAuth` redirect — `app.settings.tsx:316-333`). The action:
  1. Reads `formData.get("api_key")`, trims, validates non-empty + plausible shape (EasyPost keys are opaque; do a **live probe** `GET /v2/api_keys` or `GET /v2/shipments?page_size=1` with the key to confirm it authenticates **before** persisting — fail visibly on 401, rule 12). The probe also returns `mode` (test vs production) → store as `external_account_id` hint.
  2. `encrypt(apiKey)` (`crypto.server.ts:12`) → upsert `integration_credentials` on `(shop_id, kind='easypost_ship')` with `access_token_encrypted` (mirror `auth.quickbooks.$.tsx:71-81`). **Never** the legacy `shop_integrations.access_token_enc` bytea (C7).
  3. Upsert `shop_integrations (shop_id, kind='easypost_ship', sync_status='ready', sync_error=null, connected_at=now)` on `(shop_id, kind)` (mirror `auth.quickbooks.$.tsx:84-98`).
  4. Return a toast; the integrations list re-renders the card as Connected.
- This action runs **inside** the embedded session (`authenticate.admin(request)` already gates `app.settings.tsx`), so — unlike OAuth — there is **no** `auth.easypost.$.tsx` callback route and **no** `consumeOAuthState`. The key never leaves the server; it is submitted once over the embedded POST and immediately encrypted.

### 5.2 Embedded Connect/Disconnect card
- `easypost_ship` is added to the `integrations.list` defaults map (`calderyn.server.ts:960-966`) so the card auto-appears in the kind-agnostic list (`app.settings.tsx:543-545`).
- **`IntegrationCard` (`app.settings.tsx:849-917`) needs a small branch:** its Connect button assumes OAuth (`isConnectable` + `connect_integration` fetcher, posting to `startOAuth`). EasyPost is API-key, so the card must render a **key-input form** (Polaris `TextField` + submit) posting `intent=connect_easypost` instead of the OAuth fetcher. Cleanest: detect kind `=== 'easypost_ship'` (or a new `connectMode: 'api_key' | 'oauth'` flag derived from a constant) and render the key form path; the Disconnect path is **unchanged** (it already posts `disconnect_integration` with the provider short-name, `app.settings.tsx:893-900`).
- **Disconnect:** `disconnect` (`calderyn.server.ts:1074-1094`) maps provider→kind via an `if` ladder that **does not** know `easypost`. **Required fix:** extend the ladder so `provider==='easypost' → kind='easypost_ship'` (or fall through to `PROVIDER_TO_KIND`). Without it, disconnect would try to delete `kind='easypost'` and no-op. Also delete the `integration_credentials` row on disconnect (the OAuth disconnect leaves credentials; for a pasted key, deleting the credential on disconnect is the user's clear intent — do both deletes in a `$transaction`-equivalent sequence; surface either error).

### 5.3 Dashboard (read-only)
No connect UI. The dashboard shows status only (`Settings.tsx:380-401`, explicit "connect/disconnect lives in the embedded app", line 383). Parity = display constants (§12).

---

## 6. Fetch & land

### 6.1 Registry + shop selection (C2) — `app/lib/ship-cost/adapters/registry.server.ts`
Mirror `registry.server.ts:20-34`, but **fix the status filter** (the trap):
```ts
export async function shipAdaptersForShops(sb: SupabaseClient): Promise<ShipWorkItem[]> {
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id, kind, sync_status")
    .in("kind", ["easypost_ship"])              // + "shippo_ship" in Phase 2
    .in("sync_status", ["ready", "live", "pending"]); // ← 'ready' is what connect writes (auth.quickbooks.$.tsx:96)
  if (error) throw error;
  // map kind -> adapter via BY_KIND, skip unknown kinds (mirror registry.server.ts:27-32)
}
```
`'ready'` is mandatory (C2 trap; concern #1). `'live'` re-pulls on subsequent cron ticks. `'pending'` is forward-compat only (EasyPost writes no `'pending'`). `'error'` is intentionally **excluded** — a broken key waits for re-connect, exactly as the ad cron leaves errored shops until a new poll succeeds.

### 6.2 Poll cron (C3) — `app/routes/cron.ingest-ship-costs.tsx`
Structurally a copy of `cron.ingest-ads.tsx`:
- **Auth:** `isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)` → 401 (`cron.ingest-ads.tsx:70`).
- **Loop:** `work = await shipAdaptersForShops(sb)`; `mapWithConcurrency(work, CONCURRENCY=4, runOne)` (`cron.ingest-ads.tsx:7,9,78`) — per-slot error isolation; a thrown error goes to `summary.errors`, never fatal.
- **`runOne(item)`:**
  1. `src = await adapter.connect(shopId)`; `null` → `summary.skipped.push(tag)` (`cron.ingest-ads.tsx:30-34`).
  2. `since = trailingWindowStart()` — **re-pull window**: carrier costs settle/adjust post-ship, so even the daily poll re-pulls a trailing window. Use **30 days** (covers EasyPost APV-style late adjustments to the label cost within the window; bounded by `?after_id` pagination). `since` is an ISO date; the adapter translates it to a `created_at` lower bound (EasyPost list supports `before_id`/`after_id` cursors, so the adapter pages until a shipment's `created_at < since` then stops).
  3. `charges = await src.fetchCharges(since)`.
  4. `await landEasyPostCharges(sb, shopId, "easypost", charges)` (C4, §6.4).
  5. `await runShipCostResolution(sb, shopId, { shopCountry })` — resolve `shopCountry` the same way typed/CSV callers do; the known stub passes `null` and degrades gracefully (`runner.server.ts:31-33`; `shop-country.server.ts` is the stub). Pass `null` for Phase 1 (matches CSV path which also threads `shopCountry`).
- **Bookkeeping:** mirror `setSync(shopId, kind, patch)` (`cron.ingest-ads.tsx:11-24`, **throws on supabase error**): success → `{ sync_status:'live', sync_error:null, last_sync_at:now }` (this flips a freshly-`'ready'` shop to `'live'`, C2 lifecycle); failure (best-effort, never masks original) → `{ sync_status:'error', sync_error:msg.slice(0,500) }` then re-throw (`cron.ingest-ads.tsx:49-59`).
- **Summary:** `{ landed, skipped, errors }` returned as `json(...)` (`cron.ingest-ads.tsx:88`).
- **Schedule:** register in `vercel.json` `crons` (§8). Daily, e.g. `"0 6 * * *"` (offset from the QBO cron at `0 5` to spread load; `vercel.json:22`). **Mind the 501 incidents** (`551dabf`, `b486895`): the route path `/cron/ingest-ship-costs` must not collide with any function path; it's a plain Remix route loader like the other crons.

### 6.3 EasyPost adapter — `app/lib/ship-cost/adapters/easypost.server.ts`
Implements `ShipCostAdapter` (C1):
```ts
export const easyPostAdapter: ShipCostAdapter = {
  provider: "easypost",
  integrationKind: "easypost_ship",
  async connect(shopId) {
    const cred = await loadCredential(sb, shopId, "easypost_ship"); // integration_credentials
    if (!cred) return null;                       // → cron marks "skipped"
    const apiKey = decrypt(cred.access_token_encrypted); // crypto.server.ts:20
    return { fetchCharges: (since) => fetchEasyPostCharges(apiKey, since) };
  },
};
```
`fetchEasyPostCharges(apiKey, since)`:
- `GET {BASE}/v2/shipments?purchased=true&page_size=100` with header `Authorization: Basic base64(apiKey + ":")` (NOT Bearer).
- Paginate with `after_id` cursor (descending by id): read `has_more` from the body; pass the last shipment's `id` as `after_id` on the next page. Stop when `has_more === false` **or** the page's oldest `created_at < since` (re-pull window bound). `page_size` max 100.
- For each shipment with a non-null `selected_rate`, map to `NormalizedShipmentCost` (§4). Skip (and count in a debug tally) shipments with no `selected_rate`.
- **Errors:** non-2xx → throw `Error` with status + body snippet so the cron records it in `sync_error` (rule 12; mirrors the ad path surfacing permission errors to merchants).

### 6.4 Landing (C4) — `app/lib/ship-cost/adapters/land.server.ts`
Per shop, per sync (adapts `ingestInvoiceCsv`, `inputs.server.ts:46-109`):

1. **Ensure synthetic period** for `(shop, provider='easypost')`:
   `SELECT id FROM shipping_cost_period WHERE shop_id=? AND source='connector' AND carrier='easypost'`; if absent `INSERT (shop_id, period_start, period_end, carrier='easypost', total_cents=0, source='connector') RETURNING id`. The **partial unique index** `(shop_id, carrier) WHERE source='connector'` (§7) makes the insert race-safe — on conflict, re-select. `period_start`/`period_end` are cosmetic (fenced from allocation by C6) — use a wide sentinel, e.g. `period_start='1970-01-01'`, `period_end='2999-12-31'`.
2. **Load match orders** exactly as CSV (`inputs.server.ts:54-74`): `order_fact (id, order_number)` + `fulfillment_fact (order_id, tracking_no)` → `MatchOrder[] { id, orderNumber, trackingNos }`.
3. **Map** `NormalizedShipmentCost[]` → `ParsedInvoiceRow[] { orderRef, trackingNo, costCents }` and call `matchInvoiceLines(rows, matchOrders)` (C5, `match.ts:26-49`, unchanged). Carry `externalId` and `carrier` alongside in a parallel array (the match fn doesn't know about them).
4. **Pre-aggregate matched charges by `matched_order_id` (sum `cost_cents`)** → exactly one line per order (dodges the resolver's last-write-wins `Map`, `runner.server.ts:43-45`). Keep the set of contributing `externalId`s and a representative `tracking_no`/`order_ref` per aggregated line. **Unmatched charges are NOT aggregated** — they land individually with `matched_order_id=NULL` (C4.6).
5. **Idempotent upsert** under the synthetic `period_id` (D1, no line-table schema change for the strategy itself):
   - Compute the **window key-set** = every `tracking_no` (and, for null-tracking rows, every `order_ref`) in this sync's charges.
   - `DELETE FROM shipping_invoice_line WHERE period_id=<synthetic> AND (tracking_no IN (<keys>) OR (tracking_no IS NULL AND order_ref IN (<keys>)))`.
   - `INSERT` the freshly-computed aggregated matched lines + individual unmatched lines (shape per `inputs.server.ts:95-104`: `shop_id, period_id, order_ref, tracking_no, cost_cents, matched_order_id`, plus `external_charge_id` per concern #2).
   - Rows **outside** the window (older shipments) are untouched → re-pull doesn't duplicate and doesn't wipe history.
6. **Recompute** synthetic `total_cents = Σ(its lines)` (honest; unused by allocation due to C6). `UPDATE shipping_cost_period SET total_cents=<sum>, updated_at=now WHERE id=<synthetic>`.
7. **Surface unmatched (rule 12):** unmatched rows still land (never dropped); return a `{ matchedCount, unmatchedCount }` so the cron summary and UI can show the count (mirrors `ingestInvoiceCsv` returning `unmatched`, `inputs.server.ts:108`).
8. **Resolve:** done by the cron after landing (C3, step 6.2.5).

---

## 7. Schema deltas (Phase-1 migrations)

All via Supabase migrations under `supabase/migrations/`; **never hand-edit applied migrations** (CLAUDE.md). RLS unchanged — both ship tables stay service-role-only (`20260616120000_true_ship_cost.sql:62-66`). Use `prisma migrate` / Supabase CLI; one new timestamped file per logical step (enum value must be its own step).

**Migration A — `…_easypost_integration_kind.sql` (enum, own step, P4):**
```sql
-- A freshly-added enum value cannot be used in the same transaction (tiktok precedent).
alter type public.integration_kind add value if not exists 'easypost_ship';
```

**Migration B — `…_ship_cost_connector_source.sql` (CHECK + index + optional column):**
```sql
-- 1. Allow the synthetic connector period source (D1).
alter table public.shipping_cost_period
  drop constraint if exists shipping_cost_period_source_check,
  add constraint shipping_cost_period_source_check
    check (source in ('upload','typed','connector'));

-- 2. Race-safe / idempotent synthetic period: one per (shop, carrier) for connector rows.
create unique index if not exists shipping_cost_period_connector_uidx
  on public.shipping_cost_period (shop_id, carrier)
  where source = 'connector';

-- 3. (FLAGGED, concern #2) Additive idempotency anchor for a future onConflict upsert.
--    Nullable, unused by the C4.4 delete-by-keyset strategy; no backfill.
alter table public.shipping_invoice_line
  add column if not exists external_charge_id text;
create index if not exists shipping_invoice_line_external_charge_idx
  on public.shipping_invoice_line (shop_id, external_charge_id)
  where external_charge_id is not null;
```
> The existing source CHECK is at `20260616120000_true_ship_cost.sql:37`; this drop-then-add keeps it idempotent (same idempotent pattern that file uses at lines 12-19). **The line table gains only a nullable column** — the upsert strategy is still delete-by-keyset (D1 honored). If the coordinator defers concern #2, drop part 3.

**Allocation fence (code, not SQL) — C6, `runner.server.ts:35-36`:**
```ts
const { data: periods } = await sb
  .from("shipping_cost_period").select("total_cents").eq("shop_id", shopId)
  .in("source", ["upload", "typed"]);   // exclude source='connector'
```
This is the **only** resolver change in the whole feature.

---

## 8. Files to add / change

**New files (mirror the ad-adapter layout under a `ship-cost/adapters/` subdir):**
| Path | Mirrors | Purpose |
|---|---|---|
| `app/lib/ship-cost/adapters/adapter.ts` | `app/lib/ads/adapter.ts:39-51` | C1 interface: `ShipProvider`, `ShipIntegrationKind`, `NormalizedShipmentCost`, `ShipSource`, `ShipCostAdapter`. |
| `app/lib/ship-cost/adapters/registry.server.ts` | `app/lib/ads/registry.server.ts:10-34` | C2 `SHIP_ADAPTERS`, `BY_KIND`, `ShipWorkItem`, `shipAdaptersForShops` (with the fixed status filter). |
| `app/lib/ship-cost/adapters/easypost.server.ts` | `app/lib/{meta,google,tiktok}/ingest.server.ts` (the `*Adapter` export) | EasyPost `connect()` + `fetchEasyPostCharges` (Basic auth, `?purchased=true`, `after_id` pagination, `selected_rate.rate` mapping). |
| `app/lib/ship-cost/adapters/land.server.ts` | `app/lib/ship-cost/inputs.server.ts:46-109` | C4 landing: synthetic period, match reuse, pre-aggregate, delete-by-keyset, total recompute. |
| `app/routes/cron.ingest-ship-costs.tsx` | `app/routes/cron.ingest-ads.tsx` (whole file) | C3 cron: auth, `mapWithConcurrency`, `runOne`, `setSync`, summary. |
| `app/lib/ship-cost/adapters/__tests__/*.test.ts` | `app/lib/ship-cost/__tests__/*` | §10 tests (registry, land, easypost-map). |
| Migrations A & B | `20260606120000_tiktok_platform.sql`, `20260616120000_true_ship_cost.sql` | §7. |

**Changed files (surgical, rule 3):**
| Path | Change | Anchor |
|---|---|---|
| `app/lib/ship-cost/runner.server.ts` | **ONE-LINE allocation fence:** add `.in("source", ["upload","typed"])` to the period query. | `runner.server.ts:35-36` |
| `app/lib/calderyn.server.ts` | `IntegrationProvider` += `"easypost"`; `integrations.list` defaults map += `easypost_ship` row; `INTEGRATION_DISPLAY_NAME` += `easypost_ship:"EasyPost"`; `INTEGRATION_LOGO_CLS` += `easypost_ship:"logo-easypost"`; `disconnect` ladder += `easypost→easypost_ship` and delete `integration_credentials`. | `:65`, `:960-966`, `:231-237`, `:223-229`, `:1074-1094` |
| `app/lib/integrations.ts` | `PROVIDER_TO_KIND` += `easypost:"easypost_ship"`; `KIND_TO_PROVIDER` += `easypost_ship:"easypost"`. (EasyPost is **not** added to `OAUTH_PROVIDERS` — it's API-key, so `isConnectable` stays false and the card uses the key-form branch.) | `:41-45`, `:94-98`, `:13` |
| `app/routes/app.settings.tsx` | New action intent `connect_easypost` (validate+probe+encrypt+upsert); `IntegrationCard` branch to render the API-key form for `easypost_ship`. | action `:316-342`; card `:849-917` |
| `app/lib/dashboard/client.ts` | `INTEGRATION_ORDER` += `"easypost_ship"` (dashboard ordering/parity). | `:331-337` |
| `app/components/dashboard/screens/Settings.tsx` | **No code change** — auto-renders via `adaptIntegrations` once the kind is in the defaults map + display constants. (Parity is data, not JSX — §12.) | `:387-398` |
| `vercel.json` | Register `{ "path": "/cron/ingest-ship-costs", "schedule": "0 6 * * *" }`. | `:15-25` |
| `.env.example` | Document optional `EASYPOST_API_BASE`. | — |

---

## 9. Step-by-step implementation plan

Ordered; **TDD-RED-first** where the repo already has a behavior test for the mirrored module (the existing ship-cost suite is red-green-refactor: `inputs.test.ts`, `match.test.ts`, `runner.test.ts`, `allocate.test.ts`). Write the failing test first for landing, registry, and the fence; the interface/cron/UI are scaffolding-then-wire.

1. **Migrations A & B** (§7). Run `npx prisma migrate diff --exit-code` / Supabase apply against a branch; confirm enum value lands in its own step. (No test — schema.)
2. **C1 interface** `adapter.ts` — pure types, copy `ads/adapter.ts` shape. (No test.)
3. **Allocation fence (C6)** — **RED first:** add a `runner.test.ts` case: seed a `source='connector'` period with `total_cents>0` and an order with **no** invoice line → assert that order's resolved source is NOT `reconciled` from connector money (i.e. allocated slice excludes connector). Then apply the one-line `.in("source", ["upload","typed"])`. GREEN.
4. **Registry (C2)** — **RED first:** test `shipAdaptersForShops` returns a shop whose `shop_integrations.sync_status='ready'` (closes the trap, concern #1) and skips `'error'`. Implement against `makeFakeSupabase` (`__tests__/helpers`). GREEN.
5. **Landing (C4)** — **RED first** (the heavy test, mirrors `inputs.test.ts:18-36`): given two EasyPost charges matching the same order + one unmatched, assert (a) one synthetic period `source='connector'` created, (b) **one** aggregated line for the order with summed cents, (c) the unmatched charge lands with `matched_order_id=null`, (d) re-running with the same charges does **not** duplicate (delete-by-keyset), (e) `total_cents` = Σ lines. Implement `land.server.ts`. GREEN.
6. **EasyPost adapter** — test the **pure mapper** `mapShipmentToNormalized(shipment)` against a fixture JSON (`selected_rate.rate="7.39"` → `costCents=739`; null `selected_rate` → skipped; missing `reference` → `orderRef=null`). The HTTP `fetchEasyPostCharges` is integration-shaped — unit-test the mapper + pagination-stop logic with a stubbed fetch; do not hit the network in CI.
7. **Cron (C3)** `cron.ingest-ship-costs.tsx` — wire `shipAdaptersForShops` → `connect` → `fetchCharges` → `land` → `runShipCostResolution` → `setSync`. Smoke via the same shape as the ad cron (auth 401 test is cheap; the loop is covered by the unit tests of its parts).
8. **Integrations wiring** — `IntegrationProvider`, `PROVIDER_TO_KIND`/`KIND_TO_PROVIDER`, `integrations.list` defaults, display constants, `disconnect` ladder, `INTEGRATION_ORDER`.
9. **Embedded UI** — `connect_easypost` action + `IntegrationCard` key-form branch. Extend `app.settings.shipcost.test.ts`-style coverage for the new action (valid key → rows written; invalid → error, no rows).
10. **Dashboard parity** — confirm the pill renders (data-only; §12). No new JSX.
11. **Cron registration** in `vercel.json`; verify path doesn't collide (501 lesson).
12. **Pre-commit gate** — `npm run typecheck` / `lint` / `build` / vitest / `prisma validate` / migration diff. Paste results (rule 12). Auto-commit only when all green.

---

## 10. Tests (behavior-level)

Mirror the existing ship-cost suite (`makeFakeSupabase` helper, `vi.mock("../runner.server")` for landing like `inputs.test.ts:6`). Each asserts behavior, not implementation (rule 9):

| Test | Asserts | Mirrors |
|---|---|---|
| **Matching** | EasyPost charge with `reference="#1001"` matches order `o1`; with only `tracking_code` matches via fulfillment tracking; with neither → unmatched. | `match.test.ts`, reuses `matchInvoiceLines` (C5). |
| **Pre-aggregation sum** | Two charges (`739` + `512`) for the same `matched_order_id` → **one** line with `cost_cents=1251`, not two rows. | new; the core C4.3 guarantee. |
| **Idempotent re-pull** | Landing the same charge set twice → row count unchanged for the order (delete-by-keyset wipes then re-inserts the window). | new; success criterion #3. |
| **Allocation fence** | A `source='connector'` period with `total_cents=5000` does **not** allocate any cents to an order that has no invoice line; that order resolves via modeled/fallback, never `reconciled` from connector money. | extends `runner.test.ts`; the C6 double-count guard. |
| **Unmatched surfaced not dropped** | An unmatched charge lands with `matched_order_id=null` AND the returned `unmatchedCount` ≥ 1 (rule 12). | mirrors `inputs.test.ts:32`. |
| **Registry status trap** | `shop_integrations.sync_status='ready'` row is **returned** by `shipAdaptersForShops`; `'error'` is excluded. | new; concern #1 regression guard. |
| **EasyPost mapper** | `selected_rate.rate="7.39"`→`739`; null `selected_rate`→skipped; decimal string parsed, never float-stored. | new; §4 contract. |
| **Resolver tier** | After landing a matched line, an order with no manual override resolves to `actual_invoice`/`high`. | reuses `resolve.ts:6-7` via `runner.test.ts`. |
| **Connect action** | Valid key → `integration_credentials` + `shop_integrations(sync_status='ready')` written; invalid (401 probe) → error returned, **no** rows. | mirrors `app.settings.shipcost.test.ts`. |

---

## 11. Risks & open questions

1. **(Contract §5 #1) Post-purchase adjustments deferred.** Phase 1 cost = `selected_rate.rate` at purchase. EasyPost late carrier adjustments (USPS APV) arrive via `shipment.invoice.*` webhooks / Report API — **Phase 3** (live spike first). The 30-day re-pull window catches adjustments only if EasyPost mutates `selected_rate.rate` on the existing shipment within the window; if adjustments are separate invoice objects, they're invisible until Phase 3. **Open: does re-fetching a shipment within 30 days return an updated `selected_rate.rate`, or is the original immutable?** (Resolve in Phase 3 spike; doesn't block Phase 1.)
2. **(Contract §5 #2) Match rate depends on `tracking_code` alignment.** If the merchant doesn't set `reference` to the Shopify order name, matching leans entirely on `tracking_code` == `fulfillment_fact.tracking_no`. **Expected EasyPost match rate:** high *iff* the merchant's fulfillment workflow writes EasyPost's tracking number back to the Shopify fulfillment (common, but not guaranteed). Unmatched charges are surfaced (rule 12), not lost — so a low match rate is *visible*, not silent.
3. **(Contract §5 #3) Coverage is intrinsically partial** — only merchants who buy labels via EasyPost get `actual_invoice`; others stay on modeled/CSV/fallback. UI must not imply universal coverage (the unmatched count + the existing confidence tiers already communicate this).
4. **(Contract §5 #4) `shopCountry` stub** — cron passes `null` → allocation degraded for the *modeled/reconciled* tiers (not for `actual_invoice`, which is exact). Non-blocking (`runner.server.ts:31-33`).
5. **`tracking_no` uniqueness for delete-by-keyset (concern #2).** If two different shipments share a `tracking_code` (carrier reuse, or null tracking with colliding `order_ref`), the keyset delete could over-delete. The flagged `external_charge_id` column is the deterministic fix (Phase 3 onConflict). Phase 1 mitigates by keying on `tracking_no` first and only falling to `order_ref` for null-tracking rows.
6. **EasyPost test vs production keys.** A merchant could paste a **test** key (`mode='test'`) and see fake shipments. The connect probe reads `mode`; surface it (e.g. "Connected (test mode)") so the merchant isn't confused by test data landing as real cost.
7. **Pagination cost.** A high-volume merchant's first pull over a 30-day window at `page_size=100` could be many pages. Bounded by the window + `after_id` stop condition; if it proves slow, a future backfill/poll split (like the ad cron's `backfillAds`/`pollAdsDaily`, `cron.ingest-ads.tsx:37-42`) is the escalation path — **not** built in Phase 1 (single re-pull window suffices).

---

## 12. Dashboard parity checklist (C7 / §7 of contract)

Parity is **data, not JSX** — the dashboard re-renders the new kind automatically once these are set (no Polaris copy; match the contract). The dashboard lives in **this repo** (`app/components/dashboard/*`, `app/lib/dashboard/*`).

- [ ] `integrations.list` defaults map (`calderyn.server.ts:960-966`) includes an `easypost_ship` row (`name:"EasyPost", status:"disconnected", detail:"Not connected", logoCls:"logo-easypost"`). **This is the single source both surfaces read.**
- [ ] `INTEGRATION_DISPLAY_NAME[easypost_ship] = "EasyPost"` (`calderyn.server.ts:231-237`).
- [ ] `INTEGRATION_LOGO_CLS[easypost_ship] = "logo-easypost"` (`calderyn.server.ts:223-229`) — add the matching CSS class wherever the other `logo-*` classes live (dashboard stylesheet).
- [ ] `INTEGRATION_ORDER` (`client.ts:331-337`) includes `"easypost_ship"` so it sorts deterministically (else it falls to the alphabetical tail, `client.ts:345`).
- [ ] `adaptIntegrations` (`client.ts:339-357`) needs **no change** — it's kind-agnostic; verify the new key flows through to an `IntegrationVM`.
- [ ] Dashboard `Settings.tsx:387-398` renders the read-only status `Pill` — **no code change**; confirm the row appears with `CONNECTION_TONE`/`CONNECTION_LABEL`/`CONNECTION_ICON` resolving for the integration's `status`.
- [ ] Status vocabulary: `sync_status='ready'|'live'` → `status='connected'` (`calderyn.server.ts:974-979`); confirm the dashboard pill reads "Connected" for a live EasyPost shop. No connect/disconnect button on the dashboard (embedded-app-only, `Settings.tsx:383`).

---

## 13. Out of scope / deferred

| Item | Phase | Why deferred |
|---|---|---|
| **Shippo adapter** (OAuth, `Bearer oauth.<token>`, `/transactions?object_status=SUCCESS`, `rate.amount`, `metadata` match) | 2 | Proves framework generality; needs Shippo partner-program approval (C8). |
| **Carrier-adjustment reconciliation** (EasyPost `shipment.invoice.*` webhooks + Report API; USPS APV) | 3 | Doc-unconfirmed link-back (contract §5 #1) — opens with a live API spike. Phase 1 = label cost at purchase only. |
| **EasyPost webhooks** (`payment.*`, `refund.successful`, `shipment.invoice.*`; HMAC `X-Hmac-Signature`, `validate_webhook()`) | 3 | Cost is in the synchronous buy response; no `shipment.purchased` event exists. Polling (C3) is sufficient for Phase 1. |
| **EasyPost Forge** sub-account provisioning (ReferralCustomer / Child User, `GET /v2/api_keys` hierarchy) | future product | A *different* product that changes the merchant's label-buying workflow and gives no history for existing accounts (C8). Phase 1 = read the merchant's existing account via pasted key. |
| **EasyPost Report API** bulk reconciliation (`POST/GET /v2/reports/:type`) | 3 | Bulk/historical reconciliation; the synchronous list endpoint covers Phase 1's re-pull window. |
| **`fees[]` / insurance costs** beyond `selected_rate.rate` | later | Contract defines Phase-1 actual cost as the label price; fees are an additive follow-up. |
| **`external_charge_id` onConflict upsert** (replacing delete-by-keyset) | 3 (column shipped Phase 1, flagged) | D1 prefers no line-table change; adopt only if `tracking_no` proves non-unique (concern #2). |
| **Additional 3PL adapters** (ShipBob/ShipHero) | 3 | Further drop-ins once the spine exists. |

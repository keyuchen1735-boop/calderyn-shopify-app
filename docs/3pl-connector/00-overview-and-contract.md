# 3PL / Carrier Ship-Cost Connector — Overview & Frozen Architecture Contract

> **This is the shared spine. The three phase specs (`01`–`03`) implement against it and MUST NOT re-decide anything in §3–§5.** If a phase finds a contract clause is wrong or infeasible, it stops and flags it here rather than diverging.
>
> Status: **design only** (no code written yet). Author: coordinator synthesis of two grounded research passes (codebase foundation map + external-API feasibility) + three product decisions (§0).

---

## 0. Frozen decisions (the three calls already made)

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | How non-period charges satisfy `shipping_invoice_line.period_id NOT NULL` | **Auto-create a synthetic per-`(shop, provider)` period** (`source='connector'`) | No FK restructuring. **Requires** a 1-line allocation fence (C6) + a `source` CHECK alter (+ one strictly-additive nullable column — see §8). |
| D2 | Where the reusable adapter framework is built | **Phase 1** (first adapter ships with the framework) | Phases 2/3 are drop-in adapters; framework cost paid once, up front. |
| D3 | Provider sequencing | **EasyPost → Shippo → reconciliation/3PL** | Reframed from the original "Shopify Shipping first" after the feasibility finding in §1. |

---

## 1. The reframe — why "Shopify Shipping" is **not** Phase 1

The original scope put "Shopify Shipping (labels bought in Shopify)" first as the no-OAuth fast path. **External-API research (GraphQL Admin 2026-04, doc-grounded) shows this is infeasible for *true cost*:**

- `Order.totalShippingPriceSet` is verbatim *"the total shipping costs returned to the customer"* — **buyer-charged, not the merchant's label expense.**
- **No** `labelCost` / `postageCost` / `price` field exists on `Fulfillment`, `FulfillmentOrder`, or `DeliveryMethod`. The `ShippingLabel` GraphQL object is removed/privatized (renders on no API version).
- The only trace of true label cost is `shopifyPaymentsAccount.balanceTransactions` (the charge as a payout deduction) — Payments-gated, **not per-order**, fuzzy. Not an `actual_invoice`/high-confidence source.

**Coverage model (the honest mental model for the whole feature):** true per-order cost exists only where the label was *bought*. Each adapter therefore covers the slice of merchants who buy shipping through that system:

| Merchant buys labels via… | True-cost path |
|---|---|
| **EasyPost** | Phase 1 adapter (this spec) |
| **Shippo** | Phase 2 adapter |
| **A 3PL house (ShipBob/ShipHero/…)** | Phase 3 adapters |
| **Shopify Shipping** | **Already served by the existing CSV upload** (`app.settings.tsx` → `ingestInvoiceCsv`). No API path exists; do **not** build a fake Shopify adapter. |
| Carrier account directly (UPS/FedEx/USPS) | future adapter |

The CSV-upload path remains the **universal fallback** for any merchant who can export a billing CSV.

---

## 2. The goal & how it plugs in (the invoice tier is untouched)

**Goal:** land real per-order shipping charges so the existing resolver reads them as `actual_invoice` / `confidence: high` — the top automatic tier (only a manual per-order override outranks it).

The resolver (`app/lib/ship-cost/resolve.ts:3-20`) tiers: **manual → actual_invoice → actual_event → reconciled → modeled → fallback.** The runner (`app/lib/ship-cost/runner.server.ts:41-46`) is the only producer of the `actual_invoice` signal:

```ts
const { data: invoices } = await sb
  .from("shipping_invoice_line").select("matched_order_id, cost_cents").eq("shop_id", shopId);
const invoiceByOrder = new Map<string, number>();
for (const i of invoices) if (i.matched_order_id) invoiceByOrder.set(i.matched_order_id, i.cost_cents);
// ...invoiceLineCents: invoiceByOrder.get(o.id) ?? null
```

**A landed row resolves to `actual_invoice`/`high` for its order iff (verified):**
1. `matched_order_id` is **NOT NULL** and equals an `order_fact.id` for the shop.
2. `cost_cents` is set (used verbatim).
3. `shop_id` matches.
4. The order has **no** `ship_cost_manual_cents` override (else `manual` wins — correct).
5. The order appears in `v_order_ship_features` for the shop.

**Three inherited behaviors the connector MUST handle (all pre-existing in the CSV path):**
- **`matched_order_id = NULL` rows are invisible to the resolver** (silently skipped). → The connector matches *before* insert and **surfaces** unmatched rows (C5), never silently drops them (rule 12).
- **Multiple lines for the same order → last-write-wins, not summed** (`invoiceByOrder` is a plain `Map`). → The connector **pre-aggregates** charges per order (C4.3).
- **Resolution is not triggered by insert.** → The cron **calls `runShipCostResolution` after landing** (C3).

---

## 3. Frozen Architecture Contract (C1–C9)

### C1 — `ShipCostAdapter` interface (mirror of `AdPlatformAdapter`, `app/lib/ads/adapter.ts:47-51`)

New file `app/lib/ship-cost/adapters/adapter.ts`:

```ts
export type ShipProvider = "easypost";          // grows: + "shippo", + "shipbob", …
export type ShipIntegrationKind = "easypost_ship"; // grows; one enum value per provider (C7)

export interface NormalizedShipmentCost {
  externalId: string;        // provider's stable charge/shipment/transaction id — idempotency key
  orderRef: string | null;   // provider reference / order name, if present
  trackingNo: string | null; // tracking number, if present
  costCents: number;         // ACTUAL paid amount, integer cents (parse provider decimal strings carefully)
  currency: string;          // e.g. "USD"
  shippedAt: string | null;  // ISO-8601, if present
  carrier: string | null;    // e.g. "USPS"
}

export interface ShipSource {                          // per-shop authenticated handle (mirror ShopAdSource)
  fetchCharges(since: string | null): Promise<NormalizedShipmentCost[]>;
}

export interface ShipCostAdapter {
  readonly provider: ShipProvider;
  readonly integrationKind: ShipIntegrationKind;
  connect(shopId: string): Promise<ShipSource | null>; // null = no usable creds → cron marks "skipped"
}
```

The generic core never branches on provider — exactly like the ad core. All provider specifics live behind `connect()` / `fetchCharges()`.

### C2 — Registry + shop selection (mirror `app/lib/ads/registry.server.ts:10-34`)

New file `app/lib/ship-cost/adapters/registry.server.ts`:

```ts
export const SHIP_ADAPTERS: ShipCostAdapter[] = [easyPostAdapter]; // + shippoAdapter in Phase 2
const BY_KIND = new Map(SHIP_ADAPTERS.map((a) => [a.integrationKind, a]));
export interface ShipWorkItem { shopId: string; status: string; adapter: ShipCostAdapter; }
export async function shipAdaptersForShops(sb: SupabaseClient): Promise<ShipWorkItem[]>;
//   SELECT shop_id, kind, sync_status FROM shop_integrations
//   WHERE kind IN ('easypost_ship', …) AND sync_status IN (<connectable statuses>)
```

> **⚠️ Status-filter trap — CONFIRMED LIVE (resolved, see §8.1).** The ad registry filters `sync_status IN ('pending','live')`, but the connect flow writes `sync_status = 'ready'` (verified `auth.quickbooks.$.tsx:96`). A freshly-connected shop at `'ready'` would never be picked up — the same class of bug that already bit the *other* cron (session memory S302/S303). **Pinned:** `shipAdaptersForShops` selects `sync_status IN ('ready','pending','live')`.

### C3 — Poll cron `/cron/ingest-ship-costs` (mirror `app/routes/cron.ingest-ads.tsx`)

New route `app/routes/cron.ingest-ship-costs.tsx`:

- **Auth:** `isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)` → 401 (`app/lib/cron-auth.server.ts`).
- **Loop:** `work = await shipAdaptersForShops(sb)`; `mapWithConcurrency(work, CONCURRENCY, runOne)` — per-slot error isolation; a thrown error goes to `summary.errors`, never fatal to the batch.
- **`runOne(item)`:** `src = await adapter.connect(shopId)`; `null` → `summary.skipped`. Else `charges = await src.fetchCharges(since)` where **`since` = a trailing re-pull window** (carrier costs settle/adjust post-ship → re-pull, e.g. last 14–30 days, even on the daily poll). Land (C4). Then **`await runShipCostResolution(sb, shopId, { shopCountry })`** — resolve `shopCountry` the same way the existing CSV/typed callers do (note the known `getShopCountry` stub; pass `null` degrades allocation gracefully, runner.server.ts:31-33).
- **Bookkeeping:** mirror `setSync(shopId, kind, patch)` (cron.ingest-ads.tsx:11-24, **throws on supabase error**):
  - success → `{ sync_status:'live', sync_error:null, last_sync_at:now }`
  - failure → `{ sync_status:'error', sync_error:msg.slice(0,500) }` (best-effort, never masks the original error).
- **Schedule:** register the cron (daily). **Mind the recent prod 501 incidents** (commits `551dabf`, `b486895`) — register the path correctly in the Vercel cron config; do not collide with a function path.

### C4 — Landing (mirror `ingestInvoiceCsv`, `app/lib/ship-cost/inputs.server.ts:46-109`, adapted)

New file `app/lib/ship-cost/adapters/land.server.ts`. Per shop, per sync:

1. **Ensure the synthetic period** for `(shop, provider)` exists:
   `SELECT id FROM shipping_cost_period WHERE shop_id=? AND source='connector' AND carrier=<provider>` → if absent, `INSERT (shop_id, period_start, period_end, carrier=<provider>, total_cents=0, source='connector') RETURNING id`. Add a **partial unique index** `(shop_id, carrier) WHERE source='connector'` (migration, §4) so creation is race-safe / idempotent. `period_start`/`period_end` are cosmetic (fenced from allocation by C6) — use a wide sentinel range.
2. **Match** charges → orders (reuse `matchInvoiceLines`, C5).
3. **Pre-aggregate matched charges by `matched_order_id` (sum `cost_cents`)** → exactly one line per order (dodges the resolver's last-write-wins). Unmatched charges (no order) are **not** aggregated — they land individually (C5).
4. **Idempotent upsert** into `shipping_invoice_line` under the synthetic `period_id`. Strategy (no line-table schema change, per D1):
   **delete-by-`(period_id, key-set)` then insert** — `DELETE … WHERE period_id=<synthetic> AND (tracking_no IN (<window keys>) OR (tracking_no IS NULL AND order_ref IN (<window keys>)))`, then insert the freshly-computed rows. The re-pull window's keys scope the delete; rows outside the window are untouched.
   - *Idempotency key (resolved, see §8.2 — recommended, pending user veto):* `tracking_no` alone can change mid-window (label regenerated) → a delete-by-keyset orphan. **Phase 1 ships `shipping_invoice_line.external_charge_id text` as a strictly-additive, nullable, no-constraint column** (the provider's stable id), keying the delete-and-replace on it. The unique index (true `onConflict` upsert) is deferred to Phase 3 — the additive-now choice means that later index needs zero backfill. This is the **one** line-table change; D1's intent (no FK restructuring) is preserved.
5. **Recompute** synthetic `total_cents = Σ(its lines)` (honest; unused by allocation due to C6).
6. **Surface unmatched** (rule 12): rows with `matched_order_id = NULL` still land (never dropped) and feed a visible "unmatched carrier charges" count/list in the UI (C7). Mirror the CSV path, which already inserts unmatched lines.
7. **Resolve:** `await runShipCostResolution(...)` (done in C3 after landing).

### C5 — Matching (reuse `matchInvoiceLines`, `app/lib/ship-cost/match.ts:26-49`, **as-is**)

- Order-ref match first via `normOrder` (`ref.replace(/^#/,"").trim().toLowerCase()`), then **tracking-number fallback** (`trim().toLowerCase()`, no `#` strip). No changes to `match.ts`.
- Map `NormalizedShipmentCost` → `ParsedInvoiceRow { orderRef, trackingNo, costCents }`. Load `MatchOrder[]` from `order_fact (id, order_number)` + `fulfillment_fact (order_id, tracking_no)` exactly as the CSV path does (inputs.server.ts:54-69).
- **Match-rate caveat (provider-dependent):** if we don't control label creation, the provider may carry no order reference → matching leans entirely on `tracking_no` lining up between the provider and Shopify fulfillments. Phase docs quantify expected match rate per provider and rely on tracking as the primary key when `orderRef` is absent.

### C6 — Allocation fence (**the ONLY resolver change in the whole feature**)

D1 (synthetic period) means a carrier period would otherwise inflate the period-allocation pool. Verified at `app/lib/ship-cost/runner.server.ts:35-39` — it sums `total_cents` across **all** periods, then spreads it over **every** order (`reconciled` tier) and drives `fallbackFlat`. Without the fence, real carrier money leaks onto orders that never had a carrier shipment. **The fix is one line:**

```ts
// runner.server.ts:35-36
const { data: periods } = await sb
  .from("shipping_cost_period").select("total_cents").eq("shop_id", shopId)
  .in("source", ["upload", "typed"]);   // ← exclude source='connector' synthetic periods
```

Companion requirement (resolved, see §8.3): any **manual-period UI list** must also exclude `source='connector'` so synthetic periods never appear as merchant-created. **No such period-list query exists on either surface today**, so the runner fence alone fully prevents the double-count in Phase 1 — this exclusion is a **forward-looking rule** that binds whenever such a UI is added.

> Rejected alternative: setting synthetic `total_cents = 0` to avoid the resolver edit — it's a hidden invariant the next dev silently breaks by "fixing" the 0. The explicit `source` fence is self-documenting.

### C7 — Integrations wiring (connect/disconnect + UI, **both surfaces**)

- **Enum (the single biggest prerequisite):** `integration_kind` is a Postgres enum (`shopify, meta_ads, google_ads, quickbooks, tiktok_ads`) gating both `shop_integrations.kind` **and** `integration_credentials.kind`. Each provider needs `ALTER TYPE public.integration_kind ADD VALUE '<kind>';` in **its own migration step** — a freshly-added enum value cannot be used in the same transaction (precedent: `20260606120000_tiktok_platform.sql:3-7`).
- **Provider type:** add to `IntegrationProvider` (`app/lib/calderyn.server.ts:65`) and the maps `PROVIDER_TO_KIND` / `KIND_TO_PROVIDER` (`app/lib/integrations.ts:41-45, 94-98`).
- **Connect flow:** EasyPost/Shippo do **not** use Shopify's embedded session — follow the existing per-provider connect pattern (`startOAuth` ladder `calderyn.server.ts:992-1073`, route `auth.<provider>.$.tsx`, `consumeOAuthState`). **But the connect *mechanism* differs by provider** (API-key vs OAuth) — Phase docs own the specifics. See §C8.
- **Secrets:** store credentials in **`integration_credentials.access_token_encrypted`** (AES-256-GCM via `app/lib/crypto.server.ts`), upsert on `(shop_id, kind)` — **not** the legacy `shop_integrations.access_token_enc` bytea columns. Merchant-facing status (`sync_status`, `connected_at`, `external_account_id`) goes in `shop_integrations`. Per repo rule: client IDs/secrets in `.env.local`, update `.env.example`.
- **Embedded app UI** (`app/routes/app.settings.tsx`): the card list is kind-agnostic (`Object.entries(integrations).map(... <IntegrationCard/>)`, :543-545); `IntegrationCard` (:849-917) renders Connect (`connect_integration` :316-333) / Disconnect (`disconnect_integration` :335-342). New kind appears automatically once it's in the integrations record + display constants.
- **Dashboard UI** (`app/components/dashboard/screens/Settings.tsx:380-401`): **read-only status pills only** (explicit "connect/disconnect lives in the embedded app", :383). New kind shows automatically via `integrations.list` → `adaptIntegrations` (`client.ts:339-357`). **Parity work = add the kind to the display constants:** the defaults map `calderyn.server.ts:960-966` + `INTEGRATION_DISPLAY_NAME` / `INTEGRATION_LOGO_CLS` / `INTEGRATION_ORDER`.

### C8 — Connect mechanism is provider-specific (do not over-abstract)

For a **cost connector that reads a merchant's existing account**, the connect mechanism is whatever that provider offers for third-party read access:
- **EasyPost (Phase 1): merchant pastes their EasyPost API key** (Basic auth, key-as-username), stored encrypted in `integration_credentials`. We then read `GET /v2/shipments?purchased=true`. *(EasyPost "Forge" provisions NEW sub-accounts — a different product that changes the merchant's label-buying workflow and gives no history for merchants already on their own account. Out of Phase 1 scope; note as a future product fork, not the cost-connector path.)*
- **Shippo (Phase 2): per-merchant OAuth** (`Bearer oauth.<token>`, co-branded) — requires Shippo partner-program approval first.

`ShipCostAdapter.connect()` hides this: it reads the stored credential and returns a `ShipSource`, regardless of how the credential was obtained.

### C9 — Kind / provider naming convention

`<provider>_ship` for the integration kind: `easypost_ship`, `shippo_ship`, `shipbob_ship`, … (namespaces ship-cost connectors; avoids colliding with the base `shopify` kind). Provider id is the bare name: `easypost`, `shippo`.

---

## 4. Schema deltas (consolidated; phase-tagged)

All via `prisma migrate` / Supabase migrations — **never hand-edit applied migrations.** RLS: `shipping_invoice_line` / `shipping_cost_period` are service-role-only (deny-by-default, no policies) — the cron uses the service-role key; keep it that way.

| Δ | Phase | Migration |
|---|-------|-----------|
| Add `'connector'` to `shipping_cost_period.source` CHECK | 1 | `ALTER TABLE … DROP CONSTRAINT shipping_cost_period_source_check, ADD CONSTRAINT … CHECK (source IN ('upload','typed','connector'));` |
| Allocation fence | 1 | `runner.server.ts:35-36` `.in("source", ["upload","typed"])` (code, not SQL) |
| Race-safe synthetic period | 1 | `CREATE UNIQUE INDEX … ON shipping_cost_period (shop_id, carrier) WHERE source='connector';` |
| `integration_kind` += `'easypost_ship'` | 1 | `ALTER TYPE public.integration_kind ADD VALUE 'easypost_ship';` (own migration step) |
| `integration_kind` += `'shippo_ship'` | 2 | same pattern |
| `integration_kind` += 3PL kinds | 3 | same pattern |
| `shipping_invoice_line.external_charge_id text` (nullable, additive) | 1 | `ALTER TABLE … ADD COLUMN external_charge_id text;` — idempotency key (§8.2) |
| `UNIQUE (shop_id, external_charge_id)` index | 3 | deferred; zero backfill thanks to the nullable column shipping in Phase 1 |

**The line table itself does not change** under D1 (that was the point of choosing the synthetic period).

---

## 5. Known gaps & risks (rule 12 — surfaced, not buried)

1. **Post-purchase carrier adjustments are doc-unconfirmed for both providers.** Initial label cost is solid (`selected_rate.rate` / `rate.amount`). But carrier adjustments (USPS APV etc.) arrive later via separate report/invoice APIs, and **whether an adjustment links back to the original shipment/order is not confirmable from docs** (EasyPost `shipment_invoice` report columns; Shippo beta Invoices link-back). → **Phase 3 starts with a live API spike** before building reconciliation on this. Until then, "actual_invoice" = the label cost at purchase; adjustments are a known follow-up.
2. **Match rate depends on tracking-number alignment** when the provider carries no order reference (C5). Quantify per provider; tracking is the primary key.
3. **Coverage is intrinsically partial** — only merchants who buy labels through a connected system get true cost; the rest stay on modeled (#3, weight model) / CSV / fallback. This is by design and is the honest, confidence-ranked Ship-P&L story; the UI must not imply universal coverage.
4. **`shopCountry` stub** — the runner needs origin country for zone allocation; a known stub passes `null` (degrades gracefully). Not blocking, but noted.

---

## 6. Phase boundaries (what each doc owns)

- **Phase 1 — `01-phase-1-easypost-framework.md`:** the entire spine in §3 (C1–C9) + the §4 Phase-1 migrations + **EasyPost as adapter #1** (API-key connect, `GET /v2/shipments?purchased=true`, `selected_rate.rate`, `reference`/`tracking_code` match, `before_id`/`after_id` pagination, `shipment.invoice.*` webhook awareness). Both-surface integration UI. This is the heavy phase.
- **Phase 2 — `02-phase-2-shippo-adapter.md`:** **Shippo as adapter #2** against the now-existing framework — proves generality. Shippo OAuth (partner-program gate), `GET /transactions/?object_status=SUCCESS`, `rate.amount`, `metadata` match-back (≤100 chars), `transaction_created` webhook, `page`/`results` pagination. Mostly "implement `ShipCostAdapter` + connect flow + display constants + enum value"; near-zero new framework.
- **Phase 3 — `03-phase-3-reconciliation-and-3pl.md`:** (a) **carrier-adjustment reconciliation** — open with the live spike (risk #1), then design how adjustments update landed rows; (b) **additional adapters** for 3PL houses (ShipBob/ShipHero) as further drop-ins; (c) unmatched-charge surfacing UI hardening.

---

## 7. Dashboard parity (mandatory, per repo CLAUDE.md)

The dashboard lives in **this repo** at `app/routes/dashboard.*` + `app/components/dashboard/*`. Connect/disconnect is **embedded-app-only**; the dashboard shows integration **status read-only** and auto-renders the new kind once it's in `integrations.list` + the display constants (C7). Every phase that adds a provider does the display-constant parity work in the same change — never single-sided. The dashboard re-implements against its own stack (raw `postgres`/`withShopContext`); **match the data contract, not the Polaris code.**

---

## 8. Resolved contract concerns (post-writer integration, 2026-06-16)

The three phase writers pressure-tested this contract against the real code. Resolutions are folded back here so the spine stays authoritative.

**8.1 — C2 status filter — trap confirmed LIVE.** Phase 1 verified the connect flow writes `sync_status='ready'` (`auth.quickbooks.$.tsx:96`), which the inherited `IN ('pending','live')` filter would never select. **Pinned:** `shipAdaptersForShops` uses `sync_status IN ('ready','pending','live')`.

**8.2 — C4.4 idempotency key — ship the additive column (recommended; pending user veto).** A trailing-window re-pull (cheap; the right default) needs a stable per-charge key to delete-and-replace safely. The only no-column key, `tracking_no`, can change mid-window (label regenerated) → orphan row. **Recommendation:** Phase 1 ships `shipping_invoice_line.external_charge_id text` — *strictly additive, nullable, no constraint* — populated from the provider's stable id. It's the **one** line-table change; counter to D1's letter ("no line-table change") but not its intent (D1 was about not restructuring the `period_id` FK). The no-column alternative is full-replace-each-sync, which re-pulls entire history daily (100/page → heavy for high-volume shops) — rejected as the default. **User may veto** → fall back to full-replace or `tracking_no`-only keying.

**8.3 — C6 companion UI fence — vacuously satisfied today.** No manual-period-list query exists on either surface, so the runner fence (C6) alone prevents the double-count in Phase 1. The "exclude `source='connector'` from period lists" rule is forward-looking.

**8.4 — External-provider verdicts (Phase 3 research).** Unlike Shopify (no API path to true cost), **both 3PL houses expose true per-order cost** — ShipBob via Billing transactions (`amount` + `reference_type="Shipment"`→`reference_id`), ShipHero via GraphQL `shipping_labels { cost }` + `partner_order_id`. Caveat: a community-reported ShipHero config can read label `cost = 0`; a per-account read-only confirmation must gate any `actual_invoice` confidence claim. EasyPost adjustment link-back is now *likely* (the `shipment_invoice` report documents `Shipment ID`/`Tracking Code`/`Package Dispute ID`) but stays formally **unconfirmed** until the Phase 3 spike (those columns are documented for the CSV export, not yet confirmed in API rows).

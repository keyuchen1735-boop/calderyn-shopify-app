# EasyPost Carrier Rate-Quote Adapter — Design Spec

**Date:** 2026-06-28
**Status:** Design committed. Module 1 of 3 standalone slices in `feat/external-integrations`. ZERO dependency on teammate "John". Grounded in a full read of the existing ship-cost adapter family (`app/lib/ship-cost/adapters/*`) and the platform-pivot master spec (`2026-06-27-calderyn-platform-pivot-design.md`, `extend:ShipCostAdapter` §lines 242-266, `#6.3` §lines 267-292).
**Spec feature:** `extend:ShipCostAdapter` (the rate-quote / buyer-facing direction).

---

## What it is

A second, **QUOTE-direction** capability on Calderyn's existing provider-blind shipping adapter contract. The existing adapter family fetches **ACTUAL PAID** charges for cost analytics (`NormalizedShipmentCost`, post-purchase `selected_rate.rate`). This module adds a `getRates(...)` path that, given an **origin + destination + parcels + requested service levels**, returns **live carrier rate OPTIONS** (`NormalizedRateOption[]`).

It reuses the same `integration_credentials` store, `crypto.server.ts` decryption, the provider-blind seam, and the failure-visibility discipline of the cost side — but hits EasyPost's **rate-quote** endpoint (`POST /v2/shipments`, then read **all** `rates[]`) instead of the charges endpoint (`GET /v2/shipments?purchased=true`, read `selected_rate`).

The adapter takes parcels as **INPUT** and returns rates as **OUTPUT**, so it is **catalog-independent**. Parcel assembly from the catalog and merchant markup / free-ship / zone rules are explicitly **NOT** here — they live in the `#6.3` quote engine, which **consumes** this adapter and is **out of scope** for this spec (see *Out of scope*).

MVP-thin ships **one aggregator** (EasyPost: USPS / UPS / FedEx behind one credential). The deep version (direct carrier accounts, more providers, negotiated rates) is later deepening.

---

## Includes

- **New `app/lib/ship-cost/adapters/rate-quote.ts`** — pure contract (no `.server`, mirrors `adapter.ts`): the `RateQuoteAdapter` interface, the `RateQuoteSource` handle, and the `NormalizedRateOption`, `RateRequest`, `RateQuoteResult`, `Address`, `Parcel` types. Provider-blind; callers never branch on carrier.
- **New `app/lib/ship-cost/adapters/easypost-rate.server.ts`** — the EasyPost rate-quote implementation. `connect(shopId) → RateQuoteSource | null` reusing `integration_credentials` kind `easypost_ship` + `decrypt`. `getRates(req)` does `POST /v2/shipments` (create with `to`/`from`/`parcel`), reads **all** `rates[]` (NOT `selected_rate`), and normalizes each to `NormalizedRateOption` via the **reused** `parseRateToCents`.
- **Hard timeout (~5s p95)** via built-in `AbortController` passed to `fetch`'s `signal`.
- **Static fallback rate table** (`buildFallbackOptions(req)`) returning `NormalizedRateOption[]` from a simple zone/weight static table, surfaced behind a `fallbackUsed` flag. **Load-bearing** — a slow/down carrier must not break the caller (no rate = no sale at checkout).
- **No new npm dependency** — built-in `fetch` + HTTP Basic auth (key as username, empty password), exactly like the existing EasyPost cost adapter. Repo rule P6.
- **Deferred — `ship_rate_quote_log`** observability table (write-only sink for latency + fallback rate): **not built in this slice** (YAGNI for the adapter spike). The adapter surfaces `latencyMs` + `fallbackUsed` on every `RateQuoteResult`, so persistent logging can be added later (in `#6.3`) without an adapter change. Kept as a future option, not a v1 deliverable. Not a cache (caching is the engine's job).
- Negotiated-rate support is **deferred to v2** (list rates only in v1). Each option carries a `rateType: "list" | "negotiated"` provenance field (always `"list"` in v1) so `#6.3` can later reconcile margin against the negotiated amounts the cost side records. See *MVP rationale* and `// ponytail`.

---

## Depends on

- **None from John.** Standalone; reuses only already-merged ship-cost primitives (`adapter.ts`, `easypost.server.ts`, `crypto.server.ts`, `integration_credentials`).
- **Consumed by `#6.3`** (single-source-of-truth quote engine) **later** — `#6.3` calls `connect()` → `getRates()` and layers parcel assembly, markup, free-ship, zone overrides, and the delivery-window on top. This adapter does **not** depend on `#6.3`; it is built and tested in isolation.

---

## Data model / contracts

### `rate-quote.ts` (NET-NEW contract — mirrors `adapter.ts`)

The two-level shape mirrors `ShipCostAdapter` (`connect`) + `ShipSource` (`fetchCharges`): an adapter plug that authenticates, and a per-shop source handle that does the work.

**`RateQuoteAdapter`** (mirrors `ShipCostAdapter`, `adapter.ts:43-50`):
- `readonly provider: ShipProvider` — reuse the existing `ShipProvider` union (`adapter.ts:7`).
- `readonly integrationKind: ShipIntegrationKind` — reuse (`adapter.ts:9`), value `"easypost_ship"`.
- `connect(shopId: string): Promise<RateQuoteSource | null>` — **same semantics as the cost side**: `null` = no credential stored (shop not connected); **THROW** = credential stored but broken (failure-visibility, rule 12). Config-time, not runtime.

**`RateQuoteSource`** (mirrors `ShipSource`, `adapter.ts:34-40`):
- `getRates(req: RateRequest): Promise<RateQuoteResult>` — runtime. **Never throws on carrier slowness/down** — degrades to fallback (see *Timeout/fallback contract*).

**`RateRequest`**:
- `origin: Address`
- `destination: Address`
- `parcels: Parcel[]` — array for forward-compat; **v1 uses `parcels[0]` only** (`// ponytail: single-parcel; upgrade path = multi-parcel packing in #6.3`).
- `serviceFilter?: string[]` — optional list of `serviceCode`s; when present, returned options are filtered to that set (client-side filter on the returned `rates[]`; `// ponytail: filter after the call, not a server-side constraint`).

**`Address`** (provider-blind input the adapter maps to EasyPost's address body):
- `name?: string`, `company?: string`, `street1: string`, `street2?: string`, `city: string`, `state: string`, `zip: string`, `country: string` (ISO-2, default `"US"`), `phone?: string`.

**`Parcel`** (provider-blind; adapter maps to EasyPost's `parcel` body):
- `lengthIn: number`, `widthIn: number`, `heightIn: number` (inches), `weightOz: number` (ounces).

**`NormalizedRateOption`** (the per-option DTO, mirrors `NormalizedShipmentCost` discipline — callers never branch on carrier):
| field | type | source from EasyPost `rates[]` element |
|---|---|---|
| `carrier` | `string` | `rate.carrier` (e.g. `"USPS"`) |
| `serviceCode` | `string` | `rate.service` (e.g. `"Priority"`) |
| `serviceName` | `string` | `rate.service` (`// ponytail: serviceCode === serviceName until a display map exists`) |
| `amountCents` | `number` | `parseRateToCents(rate.rate)` — **reused verbatim**; option **skipped** if `null` (malformed/negative → not coerced to 0, rule 12) |
| `currency` | `string` | `rate.currency` ?? `"USD"` |
| `estTransitDays` | `number \| null` | `rate.delivery_days` ?? `rate.est_delivery_days` ?? `null` |
| `guaranteed` | `boolean` | `rate.delivery_date_guaranteed === true` |
| `deliveryDateEstimate` | `string \| null` | `rate.delivery_date` ?? `null` |
| `rateType` | `"list" \| "negotiated"` | always `"list"` in v1 (EasyPost `rate` = list rate; negotiated needs attached `carrier_accounts`) — provenance for `#6.3` margin reconciliation |

**`RateQuoteResult`** (result-level wrapper carrying the `fallback_used` flag — the per-option type can't):
- `options: NormalizedRateOption[]`
- `fallbackUsed: boolean`
- `latencyMs: number`
- `provider: ShipProvider`

### `ship_rate_quote_log` (DEFERRED — not built in this slice)

Per the master spec §256. A write-only sink for latency + degraded-mode visibility (rule 12), **not** a cache (request-hash caching is the engine's job, `#6.3` §276). **Deferred (YAGNI for this adapter spike)** — the adapter functions fully without it and already returns `latencyMs`/`fallbackUsed` on `RateQuoteResult`. The schema below is recorded as the future shape; building it is out of scope for this slice and belongs with `#6.3`.

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `shop_id` | text | tenant scope (no RLS — manual `.eq("shop_id", …)`, mirroring the cost side) |
| `request_hash` | text | stable hash of the normalized `RateRequest` (observability/dedup only) |
| `provider` | text | `"easypost"` |
| `options` | jsonb | the returned `NormalizedRateOption[]` |
| `latency_ms` | integer | measured carrier round-trip |
| `fallback_used` | boolean | true when the static table was returned |
| `created_at` | timestamptz | default `now()` |

When built later, the schema change goes through `prisma migrate dev` (or a Supabase migration consistent with the existing `supabase/migrations/*ship*` files); never hand-edited. **Not built in this slice** — the adapter has no dependency on this table; logging would be added best-effort behind its presence when `#6.3` lands it.

---

## Grounding

### EXISTS (reused; cite `file:line`)

- **Provider-blind contract to mirror** — `app/lib/ship-cost/adapters/adapter.ts`:
  - `ShipProvider` union (`:7`) and `ShipIntegrationKind` union (`:9-13`) — **reused as-is** (`easypost_ship` is already a member).
  - `ShipCostAdapter` (`:43-50`) + `ShipSource` (`:34-40`) — the **shape `RateQuoteAdapter` / `RateQuoteSource` mirror**.
  - `NormalizedShipmentCost` (`:16-31`) — the normalization **discipline** `NormalizedRateOption` follows (provider-blind, integer cents, no carrier branching).
  - `connect()` semantics: `null` = not connected, **THROW** = stored-but-broken (`:46-49`) — **preserved verbatim** on `RateQuoteAdapter.connect`.
- **EasyPost pieces to reuse** — `app/lib/ship-cost/adapters/easypost.server.ts`:
  - `parseRateToCents` (`:49-56`) — **exported; reused VERBATIM** (decimal-string → integer cents, no float drift; returns `null` for malformed/negative → caller skips, rule 12). The recorded-fixture test asserts this reuse.
  - `basicAuthHeader` (`:39-42`) — HTTP Basic, key as username + empty password (`base64("KEY:")`). **Decision: add `export` (one line) and reuse verbatim** — single source of the HTTP Basic logic, no duplication (rule 3).
  - `apiBase()` (`:81-85`) — reads optional `EASYPOST_API_BASE` env over the `DEFAULT_BASE` const, defaults to `https://api.easypost.com/v2`. **Decision: add `export` (one line) and reuse verbatim** — the rate adapter calls the same base-URL resolver instead of re-deriving the env override + trailing-slash strip.
  - Credential load pattern (`connect`, `:155-169`): `integration_credentials` row by `(shop_id, kind="easypost_ship")`, `decrypt(access_token_encrypted)` via `crypto.server.ts` (`:11`), `null` when absent. **Reused verbatim** for `easypost-rate.server.ts`'s `connect`.
  - Non-2xx handling (`:115-120`): throw with `status + statusText + body snippet`. **Reused** — but only for `connect`-time config errors; runtime carrier failures in `getRates` are caught and degraded (see *Timeout/fallback*).
  - `MAX_PAGES` runaway guard (`:16`) / paging — **NOT applicable here**: `POST /v2/shipments` returns all `rates[]` for one shipment in a single response; there is no cursor to walk.
- **Cron / failure-visibility discipline to mirror** — `land.server.ts` (surface every skipped/dropped record, never silently coerce, rule 12) and `registry.server.ts` (`SHIP_ADAPTERS`, `BY_KIND`, provider-blind selection). The rate adapter is **request-driven, not cron-driven** (called per quote by `#6.3`), so it does **not** register in `registry.server.ts`'s cron set — but it adopts the same failure-visibility posture (tally/log skipped options, flag fallback).
- **Credential kind already supported** — `supabase/migrations/20260616140000_easypost_integration_kind.sql:8` adds `easypost_ship` to the `integration_kind` enum (and `20260616150000_shippo_ship_kind.sql` adds `shippo_ship`). **No new credential table.**
- **Env already present** — `.env.example:172-179`: `EASYPOST_API_BASE` documented; each merchant pastes their own key, stored encrypted in `integration_credentials` (kind `easypost_ship`). **No new app-level secret.**

### NET-NEW

- The `RateQuoteAdapter` / `RateQuoteSource` contract + `NormalizedRateOption` / `RateRequest` / `RateQuoteResult` / `Address` / `Parcel` types (`rate-quote.ts`).
- `easypost-rate.server.ts`: the `POST /v2/shipments` create call, the `rates[]` reader/normalizer (a different request+response shape from the cost side's `GET …?purchased=true` + `selected_rate`), the timeout wrapper, and the static-fallback path.
- The `buildFallbackOptions(req)` helper + the static zone/weight rate table.
- The `ship_rate_quote_log` table — **deferred** (recorded as a future option, not built in this slice).

### Honest gap (grep-confirmed)

There is **NO buyer rate-quote call anywhere in the repo today** — the only `/v2/shipments` usage is the cost-side `GET …?purchased=true` reading `selected_rate` (`easypost.server.ts:4,88`). This module is the first quote-direction code. `selected_rate` is the *chosen, purchased* rate (one); `rates[]` is the *available options* list (many) returned at shipment-create time — same endpoint family, different verb (`POST` vs `GET`), different field. The cost side is post-purchase truth; this side is pre-purchase options.

---

## Timeout / fallback contract

**This is load-bearing.** At a real checkout, the carrier callback must answer fast, and "no rate" means "no sale." Carrier APIs are slow and flaky. Therefore:

1. **Hard p95 budget ≈ 5s.** `getRates` wraps the `fetch` in an `AbortController` with a ~5s timeout (built-in; no dependency). The exact ms is a module constant (e.g. `RATE_TIMEOUT_MS = 5000`).
2. **Degrade, never throw (runtime).** On **abort/timeout**, **network error**, **non-2xx**, **malformed body**, or **empty `rates[]`** (e.g. the credential is valid for cost-side reads but has no carrier accounts attached for rate-shopping), `getRates` returns `RateQuoteResult { options: buildFallbackOptions(req), fallbackUsed: true, latencyMs, provider }`. It does **not** propagate the error to the caller.
3. **`connect()` keeps its throw semantics.** `connect()` is config-time: `null` when no credential, **throw** when a credential is stored but structurally broken. The runtime degrade-to-fallback lives in `getRates`, not `connect`. The decision to fall back when `connect()` returns `null` or throws belongs to the **engine** (`#6.3`, out of scope) — but `buildFallbackOptions` is **exported** so the engine reuses the same static table rather than re-implementing it.
4. **Static fallback table.** A simple in-module **zone × weight-band → cents** table yielding a small set of conservative `NormalizedRateOption`s (e.g. one economy + one expedited) with `estTransitDays`/`guaranteed`/`deliveryDateEstimate` set conservatively (`guaranteed: false`, `deliveryDateEstimate: null`). `// ponytail:` hardcoded constant table; **upgrade path = the merchant-configurable `ship_fallback_rate` table** owned by `#6.3` (master spec §282).
5. **Visibility (rule 12).** Every fallback is flagged (`fallbackUsed: true`) and the round-trip is surfaced via `RateQuoteResult.latencyMs` (persistent logging via `ship_rate_quote_log` is deferred — see *Data model*). Options skipped for malformed/negative rate (`parseRateToCents` → `null`) are dropped from `options`, never coerced to 0.

---

## MVP rationale

"Real carrier rates" is in the feature's one-line definition and is **on by default** — the first real buyer must see a real rate. One aggregator (EasyPost) delivering USPS/UPS/FedEx behind a single credential the merchant already pastes for the cost side is the **thinnest real version**. Reading `rates[]` from a freshly created shipment is the documented EasyPost rate-shopping flow; no SDK, no new auth model, no new secret. **List rates** (not negotiated) are correct for v1 because they require no carrier-account configuration and are never *wrong* for a buyer-facing quote — negotiated rates only *improve margin* and are a fast-follow (`// ponytail: list rates only; upgrade path = negotiated rates via attached carrier_accounts`). The timeout + static fallback is non-negotiable in v1 because without it a slow carrier silently blocks checkout.

---

## Risks

- **Carrier slowness/flakiness blocking the caller.** Mitigated by the hard ~5s timeout + mandatory static fallback (above). Without it, a single slow carrier times out the checkout callback and Shopify (or our own checkout) shows **no** rates → blocked sale. This is why fallback is load-bearing, not optional.
- **Rate-shopping creds the merchant may not have configured.** The `easypost_ship` key may have been added purely for cost-side reads; rate-shopping can require carrier accounts attached in EasyPost. Symptom: `connect()` succeeds, `POST /v2/shipments` returns 200 with an **empty `rates[]`**. Handled by treating empty `rates[]` as a fallback trigger (degrade, flag, log) rather than returning zero options.
- **Negotiated vs list rates vs the cost side.** This adapter quotes **list** rates; the cost side records **actual paid** (possibly negotiated) charges. If `#6.3` builds margin off list quotes while the cost side reconciles against negotiated paid amounts, margin can be mis-stated. Out of scope to reconcile here, but supported for `#6.3`: each option carries `provider`, `serviceCode`, and the `rateType` (`"list" | "negotiated"`) provenance field so the engine can reconcile.
- **Cross-tenant leakage.** No Postgres RLS (service-role + manual `.eq("shop_id", …)`, like the rest of ship-cost). `connect` must scope the credential read by `shop_id`, and `ship_rate_quote_log` writes must carry `shop_id` — mirror the cost side exactly.

---

## Out of scope

- **`#6.3` quote engine** — merchant **markup / handling / free-ship threshold / zone overrides / blended-vs-cheapest selection**, **parcel assembly from the catalog** (`package_dim`, dim-weight, multi-box), and **delivery-window assembly** (combining transit days with origin handling/cutoff/business-calendar). This adapter takes parcels as input and returns raw carrier options; all merchant rules and packing live in `#6.3`.
- **CarrierService registration (`#6.4`)** — wiring these rates into Shopify's checkout shipping callback (or our own checkout) is a separate slice.
- **Multi-parcel packing** — v1 quotes `parcels[0]`; packing heuristics are a `#6.3` concern.
- **Request-hash caching** — `ship_rate_quote_log` is observability only; the short-TTL request-hash cache is the engine's (`#6.3` §276).
- **Negotiated rates / direct carrier accounts / additional providers (Shippo, etc.)** — deepening, not MVP.
- **Cron registration** — this is request-driven (per quote), not a scheduled pull; it does not join `registry.server.ts`'s `SHIP_ADAPTERS` cron set.

---

## Verification & success criteria

**One concrete runnable check** — a Vitest unit test (`app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`) against a **recorded EasyPost test-mode JSON fixture** (`__tests__/fixtures/easypost-rates.json`, offline + deterministic, captured once from the EasyPost test API and committed). It mirrors the existing `easypost.test.ts` mock-`fetch` style (inject `fetchImpl`, no network). The test asserts:

1. **Normalization** — the fixture's `rates[]` maps to the expected `NormalizedRateOption[]`: correct `carrier`, `serviceCode`/`serviceName`, `currency`, `estTransitDays` (from `delivery_days`/`est_delivery_days`), `guaranteed` (from `delivery_date_guaranteed`), `deliveryDateEstimate` (from `delivery_date`).
2. **`parseRateToCents` reuse** — a known fixture rate (e.g. `"7.39"`) normalizes to `739`; a malformed/negative rate present in the fixture is **dropped** from `options` (not coerced to 0), proving rule-12 skip behavior.
3. **Fallback on timeout** — with a `fetchImpl` stub that rejects with an `AbortError` (or never resolves under a shrunk timeout), `getRates` returns `{ options: <non-empty static table>, fallbackUsed: true }` **without throwing**, within the budget.
4. **Fallback on empty `rates[]`** — a 200 response with `rates: []` yields `fallbackUsed: true` (rate-shopping-not-configured path).
5. **`connect()` semantics** — `null` when no `integration_credentials` row; **throws** when the row exists but decrypt/shape is broken.

**Success criteria:** the above test passes; `npm run typecheck` and `npm run lint` are clean on the two new files; no new entry in `package.json` dependencies (grep the diff). The fixture-based test is the authoritative gate.

**Optional guarded live smoke** (not required for CI): an `it.skipIf(!process.env.EASYPOST_API_KEY)`-gated test that hits the EasyPost **test API** (`POST /v2/shipments`) and asserts ≥1 rate normalizes. If this is added, document a **test-mode** `EASYPOST_API_KEY` in `.env.local` (never `.env`, never committed) and add the commented placeholder line to `.env.example` next to the existing EasyPost block (`.env.example:172-179`). Production credentials remain in `integration_credentials`, not env.

---

## Dashboard parity

This slice is a **backend lib** with **no merchant-facing UI** yet — the dashboard parity rule's "new merchant-facing behavior" trigger does not fire at this layer. **`TODO(parity)`:** when `#6` rates surface to the merchant (rate preview, fallback indicator, or a "shipping rates" settings/diagnostics view), mirror that surface into the Calderyn dashboard (`app/routes/dashboard.*`) against its own stack — match the `NormalizedRateOption` / `RateQuoteResult` contract, do not port Polaris JSX. Stated here so it is not silently skipped; this spec ships the adapter only, single-sided by design.

---

## Resolved decisions

1. **Export `basicAuthHeader` + `apiBase` from `easypost.server.ts`.** Both were module-private (`easypost.server.ts:39`, `:81`). Resolution: add `export` to each (one line each, surgical) and reuse them **verbatim** in `easypost-rate.server.ts` — single source of the HTTP Basic + base-URL-resolution logic, **no duplication** (rule 3). `apiBase()` (not just the `DEFAULT_BASE` const) is exported so the env override + trailing-slash strip are reused, not re-derived.
2. **`ship_rate_quote_log` — DEFERRED (YAGNI for this adapter spike).** Not built in this slice. The adapter functions fully without it and already returns `latencyMs` + `fallbackUsed` on `RateQuoteResult`; persistent logging is kept as a future option for `#6.3` when it owns caching/zone config.
3. **Negotiated rates — DEFERRED to v2.** List rates only in v1. Each `NormalizedRateOption` carries a `rateType: "list" | "negotiated"` provenance field (always `"list"` in v1) so `#6.3` can later reconcile margin against the negotiated amounts the cost side records.

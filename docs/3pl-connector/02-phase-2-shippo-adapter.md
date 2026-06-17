# Phase 2 — Shippo Adapter (adapter #2)

> **Reads against the frozen contract** in [`00-overview-and-contract.md`](./00-overview-and-contract.md). This phase implements **Shippo as the second `ShipCostAdapter`** on top of the Phase‑1 framework. It MUST NOT re‑decide anything in contract §3–§5; it references C1–C9 and details ONLY what is new for Shippo.
>
> **This phase is deliberately THIN.** The adapter framework, registry, cron, landing, matching, the allocation fence, and the both‑surface integration UI were all built in **Phase 1**. Phase 2 = `connect()` mechanism (OAuth) + Shippo→`NormalizedShipmentCost` mapping + one registry entry + one enum value + display constants. **Near‑zero new framework.**
>
> Status: **design only** (no code). Author: Phase‑2 spec, grounded against the real integration wiring (cited file:line) and the Shippo OpenAPI spec `2018-02-08`.

---

## ⚠️ Contract concerns (raised, not diverged)

The contract is sound; two clauses need a Shippo‑specific *clarification* (not a change). Surfacing per rule 7/12 rather than silently averaging:

1. **C8 says Phase‑2 connect = "per‑merchant OAuth" — and Shippo OAuth genuinely fits the *existing* OAuth ladder, unlike EasyPost.** EasyPost (Phase 1) is an API‑key paste that does **not** use `startOAuth`/`OAUTH_PROVIDERS`/`connect_integration`. Shippo **does** use a real OAuth 2.0 authorization‑code flow, so — unlike Phase 1 — Phase 2 *does* extend `OAUTH_PROVIDERS`, `startOAuth`, `PROVIDER_TO_KIND`/`KIND_TO_PROVIDER`, `PROVIDER_DISPLAY`, and adds an `auth.shippo.$.tsx` callback. This is the **good** kind of framework reuse (Shippo slots into the QuickBooks‑style OAuth path); it is called out here only so the reader does not assume "Phase 2 looks like Phase 1's connect." See §5.

2. **Pagination cap — doc CONFLICT, resolved in favor of the spec (cap = 100).** A Shippo *prose* doc (`api_concepts/filtering`) says "use a `results` parameter less than 200." The **OpenAPI spec** parameter definition says `results` is "The number of results to return per page (**max 100, default 5**)" with `maximum: 100`. **Trust the spec → hard‑cap `results=100`.** Do not send 200. (Contract §6 already pinned this; restated because the prose doc actively contradicts.)

A third item is a *fact*, not a concern, but is load‑bearing for §4: on a **list** response, the Transaction `rate` field is `oneOf {CoreRate object | string id}` — i.e. it can come back as a bare rate‑id string rather than the nested object. The mapper must handle both (see §4.4).

---

## 1. Goal & success criteria

**Goal:** prove the Phase‑1 framework is provider‑general by dropping in a second adapter — land real per‑label shipping cost for merchants who buy labels through **Shippo**, so the existing resolver reads it as `actual_invoice` / `confidence: high` (contract §2). No new resolver behavior; no new framework.

**Success criteria:**
1. A merchant connects Shippo via co‑branded **OAuth** from the embedded Settings page; a per‑merchant `Bearer` token lands encrypted in `integration_credentials` and `shop_integrations(kind='shippo_ship')` flips to a connectable status (§5).
2. The cron (`cron.ingest-ship-costs`, contract C3 — **unchanged**) picks the shop up, calls `shippoAdapter.connect(shopId)` → `ShipSource`, and `fetchCharges(since)` returns `NormalizedShipmentCost[]` built from `GET /transactions/?object_status=SUCCESS`.
3. Charges land through the **existing** `land.server.ts` (C4) and match through the **existing** `matchInvoiceLines` (C5) with **no changes to either file**. Synthetic period uses `carrier='shippo'`, `source='connector'`.
4. A label whose cost is landed and whose order matches resolves to `actual_invoice`/`high` for that order (contract §2 invariants 1–5).
5. String amounts (`rate.amount = "5.52"`) parse to exact integer cents (`552`) — no float drift (§10).
6. Unmatched charges land with `matched_order_id = NULL` and surface in the existing "unmatched carrier charges" count (C4.6) — never silently dropped (rule 12).
7. **Dashboard parity:** the `shippo_ship` kind shows read‑only status on the dashboard Settings via display constants only (§12), in the same change.

**Non‑goals (this phase):** carrier post‑purchase adjustments (Invoices API beta) → Phase 3; any framework edits beyond the registry/enum/display deltas.

---

## 2. Scope

| In scope (Phase 2) | Out of scope (other phases / contract) |
|---|---|
| `ShippoAdapter` implementing `ShipCostAdapter` (C1): `connect()` + `ShipSource.fetchCharges()` | The `ShipCostAdapter` interface itself (C1 — Phase 1) |
| Shippo **OAuth** connect flow: `auth.shippo.$.tsx`, `startOAuth` `shippo` branch, credential storage | The registry/cron/land/match/fence **mechanism** (C2–C6 — Phase 1, reused unchanged) |
| `GET /transactions/?object_status=SUCCESS` fetch + `page`/`results` pagination | `runShipCostResolution`, resolver tiers (Phase 1 / pre‑existing) |
| Shippo `Transaction` → `NormalizedShipmentCost` mapping (incl. string→cents) | EasyPost adapter (Phase 1) |
| `SHIP_ADAPTERS += shippoAdapter`; `ShipProvider += "shippo"`; `ShipIntegrationKind += "shippo_ship"` | Carrier adjustment reconciliation, Invoices API (Phase 3, contract §5 risk #1) |
| Schema: `integration_kind += 'shippo_ship'` (own migration step) | Any `shipping_invoice_line` / `shipping_cost_period` table change (none — D1) |
| Both‑surface display constants for `shippo_ship` | The CSV upload path (untouched; universal fallback) |

---

## 3. Prerequisites

1. **Phase 1 shipped and merged** — the framework files exist (C1–C7). Phase 2 imports them; it does not define them.
2. **Shippo partner‑program approval (HARD GATE, lead‑time risk).** OAuth `client_id`/`client_secret` are **not self‑serve**: per Shippo docs you must "contact the sales team" (company name, callback URL, contact email, use case) at <https://goshippo.com/become-a-shippo-partner> and be approved before any `redirect_uri` works. **The redirect URI must be pre‑approved by Shippo.** This blocks end‑to‑end testing — start the partner application before code. (Risk §11.)
3. **Env keys** (`.env.local`, never `.env`/source; update `.env.example` per repo rule): `SHIPPO_CLIENT_ID`, `SHIPPO_CLIENT_SECRET`. (`SHOPIFY_APP_URL` already exists.) The callback registered with Shippo is `${SHOPIFY_APP_URL}/auth/shippo`.
4. **`INTEGRATION_ENCRYPTION_KEY`** already provisioned (used by `app/lib/crypto.server.ts:4` for AES‑256‑GCM) — reused as‑is.
5. **`integration_kind` enum migration** for `'shippo_ship'` applied in its **own** migration step before any code references the kind (§7; enum‑in‑same‑txn trap, precedent `20260606120000_tiktok_platform.sql:6‑7`).

---

## 4. Data contract — Shippo `Transaction` → `NormalizedShipmentCost`

Target type is frozen (C1). Source is the Shippo **Transaction** ("the purchase of a shipping label"), confirmed against the OpenAPI spec `2018-02-08` (`Transaction` schema; `CoreRate`; `TransactionStatusEnum`).

### 4.1 Field mapping

| `NormalizedShipmentCost` | Shippo Transaction source | Notes |
|---|---|---|
| `externalId` | `object_id` | Stable unique id (spec: "Unique identifier of the given Transaction object"). Idempotency key. |
| `orderRef` | `metadata` | The **only** order match‑back hook. `type: string`, "up to 100 characters." No dedicated structured order/reference field exists (contrast EasyPost's `reference`). May be empty/arbitrary if we did not set it (§4.3, C5 caveat). |
| `trackingNo` | `tracking_number` | Present only for trackable, successfully‑processed labels. Primary match key when `metadata` is absent (C5). |
| `costCents` | `rate.amount` → parse to integer cents | `CoreRate.amount` is `type: string`, e.g. `"5.52"` → `552`. **Parse carefully** (§4.4, §10). |
| `currency` | `rate.currency` | e.g. `"USD"`. (`amount_local`/`currency_local` exist for converted display — ignore for cost; use `amount`/`currency`.) |
| `shippedAt` | `object_created` | `format: date-time`. (No "shipped" timestamp on the Transaction; creation = label purchase time, the honest stand‑in.) |
| `carrier` | `rate.provider` | Carrier name lives on `CoreRate.provider` (e.g. `"USPS"`); there is **no** carrier field directly on Transaction. Null if rate not expanded (§4.4). |

### 4.2 Status filter

Only landed **purchased** labels are costs. Filter to `TransactionStatusEnum.SUCCESS`. The enum values are exactly `WAITING`, `QUEUED`, `SUCCESS`, `ERROR` (spec) — drop everything but `SUCCESS`. **Field/param name asymmetry to know:** the response field is `status`; the **list query filter param is `object_status`** (spec `GET /transactions` query param `object_status: TransactionStatusEnum`). So: request `?object_status=SUCCESS`, then defensively re‑check `txn.status === "SUCCESS"` on each row.

### 4.3 Match‑back caveat (per C5, quantified for Shippo)

Shippo carries **no structured order field** — `metadata` (≤100 chars) is the entire hook. Two cases:
- **We control label creation** (future/where applicable): set `metadata` to the Shopify **order name** (e.g. `#1001`) at purchase → `orderRef` match via `normOrder` (C5) works directly. ≤100 chars is ample for an order name.
- **We do NOT control label creation** (the common Phase‑2 reality — we read a merchant's existing Shippo history): `metadata` is whatever the merchant set (often blank or unrelated). Matching then **leans entirely on `tracking_number`** lining up with `fulfillment_fact.tracking_no` (C5 tracking fallback). Expected match rate ≈ the merchant's tracking coverage; quantify in the live spike. This is acceptable — tracking is the contract's designated primary key when `orderRef` is absent.

No change to `match.ts` (C5): we only populate `ParsedInvoiceRow { orderRef: metadata, trackingNo: tracking_number, costCents }`.

### 4.4 String→cents and the `rate` `oneOf` nuance (load‑bearing)

- **Amounts are JSON strings.** `CoreRate.amount` is `type: string` (`"5.52"`). Convert decimal string → integer cents **without float math** (parse to a fixed 2‑decimal representation, then to int) to avoid `5.52 → 551.9999…` drift. Reject/surface a row whose amount fails to parse (rule 12) rather than landing `NaN`.
- **`rate` may be a bare id string, not the nested object.** Spec: `Transaction.rate` is `oneOf { CoreRate | string }`. On **list** responses the rate frequently comes back as the **rate‑id string**, in which case `rate.amount`/`rate.currency`/`rate.provider` are **not inline**. The mapper MUST detect this:
  - if `rate` is an object → read `amount`/`currency`/`provider` directly;
  - if `rate` is a string id → the list row lacks the cost inline. Options, in preference order: (a) request the list in a shape that expands the rate if Shippo supports it for that endpoint; else (b) fall back to `GET /transactions/{object_id}` (spec retrieve endpoint) per row to obtain the nested `CoreRate`. Pick the approach in the live spike; do **not** assume the nested object is always present.
- A Transaction with neither an inline nor fetchable cost is **surfaced as unmappable** (rule 12), never landed with cost `0`.

---

## 5. Connect flow — Shippo OAuth (the new bits)

Shippo uses a standard OAuth 2.0 authorization‑code flow (co‑branded; merchant owns the Shippo account + billing). It slots into the **existing** OAuth ladder — mirror `auth.quickbooks.$.tsx` and the QuickBooks `startOAuth` branch. **What's new in Phase 2 is only the Shippo provider wiring; the nonce/state/credential‑storage machinery is reused.**

### 5.1 `startOAuth` — add a `shippo` branch
In `calderyn.server.ts` `startOAuth` (the QuickBooks branch at `app/lib/calderyn.server.ts:1050-1066` is the template):
- guard `SHIPPO_CLIENT_ID`/`SHIPPO_CLIENT_SECRET`/`SHOPIFY_APP_URL` (throw `SHIPPO_NOT_CONFIGURED` like `QUICKBOOKS_NOT_CONFIGURED` at `:1054`);
- `redirectUri = ${appUrl}/auth/shippo`;
- single‑use nonce: `state = await createOAuthState(supabase, shopId, { host, shop })` (`:1065`, identical pattern);
- build the authorize URL → **`https://goshippo.com/oauth/authorize`** with `response_type=code`, `client_id=<SHIPPO_CLIENT_ID>`, `scope=*`, `state=<nonce>`, `redirect_uri=<redirectUri>` (a new `buildShippoAuthUrl` helper alongside `buildQuickbooksAuthUrl`).

Add `"shippo"` to `IntegrationProvider` (`calderyn.server.ts:65`) and to `OAUTH_PROVIDERS` (`app/lib/integrations.ts:13`) so `connect_integration` accepts it (`app/routes/app.settings.tsx:318` validates against `OAUTH_PROVIDERS`).

### 5.2 New route `app/routes/auth.shippo.$.tsx` (mirror `auth.quickbooks.$.tsx`)
Same skeleton as the QuickBooks callback (no `authenticate.admin` — Shippo's domain has no embedded session; the single‑use nonce is the authenticator, per `auth.quickbooks.$.tsx:20-22`):
1. read `code`, `state`, `error` from the query;
2. recover embedded ctx: `parseOAuthState(state)` (`auth.quickbooks.$.tsx:37`);
3. on `error` → `redirect(embeddedReturnUrl("/app/settings", { shippo: "error", reason }, returnCtx))`;
4. `shopId = await consumeOAuthState(sb, state)`; invalid → 400 (`:49-50`);
5. **token exchange — `POST https://goshippo.com/oauth/access_token`** with body params `grant_type=authorization_code`, `code`, `client_id=SHIPPO_CLIENT_ID`, `client_secret=SHIPPO_CLIENT_SECRET` (Shippo also expects the approved `redirect_uri`). Response JSON: `access_token` (format `"oauth.<token>"`), `token_type: "bearer"`, `scope: "*"`. **The token never expires and there is no refresh token** (Shippo: "remains valid forever").
6. **store the credential** (mirror `:71-82`): upsert `integration_credentials` on `(shop_id, kind)` with `kind='shippo_ship'`, `access_token_encrypted: encrypt(access_token)` (`app/lib/crypto.server.ts:12`), `token_expires_at: null` (never expires), `external_account_id`: the Shippo account/owner id if returned else null, `updated_at: now`. **Use `integration_credentials.access_token_encrypted`, NOT the legacy `shop_integrations.access_token_enc` bytea** (C7).
7. **flip status** (mirror `:84-98`): upsert `shop_integrations` `kind='shippo_ship'`, `sync_status='ready'`, `sync_error: null` (clear stale failures), `connected_at: now`, `updated_at: now`.
8. `redirect(embeddedReturnUrl(await postOAuthPath(sb, shopId), { shippo: "connected" }, returnCtx))` (`:101`).

> **Status note (C2 trap):** the callback writes `sync_status='ready'` exactly like QuickBooks/Meta. Phase‑1's `shipAdaptersForShops` (C2) already selects freshly‑connected shops at the status the connect flow leaves them in (`'ready'` included) — **no Phase‑2 change**; just confirm `'ready'` is in that connectable set when wiring the registry entry.

### 5.3 `connect()` inside `ShippoAdapter`
`connect(shopId)` (C1): read `integration_credentials` for `(shop_id, kind='shippo_ship')`, `decrypt(access_token_encrypted)`; if absent → return `null` (cron marks "skipped", C3). Else return a `ShipSource` whose `fetchCharges` calls Shippo with header **`Authorization: Bearer oauth.<token>`** (the stored token value already begins with `oauth.`; Shippo explicitly notes the `ShippoToken` scheme will **not** work for OAuth tokens) and `Shippo-API-Version: 2018-02-08`.

---

## 6. Fetch & land

**Fetch (new, inside `fetchCharges`):**
- `GET https://api.goshippo.com/transactions/?object_status=SUCCESS` with `Authorization: Bearer oauth.<token>`.
- **Pagination:** `?page=<n>` + `?results=100` (**cap 100** — spec `maximum: 100`; ignore the prose doc's 200, see Contract concern #2). Walk the envelope: response has `results[]` plus `next`/`previous` URLs; follow `next` until null. (Spec note: there is **no `count` field**, so loop on `next` rather than a total.)
- `since` (the trailing re‑pull window from C3): the spec documents `object_created_gt/gte/lt/lte` date filters on **Shipments**, and does not document them on Transactions. **Do not assume a server‑side date filter on `/transactions`.** Implement `since` as a **client‑side cutoff**: page newest‑first and stop once `object_created < since`. (Confirm in the spike whether `/transactions` honors `object_created_gt`; if it does, prefer it.) The re‑pull window (e.g. 14–30 days) is the same one C3 passes.
- Map each SUCCESS row → `NormalizedShipmentCost` (§4), resolving the `rate` `oneOf` (§4.4).

**Land (REUSED — contract C4, no new code):** the returned `NormalizedShipmentCost[]` flows into the **existing** `land.server.ts`: synthetic period ensured for `(shop, carrier='shippo', source='connector')` (C4.1, race‑safe partial unique index from Phase 1); match via **existing** `matchInvoiceLines` (C5); pre‑aggregate matched charges per `matched_order_id` (C4.3); idempotent delete‑by‑keyset + insert under the synthetic `period_id` (C4.4); recompute synthetic `total_cents` (C4.5); unmatched rows land visible (C4.6); then `runShipCostResolution` (C3). **Phase 2 writes none of this** — it only supplies the adapter the framework calls.

---

## 7. Schema deltas

| Δ | Migration | Notes |
|---|---|---|
| `integration_kind += 'shippo_ship'` | `ALTER TYPE public.integration_kind ADD VALUE IF NOT EXISTS 'shippo_ship';` in its **own** migration step | Same pattern as `20260606120000_tiktok_platform.sql:7`. A freshly‑added enum value cannot be used in the same transaction — keep this migration type‑only; reference the kind only in later code (contract C7, §4). |

**No `shipping_invoice_line` / `shipping_cost_period` table change** (D1 — synthetic period absorbs Shippo with no schema change). **No CHECK alter** (`'connector'` added to `shipping_cost_period.source` in Phase 1). **No resolver/fence change** (C6 done in Phase 1; the fence already excludes `source='connector'`, which covers Shippo's synthetic period automatically).

### Display constants (code, not SQL — both surfaces)
- `app/lib/calderyn.server.ts` defaults map (`:960-966`) add `shippo_ship: { name: "Shippo", status: "disconnected", detail: "Not connected", logoCls: "logo-shippo" }`.
- `INTEGRATION_DISPLAY_NAME` (`calderyn.server.ts:231-237`) add `shippo_ship: "Shippo"`.
- `INTEGRATION_LOGO_CLS` (`calderyn.server.ts:223-229`) add `shippo_ship: "logo-shippo"`.
- `INTEGRATION_ORDER` (`app/lib/dashboard/client.ts:331-337`) add `"shippo_ship"`.
- `app/lib/integrations.ts`: add `shippo: "shippo_ship"` to `PROVIDER_TO_KIND` (`:41-45`), `shippo_ship: "shippo"` to `KIND_TO_PROVIDER` (`:94-98`), and `shippo: "Shippo"` to `PROVIDER_DISPLAY` (`:63-68`) so the post‑OAuth `?shippo=connected` notice renders (`connectionNotice`, `:75-92`).

---

## 8. Files to add / change

**Framework files REUSED UNCHANGED** (Phase 1; listed so it's explicit they are *not* touched): `app/lib/ship-cost/adapters/adapter.ts` (C1), `…/registry.server.ts` (C2 — only the array literal gains an entry, below), `app/routes/cron.ingest-ship-costs.tsx` (C3), `app/lib/ship-cost/adapters/land.server.ts` (C4), `app/lib/ship-cost/match.ts` (C5), `app/lib/ship-cost/runner.server.ts` + `resolve.ts` (C6 / resolver).

**Add:**
- `app/lib/ship-cost/adapters/shippo.server.ts` — `ShippoAdapter` (`provider:"shippo"`, `integrationKind:"shippo_ship"`, `connect()` + `ShipSource.fetchCharges()`), Transaction→`NormalizedShipmentCost` mapper, string→cents helper, `rate` `oneOf` resolver.
- `app/routes/auth.shippo.$.tsx` — OAuth callback (§5.2).
- `supabase/migrations/<ts>_shippo_ship_kind.sql` — enum value (§7).
- *(if a `buildShippoAuthUrl` lives with the other auth‑url builders)* the Shippo authorize‑URL helper next to `buildQuickbooksAuthUrl`.

**Change (small, surgical):**
- `app/lib/ship-cost/adapters/registry.server.ts` — `SHIP_ADAPTERS = [easyPostAdapter, shippoAdapter]`; `ShipProvider += "shippo"`, `ShipIntegrationKind += "shippo_ship"` in `adapter.ts` union types (C1 — these unions are *designed* to grow per provider).
- `app/lib/calderyn.server.ts` — `startOAuth` `shippo` branch (§5.1); `IntegrationProvider` (`:65`); display defaults + `INTEGRATION_DISPLAY_NAME`/`INTEGRATION_LOGO_CLS` (§7).
- `app/lib/integrations.ts` — `OAUTH_PROVIDERS` + the three maps (§7).
- `app/lib/dashboard/client.ts` — `INTEGRATION_ORDER` (§7).
- `.env.example` — `SHIPPO_CLIENT_ID`, `SHIPPO_CLIENT_SECRET`.

> `app.settings.tsx` and `Settings.tsx` need **no edits** — both card lists are kind‑agnostic (embedded: `app.settings.tsx` maps the integrations record; dashboard: `Settings.tsx:387` maps `integrations`); the new kind appears automatically once it's in the integrations record + display constants (C7).

---

## 9. Implementation plan

1. **Start the Shippo partner application** (§3.2) — long lead time; unblocks everything. In parallel, code against the spec.
2. **Migration:** add `'shippo_ship'` to `integration_kind` (own step), apply, verify.
3. **Types + registry:** extend `ShipProvider`/`ShipIntegrationKind` unions; add `shippoAdapter` placeholder to `SHIP_ADAPTERS`.
4. **`ShippoAdapter`:** `connect()` (read+decrypt credential → `ShipSource` or `null`); `fetchCharges()` (paginated `GET /transactions/?object_status=SUCCESS&results=100`, `rate` `oneOf` resolution, string→cents, `since` client‑side cutoff); the mapper.
5. **OAuth wiring:** `startOAuth` `shippo` branch + `buildShippoAuthUrl`; `auth.shippo.$.tsx` callback; `OAUTH_PROVIDERS`/`IntegrationProvider`/the maps.
6. **Display constants** both surfaces (§7).
7. **Tests** (§10) before merge.
8. **Live spike** (once partner‑approved): confirm `rate` shape on list responses (object vs id), whether `/transactions` honors `object_created_gt`, and the real `metadata`/`tracking_number` match rate on a seeded account. Record findings; adjust §4.4/§6 if the spike contradicts.

---

## 10. Tests

Behavior‑checking (rule 9), not framework re‑tests (the framework is Phase‑1‑tested):

1. **Mapping — full Transaction → `NormalizedShipmentCost`:** a SUCCESS Transaction with nested `CoreRate` maps every field per §4.1 (`object_id`→`externalId`, `metadata`→`orderRef`, `tracking_number`→`trackingNo`, `rate.provider`→`carrier`, `object_created`→`shippedAt`).
2. **String‑amount → cents:** `"5.52"→552`, `"10.00"→1000`, `"0.5"→50`, `"123.45"→12345`; a non‑numeric/blank amount is **surfaced as unmappable**, never `NaN`/`0` (rule 12). Assert no float drift on a value like `"19.99"`.
3. **`rate` `oneOf` handling:** when `rate` is a **bare id string**, the mapper does not read `undefined.amount` — it takes the fetch‑detail (or expand) path; when `rate` is an object, it reads inline. A row with neither resolvable → unmappable (not cost `0`).
4. **Status filter:** rows with `status` `WAITING`/`QUEUED`/`ERROR` are excluded even if the API returned them; only `SUCCESS` lands. Verify the request sends `object_status=SUCCESS`.
5. **OAuth callback (`auth.shippo.$.tsx`):** given a valid `code` + `state`, exchanges at `POST /oauth/access_token` (mocked), stores `encrypt(access_token)` in `integration_credentials(kind='shippo_ship')` with `token_expires_at=null`, and upserts `shop_integrations` to `sync_status='ready'`, `sync_error=null`. An `error` query param redirects to `/app/settings?shippo=error&reason=…` with no credential written. Invalid/expired `state` → 400.
6. **Metadata match‑back:** `metadata="#1001"` matches `order_fact.order_number` via `normOrder` (C5); blank `metadata` falls back to `tracking_number`↔`fulfillment_fact.tracking_no`; neither → lands with `matched_order_id=NULL` and increments the unmatched count (C4.6, rule 12).
7. **Pagination cap:** `fetchCharges` requests `results=100` (never 200) and follows `next` until null (no reliance on a `count` field).

---

## 11. Risks

1. **Partner‑program gate (lead‑time / availability).** OAuth credentials require Shippo sales approval and a pre‑approved `redirect_uri`; not self‑serve. Blocks end‑to‑end testing until granted. **Mitigation:** apply first (§3.2); develop against mocks; gate merge of the live cron path on approval, or ship the adapter behind a config flag until credentials land. *(API‑key fallback like EasyPost is **not** the chosen Phase‑2 path per C8 — do not silently substitute it; if approval stalls, escalate as a product decision, don't divert.)*
2. **`metadata`‑only match‑back (≤100 chars, unstructured).** When we don't control label creation, match rate = tracking‑number coverage (§4.3, contract risk #2). Quantify in the spike; tracking is the primary key.
3. **`rate` returned as id string on list responses** (§4.4) — if unhandled, costs come back null. Spike confirms; mapper handles both shapes; a per‑row detail fetch is the fallback (watch rate limits / N+1 on large histories).
4. **Pagination doc conflict** (Contract concern #2) — mitigated by hard‑capping `results=100` per spec.
5. **Post‑purchase carrier adjustments unconfirmed** (contract §5 risk #1). Shippo adjustments live in the **Invoices API (beta)**; whether an invoice item links back to the originating Transaction `object_id` is **unconfirmed from docs**. **Deferred to Phase 3** (live spike before building reconciliation). Phase‑2 `actual_invoice` = label cost at purchase; later adjustments are a known follow‑up, surfaced not buried.
6. **Token is non‑expiring** — convenient (no refresh), but a leaked/compromised token is valid forever until the merchant revokes. Stored encrypted (AES‑256‑GCM); disconnect must delete the credential row (the existing `disconnect` deletes `shop_integrations`; ensure the Shippo disconnect also clears `integration_credentials` if Phase‑1 didn't already — confirm against the Phase‑1 disconnect path).

---

## 12. Dashboard parity checklist

Per contract §7 / C7: connect/disconnect is **embedded‑app‑only**; the dashboard shows **read‑only status** and auto‑renders the new kind once it's in `integrations.list` + display constants. **No dashboard JSX/redesign** — match the data contract, not the code.

- [x] `shippo_ship` in the `integrations.list` defaults map (`calderyn.server.ts:960-966`) → dashboard `integrations.list` → `adaptIntegrations` (`client.ts:339-357`) renders it.
- [x] `shippo_ship` in `INTEGRATION_DISPLAY_NAME` / `INTEGRATION_LOGO_CLS` (`calderyn.server.ts`) and `INTEGRATION_ORDER` (`client.ts:331-337`).
- [x] Dashboard `Settings.tsx` (`:380-401`) needs **no edit** — its `integrations.map` (`:387`) is kind‑agnostic; the read‑only status pill (`CONNECTION_TONE`/`CONNECTION_LABEL`/`CONNECTION_ICON`) covers `connected`/`pending`/`disconnected`, which is all `shippo_ship` produces.
- [x] Status vocabulary: the callback writes `sync_status='ready'`, which `integrations.list` (`calderyn.server.ts:974-979`) maps to `"connected"` — already handled, no dashboard change.
- [x] Single change, both surfaces — not a follow‑up (repo CLAUDE.md). The dashboard side here is pure display‑constant config (no `withShopContext`/raw‑postgres re‑implementation needed, because integration status is served through the shared `integrations.list`).

---

## 13. Out of scope

- **Carrier post‑purchase adjustments / Invoices API (beta)** → Phase 3 (contract §5 risk #1; live spike first).
- **Any framework change** — `ShipCostAdapter`, registry mechanism, cron, `land.server.ts`, `match.ts`, the allocation fence, `runShipCostResolution` are Phase‑1 and reused **unchanged** (only the registry array, the C1 union types, and display constants grow).
- **`shipping_invoice_line` / `shipping_cost_period` schema** — no change (D1).
- **EasyPost** (Phase 1) and **3PL houses** (Phase 3).
- **Shippo label *creation*** — we only **read** existing Transactions for cost. (Setting `metadata` at creation time, §4.3, applies only where label creation is already under our control; building a label‑purchase flow is not in scope.)
- **Platform Accounts / `SHIPPO-ACCOUNT-ID` header** billing model — Phase 2 connect is per‑merchant OAuth (C8); platform‑billed accounts are a different product decision, not this connector.
- **Webhooks.** `transaction_created` (full Transaction payload incl. nested `rate`) is a known future optimization for near‑real‑time landing, but Phase 2 lands via the **poll cron** (C3). There is **no dedicated cost‑settlement / carrier‑adjustment webhook event** (only `transaction_created`/`transaction_updated`/`track_updated`/`batch_created`/`batch_purchased`/`all`), so webhooks add latency improvement, not new cost data — deferred.

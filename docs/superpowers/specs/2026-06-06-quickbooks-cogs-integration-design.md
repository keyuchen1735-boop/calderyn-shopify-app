# Design: QuickBooks → COGS Integration (data pipeline "Slice 4")

**Date:** 2026-06-06
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY` (`ajgrmnvzxfxxlwrxcgnu`)

---

## 1. Context

QuickBooks is already stubbed throughout the app — `IntegrationProvider` type,
the Settings integration card, the onboarding step, `INTEGRATION_DISPLAY_NAME` /
`INTEGRATION_LOGO_CLS`, and the `integration_kind` Postgres enum all include
`quickbooks` — but **no implementation exists**: there is no `app/lib/quickbooks/`,
no `/auth/quickbooks` callback, and `client.integrations.startOAuth` has no
`quickbooks` branch.

The earlier ingestion design (`2026-05-31-shopify-ingestion-design.md`) named
this work explicitly: **"Slice 4: QuickBooks (COGS / margin)."** The architecture
was built expecting QuickBooks to be a **read-only source of product cost**:

- `cogs_fact.source` already enumerates `'quickbooks' | 'csv_import' | 'shopify_cost'`.
- `raw_quickbooks_poll` landing table already exists (0 rows).
- `derive_margin` already consumes COGS: a merchant override wins; else if COGS
  coverage ≥ 70% and revenue > 0 it uses the computed contribution margin (`ok`);
  else it falls back to a 40% default (`default`). The grade carries this
  confidence label.
- `break_even_roas = 1 / contribution_margin` (per-campaign grading in `grade.py`)
  and the `cogs_drift` detector both depend on real COGS.

**Verified against live prod Supabase (2026-06-06):** `cogs_fact`,
`raw_quickbooks_poll`, `integration_credentials`, `shop_integrations`, `sku_dim`,
`sku_pnl`, and `ingestion_dlq` all exist.

### Decision: scope (confirmed with stakeholder)

- **Direction:** pull only — QuickBooks → Calderyn. We read product costs in. We
  do **not** push sales/spend into QuickBooks (no prior design, no schema, no
  consumer; out of scope — see §9).
- **Cost source:** per-item purchase cost matched by SKU (option A below), not
  purchase/bill history (option B) or P&L account totals (option C).

### Approaches considered

| | How | Verdict |
|---|---|---|
| **A. Item purchase cost by SKU** | Read QBO Inventory `Item.PurchaseCost`, match `Item.Sku` → `sku_dim.sku` | **Chosen.** Per-SKU, matches `cogs_fact` grain exactly; simplest. |
| B. Purchase/bill history | Aggregate supplier bills into landed cost over time | Rejected v1: must attribute purchases to SKUs, average, handle returns. Overkill. |
| C. P&L COGS account total | Read one COGS total from the P&L report | Rejected: a single lump, not per-SKU — cannot drive per-campaign break-even. |

## 2. Goal & success criteria

After a merchant connects QuickBooks and one daily sync cycle runs:

1. For each QBO Inventory item that has a non-empty `Sku` matching a
   `sku_dim.sku` row for the shop **and** a positive `PurchaseCost`, a
   `cogs_fact` row exists with `source = 'quickbooks'`, `unit_cost_cents =
   round(PurchaseCost * 100)`, `source_ref = <QBO item Id>`, and `effective_to
   IS NULL` (the current open cost).
2. Re-running the sync with unchanged costs produces **no new rows** (idempotent).
3. When a cost changes in QuickBooks, the previous open row is closed
   (`effective_to = now`) and a new open row inserted — preserving history for
   `cogs_drift`.
4. The Settings → Integrations card shows QuickBooks as **Connected** after
   OAuth, and as **error / "Reconnect"** if the refresh token has expired.
5. Every hard failure (auth expired, permanent API error) lands in
   `ingestion_dlq` and is surfaced in the cron response — never silently dropped.
6. Items with no SKU match or no cost are **counted and skipped**, not treated as
   errors (gaps are handled downstream by `derive_margin`).

## 3. Non-goals

- Pushing any data **into** QuickBooks (sales, ad spend, invoices).
- Purchase/bill-based costing (option B) or P&L account totals (option C).
- Multi-currency conversion. v1 assumes QuickBooks company currency = shop
  currency; if they differ, flag it (see §7) rather than silently converting.
- Backfilling cost history from QuickBooks (we record changes from first sync
  forward).
- Any change to `derive_margin`, `grade.py`, or the `cogs_drift` detector — they
  already consume `cogs_fact` and need no edits.

## 4. Components

New code follows the existing per-provider layout (`app/lib/<provider>/`,
`auth.<provider>.$.tsx`), cloning the Meta integration shape so it is predictable.

| File | Responsibility |
|---|---|
| `app/lib/quickbooks/oauth.server.ts` | `buildAuthUrl`, `exchangeCodeForToken`, `refreshAccessToken`. Pure, fetcher-injected (testable like `meta/oauth.server.ts`). |
| `app/lib/quickbooks/client.server.ts` | Authenticated QBO client (clone of `google/client.server.ts`). Loads the stored refresh token, exchanges it for a short-lived access token each run, **persists the rotated refresh token back**, then runs the items query against the company endpoint. |
| `app/lib/quickbooks/ingest.server.ts` | Fetch Inventory items (paginated), write raw payload to `raw_quickbooks_poll`, transform → upsert `cogs_fact`, route failures to `ingestion_dlq`. Exposes a pure `transformItemsToCogs(...)` for unit testing. |
| `app/lib/quickbooks/types.ts` | QBO Item / token response types. |
| `app/routes/auth.quickbooks.$.tsx` | OAuth callback. Clone of `auth.meta.$.tsx`: consume single-use state nonce → resolve `shopId` → exchange code → persist creds → upsert `shop_integrations` → `redirect("/app/settings?quickbooks=connected")`. |
| `app/routes/cron.ingest-quickbooks.tsx` | Daily cron. `cron-auth.server.ts` guard → for each shop with a live `quickbooks` integration, run ingest; aggregate counts + DLQ in the JSON response (mirrors `cron.ingest-ads.tsx`). |

Edit (not new):

- `app/lib/calderyn.server.ts` → add a `quickbooks` branch to
  `integrations.startOAuth` (mirrors meta/google/tiktok): read
  `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `SHOPIFY_APP_URL`, redirect URI
  `${appUrl}/auth/quickbooks`, mint a state nonce via `createOAuthState`, build
  the Intuit authorize URL. `integrations.disconnect` is already generic.

### OAuth specifics (Intuit)

- **Authorize:** `https://appcenter.intuit.com/connect/oauth2` with
  `client_id`, `redirect_uri`, `response_type=code`, `state`,
  `scope=com.intuit.quickbooks.accounting`.
- **Token exchange / refresh:** `POST
  https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, HTTP Basic auth
  (`client_id:client_secret`), `grant_type=authorization_code` (then
  `refresh_token`). Response: `access_token` (~1h), `refresh_token` (~100d,
  **rotates** — always persist the value returned), `expires_in`,
  `x_refresh_token_expires_in`.
- **Realm:** the callback receives a `realmId` query param (the QuickBooks
  company id). Store it in `integration_credentials.external_account_id`.
- **Token storage (no new column — Google precedent):** store the rotating
  **refresh token** (encrypted) in the existing `access_token_encrypted` column,
  exactly as `auth.google.$.tsx` does for its long-lived refresh token. The
  short-lived access token is never persisted — it is re-derived on every run.
  Because QBO rotates the refresh token on each exchange, the client writes the
  returned refresh token back to `access_token_encrypted` after every refresh.
  `token_expires_at` holds the refresh token's ~100-day expiry so an idle
  death can be detected and surfaced as "Reconnect".
- **API base:** production `https://quickbooks.api.intuit.com`, sandbox
  `https://sandbox-quickbooks.api.intuit.com`; chosen by `QBO_ENV`
  (`sandbox` | `production`). Items query:
  `GET /v3/company/{realmId}/query?query=SELECT * FROM Item WHERE Type = 'Inventory' STARTPOSITION n MAXRESULTS 100`.

## 5. Data flow

```
Merchant: Settings/Onboarding "Connect QuickBooks"
  → client.integrations.startOAuth('quickbooks')  → Intuit consent screen
  → GET /auth/quickbooks?code&state&realmId
       consumeOAuthState(state) → shopId   (reject if invalid/expired/reused)
       exchangeCodeForToken(code)
       upsert integration_credentials {shop_id, kind:'quickbooks',
            access_token_encrypted := encrypt(refresh_token),   -- Google precedent
            token_expires_at := now + x_refresh_token_expires_in,
            external_account_id := realmId}
       upsert shop_integrations {kind:'quickbooks', sync_status:'ready', connected_at}
  → redirect /app/settings?quickbooks=connected

Daily cron: GET /cron.ingest-quickbooks  (cron-auth guarded)
  for each shop_integrations where kind='quickbooks' and sync_status in ('ready','live'):
     exchange stored refresh_token → access_token; persist rotated refresh_token
     QBO query Inventory items (paginated) → [{ id, sku, purchaseCost }]
     insert raw_quickbooks_poll { shop_id, poll_kind:'items', payload }
     transformItemsToCogs():
        match sku → sku_dim (per shop); skip+count if no match or no cost
        compare to current open cogs_fact(source='quickbooks') for that sku:
           unchanged → no-op
           changed   → set effective_to=now on old; insert new open row
           new       → insert open row
     hard failures → ingestion_dlq { connector:'quickbooks', job_kind, error_kind }
     update shop_integrations.last_sync_at, sync_status='live'
        ↓ (already implemented, unchanged)
  engine → sku_pnl / contribution margin / break-even grade / cogs_drift detector
```

## 6. Schema change: NONE

**No migration is required.** The Google Ads integration already stores a
rotating long-lived secret without a dedicated column: `auth.google.$.tsx` puts
the encrypted **refresh token** in `integration_credentials.access_token_encrypted`
and `google/client.server.ts` exchanges it for a short-lived access token on each
run. QuickBooks follows the same precedent:

- `access_token_encrypted` ← encrypted QBO **refresh token** (rewritten after each
  rotation, since QBO rotates it on every exchange).
- `external_account_id` ← QBO `realmId`.
- `token_expires_at` ← refresh token's ~100-day expiry (for "Reconnect" detection).
- Encryption via the existing `encrypt()` / `decrypt()` in
  `app/lib/crypto.server.ts` (same path Meta and Google use).

`raw_quickbooks_poll`, `cogs_fact`, `sku_dim`, and `ingestion_dlq` already exist
live (verified 2026-06-06) and are unchanged. **Nothing is written to prod's
schema for this feature.**

## 7. Error handling

| Case | Behavior |
|---|---|
| Refresh token expired (~100d idle) or revoked | `shop_integrations.sync_status='error'`, `sync_error='auth_expired'`; Settings shows "Reconnect QuickBooks"; DLQ `error_kind='auth_expired'`. |
| QBO 429 / 5xx / transient | Exponential backoff (reuse `app/lib/ads/backoff.ts`), bounded retries; if still failing, DLQ `error_kind='unknown'`. |
| QBO 401 mid-sync (token races) | One forced refresh + retry; if still 401 → treat as `auth_expired`. |
| Item has no `Sku` match or `PurchaseCost ≤ 0` | Counted as `skipped` (with a per-reason breakdown), **not** an error. Downstream `derive_margin` covers coverage gaps. |
| Permanent/unknown failure | `ingestion_dlq` row; surfaced in cron JSON. Never silently dropped. |

Currency: v1 assumes the QuickBooks company's home currency equals the shop
currency (`sku_dim.currency`) and writes `unit_cost_cents` as-is. This is a
documented assumption (§3), **not** enforced in v1 — multi-currency conversion is
a separate effort.

## 8. Testing

Per-module `__tests__` directories, matching repo convention (fetcher/Supabase
fakes, no network):

- `oauth.server.test.ts` — `buildAuthUrl` query shape; `exchangeCodeForToken`
  parses access/refresh/expiry; `refreshAccessToken` returns and **persists the
  rotated refresh token**; error responses throw.
- `ingest.test.ts` — `transformItemsToCogs`: cents conversion
  (`round(cost*100)`), SKU match against `sku_dim`, unmatched skip-and-count,
  zero/absent cost skip, **unchanged → no-op**, **changed → close old + insert
  new**, currency mismatch skip, DLQ on hard error.
- `cron.ingest-quickbooks.test.ts` — auth guard rejects unauthorized; iterates
  only `quickbooks` live shops; aggregates counts + DLQ (mirrors
  `cron.ingest-ads.test.ts`).
- Optional: callback route test mirroring `__tests__/campaigns-action.test.ts`.

## 9. Future (explicitly out of scope here)

Pushing sales / ad spend **into** QuickBooks (bookkeeping automation) would be a
separate spec: it needs net-new schema, writes into the merchant's real ledger
(higher risk), and does not feed the ad-profit grading that is Calderyn's core.
Not built now.

## 10. Config / secrets

New env vars, read server-side only; stored in `.env.local`, documented in
`.env.example` (per CLAUDE.md secret-storage rules):

- `QBO_CLIENT_ID`
- `QBO_CLIENT_SECRET`
- `QBO_ENV` = `sandbox` | `production`

`SHOPIFY_APP_URL` (existing) supplies the OAuth redirect host
(`${SHOPIFY_APP_URL}/auth/quickbooks`).

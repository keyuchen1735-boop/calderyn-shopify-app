# Nightly maintenance — cross-night memory (LEARNINGS.md)

Long-lived brain for the unattended nightly run. Records false positives (do NOT
re-flag), recurring bug patterns, fixes that worked, and gate/CI gotchas.

## 2026-07-02

### Triage result — LANDED code clean, zero fixes needed
24h window `0c4ba8b` back through the day's merges (PRs #241, #245–#250, #252–#255).
Read every substantive diff. **No high-confidence correctness bug found; no fix
branch/PR opened.** All of tonight's landed work is fresh but visibly
adversarially-reviewed (explicit edge-case handling, fail-closed logic,
idempotency). Reviewed and cleared:
- **`storefront/money.ts` + `meta.ts`** (faeaa8e, PR #253): locale pinned to en-US
  via cached `Intl.NumberFormat` to kill SSR/hydration mismatch #425; per-currency
  cache. Correct.
- **`storefront/settings.server.ts`** (80f7ebc, PR #255): settings-less shop falls
  back to `shops.display_name` then "Your store" instead of the demo label. Correct.
- **`order/cart.server.ts`** (faeaa8e): `assertPersistableShop` blocks the
  `DEMO_SHOP_ID` sentinel from the uuid cart tables on build/add/price. Correct;
  route-level demo guards mirror it (cart/checkout/PDP loaders+actions).
- **`storefront/shop.server.ts`** (b7bd823, PR #248): real tenant resolution,
  `SLUG_RE`-validated `or()` (no PostgREST filter injection), 60s TTL hit+miss cache
  w/ FIFO eviction, uninstalled shops excluded. Correct.
- **`storefront/catalog.owned.server.ts`** (6b213f2, PR #252): availability now sums
  the ledger `available` column (matches `inventory_reserve()`), chunked+paged past
  the 1000-row cap, ledger-less variants keep the editor `inventory_on_hand`
  fallback (`ledgerSellable ?? …`). Correct — a variant with ledger rows summing to 0
  correctly reads sold-out; only *no* rows → fallback.
- **`ship-cost/runner.server.ts`** (6acfe8f, PR #246): fixes /cron/ingest 504 by
  diffing in-memory + set-based RPC batches; `fetchAllRows` now THROWS on page error
  (was silently returning partial); `asError` unwraps PostgREST `[object Object]`;
  sku_pnl now writes a zero over a stale nonzero cost (old `=== 0` skip left stale
  margins). Correct.
- **`cutover/go-live.server.ts`** (30c3d61 + f3cb0c2, PR #247/#249): value-parity
  gate runs the drift sweep only after cheap structural checks pass; Shopify
  unreachable FAILS CLOSED; native shop passes; demo shops exempted via
  `isShowcaseShop` (fails safe toward real shop). Correct.
- **`dashboard.api.agentic._index.tsx`** (e5b928b, PR #250): the loader was rewritten
  to scope the client list to the shop's own non-revoked `mcp_tokens` — this
  **supersedes** last night's `client_name` column fix AND resolves the
  "not shop-scoped" item that 2026-07-01 left as a product/privacy question. Uses
  `client_name` correctly. The global-registry note below is now moot for this route.

### Open-PR review
- **PR #235** (last night's own nightly fixes, still UNMERGED): posted one review
  comment. Found a real **liveness bug in the ACP double-charge fix**:
  `claimAcpSessionForCompletion` flips `open→completing`, then cap/place/charge run
  with **no try/catch and no rollback** — a transient failure wedges the session in
  `completing` forever (retries hit `409 in_progress`; nothing sweeps a stale
  `completing`). Suggested persisting `orderId` after place (before the idempotent
  charge) so retries resume at charge. Also flagged its `edccc80` agentic commit as
  now-redundant vs merged #250. **IMPORTANT: #235's token-reuse + ACP double-charge +
  swallowed-error fixes are STILL LIVE on main (PR never merged)** — worth a nudge to
  merge (minus edccc80). PRs #47 (presentation) and #38 (test-only) are ~1mo stale,
  low-risk → NONE, no comment.

### Gate note
- Ran **no** eval gate this run: zero code changes were made (no landed bug to fix),
  so there was nothing to typecheck/build/test. The prisma-offline install recipe
  below was therefore not exercised tonight — assume still valid.

## 2026-07-01

### Bug fixed tonight
- **`app/routes/dashboard.api.agentic._index.tsx`** selected/read DB column `name`
  from `mcp_oauth_clients`, but the real column is **`client_name`** (see
  `supabase/migrations/20260608120000_mcp_oauth_clients.sql`). Against real
  Postgres/PostgREST, selecting an undefined column → error `42703` → loader
  throws → the whole Agentic Channel dashboard screen **500s on first load**.
  Source: commit `5677bc5` (PR #227, buy-in-chat P4). Fix: read `client_name`;
  DTO output key stays `name`. Shipped in PR #234.
- **Lesson (mock-hides-bug):** the route's unit test used a Supabase mock whose
  `.select()` ignores its args and returns a fixture keyed `name` — so the test
  *passed against the buggy code* and never caught the wrong column. When
  reviewing Supabase/PostgREST queries, **cross-check selected column names
  against the migration DDL, not the test mock.** A green test does not prove the
  column exists.

### Recurring bug pattern — "write-then-blank round-trip drop"
When a feature adds newly-persisted columns, the **LIST/GET loader `.select(...)`
frequently is NOT updated**, so the new fields render blank on reopen and can be
zeroed on the next save/onBlur. Seen repeatedly:
- PR #232 (owned-shipping): `dashboard.api.catalog.locations._index.tsx` list
  loader still selected `id,name,priority,lat,lng` after ship-from address fields
  were added → address blanks on reopen. Also a **snake_case↔camelCase** gap
  (`postal_code` DB vs `postalCode` VM). Commented on #232.
- Previously fixed on the product loader in `558c869` (8 shipping fields).
**Review action:** whenever a PR adds persisted columns, grep every loader that
reads that table and confirm the new columns are in the `select` AND mapped to
the VM's camelCase shape.

### False positives — do NOT re-flag
- `dashboard.api.agentic._index` lists `mcp_oauth_clients` filtered only by
  `commerce_scope=true` with **no shop scoping**. This is NOT a cross-tenant leak:
  `mcp_oauth_clients` is a **global registry** (no `shop_id`; `commerce_scope` and
  `spend_cap_cents` are per-*client* global config). Nothing to scope by.
  (Whether every merchant should see the global client list is a product/privacy
  question, not a correctness bug — don't "fix" it by inventing a shop join.)
- **Owned catalog (Slice 1, PR #229/1452045)** and **inventory ledger
  (Slice 2, PR #230/be43b38)** were triaged clean this run — heavily hardened via
  prior adversarial rounds (shop-scoped writes w/ row-count checks, FOR-UPDATE
  atomic stock fns, idempotent commit/release, cross-tenant link intersection).
  Don't re-litigate the same write-safety/shop-scoping angles.
- Commerce/ACP guardrail + signature + charge + env-gate (PR #227/#228) reviewed
  clean: guardrail denies missing/unregistered clientId, allows registered,
  spend_cap 0 = unlimited (intentional); ACP routes 404 when `ACP_ENABLED!=="true"`.

### Gate / environment gotchas (IMPORTANT — saves ~30min next run)
- **`npm ci` fails in this sandbox.** The `@prisma/engines` postinstall downloads
  engine binaries via Node's HTTP client, which **ignores `HTTPS_PROXY`** →
  `ECONNRESET`/"aborted". Registry itself is fine (it's in the proxy noProxy list).
- **Working install recipe:**
  1. `npm ci --ignore-scripts` (populates node_modules, skips the failing prisma
     engine download).
  2. Download engines via **curl** (curl honors the proxy — the prisma CDN
     `binaries.prisma.sh` is proxy-reachable):
     `BASE=https://binaries.prisma.sh/all_commits/<ENGINE_HASH>/debian-openssl-3.0.x`
     `curl -o libquery.gz $BASE/libquery_engine.so.node.gz`
     `curl -o schema.gz  $BASE/schema-engine.gz` ; gunzip both.
     Place in `node_modules/@prisma/engines/` as
     `libquery_engine-debian-openssl-3.0.x.so.node` and
     `schema-engine-debian-openssl-3.0.x` (chmod +x).
  3. Generate offline (env vars REQUIRED — bare `prisma generate`/`npm run setup`
     still hits the network even with engines present):
     `PRISMA_QUERY_ENGINE_LIBRARY=<path> PRISMA_SCHEMA_ENGINE_BINARY=<path> \`
     `PRISMA_CLI_QUERY_ENGINE_TYPE=library npx prisma generate`
     Keep these 3 env vars exported for the whole gate (setup/typecheck/build/test).
  - prisma 6.19.3 → ENGINE_HASH = `c2990dca591cba766e3b7ef5d9e8a84796e47ab7`.
    Target `debian-openssl-3.0.x` (Ubuntu 24.04, openssl 3). Re-derive the hash
    from `@prisma/engines-version/package.json` if the prisma version changes.
- **Never mask exit codes with a pipe.** `npm ci | tail` reports `tail`'s exit
  (0) even when npm failed. Use `cmd >log 2>&1; echo EXIT=$?`.
- **TS baseline noise:** with a broken/incomplete node_modules, `tsc` emits
  `TS2688` (missing `@remix-run/node`/`vite/client` type defs) and a `baseUrl`
  `TS5101` deprecation error. Both vanish once install completes. TS resolves to
  5.9.3 via the lock; tsconfig has no `ignoreDeprecations` and it's fine once deps
  are present. So TS2688/TS5101 at baseline ⇒ suspect node_modules, not code.
- Clean-tree full gate this run: setup 0 · typecheck 0 · lint 0 (13 pre-existing
  warnings, none on touched files) · build 0 (client-bundle verifier: 206 files
  clean) · vitest 478 files / 3295 passed / 11 skipped / 0 failed.

### CI gotcha (do NOT chase on nightly PRs)
- The fork's **"Python engine tests"** GitHub Action is RED for *every* PR
  (pre-existing). It applies the SQL engine-schema migrations to a Postgres
  container and dies on **`tests/engine/schema/migrations/20260621130000_autonomous_undo_window.sql`**:
  `ERROR: column aa.trigger_reason does not exist` — `v_audit_view` references
  `action_audit.trigger_reason` before it's added (schema-ordering bug in a
  2026-06-21 migration). Not a per-PR regression; local vitest is the real gate.
  Worth a dedicated fix someday, but out of scope for nightly correctness patches.

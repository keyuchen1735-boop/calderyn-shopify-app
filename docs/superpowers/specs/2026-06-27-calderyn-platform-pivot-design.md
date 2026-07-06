# Calderyn Platform Pivot — Build Map (Direct Shopify Competitor)

**Date:** 2026-06-27
**Status:** Direction committed (founder decision). Grounded in a full codebase map (6 parallel subsystem readers + synthesis, 2026-06-27).
**Supersedes:** the earlier stress-test memo that recommended staying platform-agnostic — overruled. The stress-test's objections survive here as the live **Risk register**, not as a veto.

---

## Decision

Calderyn becomes a **direct Shopify competitor**: it owns its own product catalog, inventory, customers, cart, checkout, payments, storefront, and a store builder — and keeps Calderyn's existing **autopilot + multi-platform ad brain** running on top of that owned commerce stack. Payments via **Stripe** until/unless we build our own. The standalone dashboard (already in this repo, already non-Shopify) is the merchant admin; the embedded Polaris app is retired.

---

## The grounding (what the codebase actually is)

**The split is asymmetric.** ~60–80% of what we keep — the autopilot trust engine, the ad brain, the standalone dashboard shell, the data warehouse — is portable and survives leaving Shopify. The part that makes us "a competitor" — catalog-as-source-of-truth, inventory ledger, customers, cart, checkout, payments, tax/shipping, storefront, store builder, billing — is **~0% built. There is literally no checkout/cart/payment/customer/storefront/billing code in the repo.**

**What John's autopilot really is (read at source):** a deterministic per-shop *scan → decide → gate → execute → audit* loop (`runAutopilotForShop`, `app/lib/actions/autopilot.server.ts:328`) with a genuinely strong, **platform-agnostic** trust model (Beta-confidence + 7-gate graduation + pure guardrail evaluator + learned-rule vetoes + idempotency + append-only `action_audit` + undo + nightly-trained `mu` dial). **But its scope today is ads, not the store:**
- `ExecutableKind` (`execute.server.ts:14`) = **4 kinds**: pause/resume/reduce/increase *campaign budget* — all ad-platform writes.
- `GRADUATABLE_V1` (`graduation.ts:12`) = **3 kinds** {pause_campaign, reduce_campaign_budget, discontinue_sku}; nothing else can auto-run in v1.
- `NO_BRAINER` (`confidence.ts:79`, unattended day one) = **3 pause_campaign detectors.**
- Store-side executors (`adjust_price`, `reallocate_inventory`, `discontinue_sku`) write to **Shopify Admin GraphQL**, are merchant-confirm only, and `adjust_price` is explicitly never autopilot.

→ "An agent that runs your store" is, today, "an agent that pauses losing ad campaigns." The **trust engine is the crown jewel and is reusable**; making it operate an owned store is a multi-quarter build of new action-adapters + new detectors on owned signals + new graduation/undo entries per kind.

---

## Features we are KEEPING

### Keep as-is (reuse, ~verbatim) — the brain + shell

| Feature | Why it survives | Evidence |
|---|---|---|
| Autopilot decide→gate→execute→audit skeleton | Platform-agnostic; caller passes a target-blind adapter | `autopilot.server.ts:328`, `execute.server.ts:178` |
| Graduation / calibration trust model (the moat IP) | Gates *any* action kind, independent of target system — *extended toward earned full autonomy; see end-state section* | `graduation.ts:12,57`, `confidence.ts:79`, `graduation.server.ts:36` |
| Guardrail evaluator (caps, cooldown, $ ceilings, business hours) | Pure fn, already abstracts over action kind | `guardrails.ts:64`, `guardrails.server.ts:56,81` |
| Multi-platform ad ingest (Meta/Google/TikTok) | Zero Shopify concept; only the tenant key changes | `ads/adapter.ts:6,47`, `ads/ingest.server.ts:109`, `cron.ingest-ads.tsx` |
| Python scoring brain — ~18 detectors, grading, Claude rank, moat training | Operates on internal `*_fact` tables, not Shopify | `engine/calderyn_engine/pipeline.py:83`, `grade.py:25`, `detectors/`, `moat/` |
| Remediation ranker + ROAS math | Pure/SQL over internal facts; surface-agnostic | `remediation/rank.ts:97`, `roas.ts:12`, `v_campaigns_flat` |
| Nightly learning loop (`mu` dials) | Decoupled from target | `cron.autopilot-train.tsx`, `api/engine/autopilot_train.py`, `action-policy.server.ts:16` |
| **Standalone dashboard shell** (non-Polaris SPA, own CSS/icons, 13 screens) | A Shopify-independent front end **already ships**; the pivot builds on this | `DashboardApp.tsx:107`, `dashboard._index.tsx`, `components/dashboard/screens/` |
| Same-origin JSON API (35 `dashboard.api.*` routes, CSRF guard, rate limiter) | Carries over intact under a new tenant key | `dashboard/http.server.ts:40,57`, `dashboard/client.ts` |
| Supabase fact/dim warehouse (read-model / reporting spine) | Clean analytical model; keep schema, change who writes it | `seed/writer.ts:24`, `ingest/types.ts:37` |

### Keep but EXTEND (adapt at a known seam)

The five extend features (`ActionAdapter`, `SessionAuth`, `IngestETL`, `TenantIdentity`, `Higgsfield`) are detailed in the **Feature catalog** below, sorted into their MVP tiers — most are mvp-core enablers.

---

## Features we are RETIRING / REPLACING (Shopify-specific)

| Feature | Disposition | Evidence |
|---|---|---|
| Embedded Polaris app shell + `authenticate.admin` on ~30 routes + App Bridge + Shopify OAuth/session storage | **Retire** — the standalone dashboard replaces it; drop Prisma/`shopify_sessions` once no Shopify tokens are needed | `shopify.server.ts:13`, `app.tsx:33`, `auth.$.tsx` |
| Shopify Admin write executors (`productVariantsBulkUpdate`, `inventoryAdjustQuantities`, `productUpdate` status) | **Replace bodies** — the executor *caller seam* survives; rewrite mutation bodies as owned-DB writes; drop `gid://shopify/*` identity | `shopify/price.server.ts:110`, `inventory.server.ts:79`, `actions/adjust-price.server.ts` |
| Shopify webhook ingress + GID-keyed commerce rows | **Replace source** — first-party event bus + native primary keys (keep `external_id` as an optional import-map column) | `ingest/transform.server.ts`, `webhooks.*.tsx` |

---

## Feature catalog — detailed, grouped by MVP tier

Generated from the 36-feature decomposition (the coarse 1–16 + extend list fans out into the sub-features an MVP cut actually needs; `#16` agentic store generator added 2026-06-28; `#17` viral product sourcing + `#17.fulfillment` added 2026-07-05). Each carries file:line grounding for what exists vs net-new.

---

## Tier 1 — MVP-core (required for the first safe paid sale)

### extend:TenantIdentity — Owned org/account identity replacing *.myshopify.com as the tenant key

**What it is.** The internal tenant key already exists and is fully decoupled from Shopify: every *_fact/*_dim row is keyed by an internal shops.id UUID, and resolveShopId maps a lookup key to that UUID via the shops table, memoized per process (supabase.server.ts:30-47). The ONLY Shopify coupling is the lookup KEY itself — today it is shop_domain = '*.myshopify.com' (resolveShopId's .eq('shop_domain'), provisionShop's upsert onConflict shop_domain — supabase.server.ts:38,58). The pivot stops deriving the tenant from the myshopify domain and introduces an owned org/account identifier as the lookup key, while shops.id stays the universal internal UUID that everything downstream already keys on — so NO fact/dim table changes. resolveShopId(shopDomain) becomes resolveShopId(orgId|slug); provisionShop(shopDomain) becomes provisionOrg(...); the shops row gains owned identity columns (org name, slug, custom domain, billing customer) and shop_domain becomes nullable/legacy. The shopIdCache re-keys from domain to the owned id, and string checks that sniff '.myshopify.com' (e.g. isShowcaseShop, validators) get audited.

**Includes:**
- shops table gains owned identity columns (org_id/slug, display name, optional custom domain); shop_domain made nullable/legacy rather than the required unique key
- resolveShopId + provisionShop generalized to accept an owned org id; shopIdCache re-keyed to it (supabase.server.ts:30,32,54)
- Audit + replace every *.myshopify.com-derived identity assumption (session createSession arg, authenticate.admin glue, isShowcaseShop, shop-domain validators)
- Keep shops.id UUID as the single tenant FK so all ~70 *_fact/*_dim tables and v_* views are untouched

**Depends on:** —

**Data model / contracts.** shops table: ADD owned identity columns (org_slug unique, display_name, custom_domain nullable, billing_customer_id), make shop_domain nullable (legacy). resolveShopId/provisionShop signatures change from shopDomain to an owned id; shopIdCache key changes. NO change to the shops.id UUID contract or to any downstream table that does .eq('shop_id') — the whole point of the seam is that the UUID already isolates tenants. Pairs with the SessionAuth membership join (user -> org -> shop).

**Grounding.** EXISTS: the internal shops.id UUID is ALREADY the real tenant key for every fact/dim table, and resolveShopId/provisionShop already centralize the domain->UUID mapping (supabase.server.ts:30-78). NET-NEW: owned identity columns on shops, the generalized lookup signature, and the audit of every '.myshopify.com'-derived assumption across ~30 app.* routes + dashboard. Honest gap: the UUID is clean, but the STRING domain leaks widely — createSession stores shop_domain, dashboard_sessions has a shop_domain column, and provisionShop's uniqueness is on shop_domain; these are the real surface area, not the fact tables.

**MVP rationale.** A pilot merchant with no *.myshopify.com domain still needs a shops.id row for the store, catalog, orders, and session to attach to — that row currently can only be created via a myshopify domain (provisionShop). Decoupling the lookup key is the foundational prerequisite that SessionAuth, IngestETL, and ActionAdapter all hang off of, and it is cheap because the downstream UUID isolation already exists.

**Risks:**
- shop_domain is currently treated as a required unique key (provisionShop onConflict, dashboard_sessions, validators) — making it nullable without finding every NOT-NULL/uniqueness assumption risks provisioning failures
- The per-process shopIdCache memoizes by domain (supabase.server.ts:30); re-keying must be total or a stale domain-keyed entry resolves the wrong tenant
- isShowcaseShop and similar identity sniffing keyed on the domain string must move to the owned id or the showcase/demo bypass leaks into real orgs

### #5 — Owned product catalog as source of truth (mirror → owned, external_id as import-map)

**What it is.** Promote the catalog from a flat read-only Shopify mirror to a Calderyn-owned relational model where Calderyn assigns native uuid identities and is the write authority. Today sku_dim is a single flat variant table keyed by the Shopify variant GID in external_id with unique(shop_id, external_id); product_id is just a Shopify GID string, not an FK; there is no product table, no options table, no media table, and collections is merely a text[] column (tests/engine/schema/migrations/20260426000001_core_dim_tables.sql:4-20; collections added as text[] in 20260616190000_sku_product_facets.sql:6-8). All writes are mirror upserts (onConflict shop_id,external_id, last-writer-wins, transform.server.ts:85) plus three Admin write-backs that merely ASK Shopify and wait for the webhook to re-mirror (setVariantPrice price.server.ts:110; productUpdate/discontinue product.server.ts:71). This feature introduces owned product_dim / variant_dim (promoting sku_dim) / product_option / product_media / collection_dim + join, with CRUD + publish at the action boundary, demotes external_id to a nullable import-map/sync key so existing mirror rows backfill cleanly and publish-to-Shopify can round-trip, and flips the inbound webhook from blind overwrite to reconcile-against-owned.

**Includes:**
- Owned tables with native uuid PKs: product_dim, variant_dim (promotes sku_dim), product_option/option_value, product_media, collection_dim + product_collection join (replacing sku_dim.collections text[])
- external_id (Shopify Product/Variant GID) demoted to nullable import-map column; keep inventory_item_external_id for inventory sync — preserves the mirror→owned mapping
- Backfill: derive product_dim by grouping the existing sku_dim.product_id GIDs; copy each sku_dim row into variant_dim carrying retail_price_cents, unit_cost_cents, inventory_policy, inventory_tracked, vendor, tags
- CRUD + validation at the action boundary (create/update/delete/publish); never trust FormData shape — shape DTOs, return redirect() after mutation
- Authority flip: writes land in owned tables first (native id), then push to Shopify by extending the existing productUpdate/productVariantsBulkUpdate write-backs; webhook becomes reconcile-not-overwrite with drift alerting (CORE = owned price/status/inventory_policy the checkout reads; publishing workflow + bidirectional sync = fast-follow)
- Dashboard parity: the standalone dashboard's catalog/inventory screens are read mirrors today — mirror the owned-catalog data contract (not the Polaris JSX) into its own primitives

**Depends on:** —

**Data model / contracts.** New: product_dim(id uuid pk, shop_id, external_id text null [Shopify Product GID import-map], handle, title, status text CHECK(active|draft|archived), vendor, product_type, published_at, created_at, updated_at; unique(shop_id, external_id) where external_id not null). variant_dim(id uuid pk, shop_id, product_id→product_dim, external_id text null [variant GID], inventory_item_external_id text, sku, title, retail_price_cents, unit_cost_cents, currency, inventory_policy, inventory_tracked, requires_shipping bool). product_option/product_option_value, product_media(id, product_id, url, alt, position), collection_dim + product_collection. sku_dim retained as a compatibility view over variant_dim during migration so existing detectors/views (v_skus_flat_*, sku_pnl) keep resolving. Follows *_dim naming + shop_id/external_id/source_version conventions already in the warehouse.

**Grounding.** Net-new authority model; columns largely exist but scattered on the flat mirror. EXISTS: sku_dim flat mirror with unique(shop_id, external_id) (core_dim_tables.sql:4-20), incrementally extended (grams 20260616120000:22, vendor/collections 20260616190000:6-8, inventory_policy/tracked 20260624121000:3-6, retail_price_cents/product_status 20260625130000:6-10). Write-backs exist but are Shopify-authoritative ask-and-re-mirror (price.server.ts:110, product.server.ts:71). ABSENT (grep-confirmed): any owned product_dim/variant_dim/product_option/product_media/collection table, any draftOrder/storefront. order_fact is PII-stripped (minimizeOrderWebhook mappers.server.ts:449; OrderRow has zero customer fields types.ts:37-57), so the owned catalog cannot lean on customer data either.

**MVP rationale.** 'Run their store ON Calderyn' means Calderyn must own the catalog the native storefront/checkout reads price, status and availability from without round-tripping Shopify per request — the mirror (last-writer-wins, lagging webhooks) cannot be that authority. The owned variant + price + status core is mvp-core; full option/media/collection CRUD, a publishing workflow, and bidirectional Shopify reconciliation are fast-follow (a seeded pilot catalog doesn't need rich CRUD for the first sale).

**Risks:**
- Migration must keep ~70 downstream views/detectors (v_skus_flat_*, sku_pnl, sku_velocity, stockout_forecast) working — a sku_dim→variant_dim compatibility view is required or the brain breaks.
- Dual-write authority + reconcile is subtle: define Calderyn-authoritative + drift detection, or owned edits and Shopify edits clobber each other.
- No Postgres RLS — owned catalog tables holding source-of-truth raise tenant-isolation stakes vs. the read-only mirror they replace.

### extend:SessionAuth — First-party merchant accounts on the dash_live_ session system

**What it is.** The dashboard session machinery is fully reusable and identity-provider-agnostic: createSession mints an opaque dash_live_ bearer, stores only its peppered HMAC-SHA256 hash in dashboard_sessions, sets a __Host- cookie, and enforces a 30-day TTL with a sliding last_seen_at and revoked_at revocation (session.server.ts:25-156). The ONLY Shopify coupling is the identity-PROVIDER step in the OAuth callback — exchangeCodeForToken for the myshopify code, a resolveShopId install-gate, then createSession(shop) (dashboard.auth.callback.tsx:77-92) — and the fact that, per the file's own comment, session identity is the SHOP, not a person (session.server.ts:5). The pivot keeps the entire token lifecycle and swaps two things: (1) the IdP step becomes first-party account auth (email+password / passkey / Google OAuth) instead of a Shopify code exchange, and (2) the session subject moves from shopDomain to a user/account id, with the session scoped to the org/shop that user belongs to. createSession(shopDomain) becomes createSession(userId), dashboard_sessions gains a user_id column, and DashboardSession {shopId, shopDomain} becomes {userId, orgId} (still carrying shopId for downstream tenant scoping). This is merchant/operator auth into the Calderyn admin; buyer-side checkout is guest-first for the MVP, so buyer accounts are out of scope here.

**Includes:**
- New first-party login route replacing the Shopify bounce in dashboard.login.tsx + dashboard.auth.callback.tsx, doing credential/passkey/OAuth verification instead of exchangeCodeForToken
- users/accounts table with credential storage (argon2/bcrypt password hash, or passkey/OAuth link); reuse the existing DASHBOARD_SESSION_PEPPER pattern (session.server.ts:15-21)
- createSession(userId) + dashboard_sessions.user_id column; getSessionFromRequest returns userId and resolves user->org->shop membership for scoping (session.server.ts:55,84)
- Keep token mint/hash/validate/slide/revoke and requireDashboardSession/getSessionOrRedirect unchanged (session.server.ts:25-147)
- Account lifecycle: signup, password reset / magic-link, revokeAllSessionsForShop generalized to revokeAllSessionsForUser (session.server.ts:149)

**Depends on:** extend:TenantIdentity

**Data model / contracts.** Net-new users table (id, email unique, credential hash / webauthn credential / oauth_provider+subject, created_at). Net-new membership join (user_id, org_id|shop_id, role) so one user can operate one or more shops. dashboard_sessions ADD user_id (keep shop_id for the existing .eq scoping). DashboardSession type {userId, orgId, shopId}. The HMAC pepper + __Host- cookie + 30d sliding TTL contract is unchanged.

**Grounding.** EXISTS: the complete session token lifecycle — mint/hash/store/validate/slide/revoke (session.server.ts:25-156), the __Host- cookie + pepper + TTL contract, and the requireDashboardSession/getSessionOrRedirect guards. NET-NEW: a users table + credential storage, the first-party login route, the user_id column on dashboard_sessions, and the user->org->shop membership lookup. Honest gap: the code hardcodes shop-as-identity (the line-5 'v1' comment, createSession's single shopDomain arg, and dashboard_sessions storing shop_domain) — moving to user identity touches every caller of getSessionFromRequest that reads session.shopDomain, not just the auth route.

**MVP rationale.** The pivot's premise is a merchant with NO *.myshopify.com store, so the Shopify OAuth front door cannot exist — the merchant must be able to create a first-party account and log into the Calderyn admin to set up and operate the store before any sale. The token machinery is already built; only the IdP swap + user subject is net-new, which is exactly why this is a cheap-but-required mvp-core enabler. Buyer auth is deliberately excluded (guest checkout for the first sale).

**Risks:**
- Credential storage is net-new attack surface (password reset, enumeration, rate-limit) that the Shopify-OAuth path never had — must reuse the existing postgres rate limiter and harden the new login route
- Every downstream reader of session.shopDomain assumes 1 session = 1 shop; a user-with-multiple-shops model needs an explicit active-shop selector or those readers silently pick wrong
- No RLS means session scoping is enforced purely by the user->org->shop lookup correctness; a wrong join leaks cross-tenant data

### #4 — Authoritative mutable inventory ledger (decrement-on-sale, reservations, oversell guard, allocation)

**What it is.** A Calderyn-OWNED, transactional inventory system that replaces the read-only Shopify mirror as the quantity authority for a Calderyn-native checkout. Today there is no decrementable quantity anywhere: inventory_level_fact is an append-only stream of Shopify-observed snapshots (unique(sku_id, location_id, source_version), upserted with ignoreDuplicates) where `available` is simply the last number Shopify reported (tests/engine/schema/migrations/20260426000002_inventory_and_location.sql:17-26; app/lib/ingest/transform.server.ts:121-131). The only write-back, inventoryAdjustQuantities, ASKS Shopify to move a relative delta between two locations and waits for the change to re-mirror via webhook (app/lib/shopify/inventory.server.ts:79) — Shopify stays authoritative, so two concurrent buyers can both buy the last unit. This feature introduces an owned signed ledger (append-only journal of every movement), a mutable per-(variant, location) balance projection (on_hand / reserved / available) that is atomically decremented under row lock, time-boxed reservations created at cart/checkout-start and committed at payment, an oversell guard that rejects when on_hand − reserved < requested (honoring inventory_policy deny vs continue/backorder), and a multi-location allocator. The legacy inventory_level_fact mirror is retained as the Shopify-observed shadow used only for drift reconciliation, not as the source of truth.

**Includes:**
- inventory_balance projection: mutable per-(variant, location) row holding on_hand, reserved, and derived available — the decrementable state that inventory_level_fact never was
- inventory_ledger_fact: append-only signed journal (receipt / sale / reserve / release / adjust / transfer_in / transfer_out / return) with idempotency_key so webhook retries and double-submits don't double-decrement
- Atomic oversell guard: conditional UPDATE / SELECT FOR UPDATE pattern — reserve succeeds only when on_hand − reserved >= qty, returns zero rows (reject = out of stock) otherwise; respects sku_dim.inventory_policy ('deny' enforces, 'continue' allows backorder) (set in 20260624121000_shopify_inventory_settings.sql:3-6)
- inventory_reservation with TTL: held at add-to-cart/checkout-start, committed (true decrement) at payment capture, released on abandon; a reaper job expires stale holds back to available
- Decrement-on-sale trigger wired to the owned order/checkout capture event (idempotent, keyed on order id) so a paid sale moves stock exactly once
- Multi-location allocator: choose fulfilling location(s) by priority/proximity using location_dim.country/region/city, splitting a line across locations when needed (FAST-FOLLOW slice — v1 can be single-default-location)
- Two-way Shopify reconciliation: push owned balance to Shopify (inventoryAdjust/SetQuantities) and treat inbound inventory_levels webhooks as drift detection against the owned ledger rather than blind last-writer-wins; emit a drift alert via the existing alerts table

**Depends on:** #5

**Data model / contracts.** New: inventory_balance(shop_id, sku_id→variant_dim, location_id→location_dim, on_hand int, reserved int, available int generated, version bigint, updated_at; unique(sku_id, location_id)); inventory_ledger_fact(id bigserial, shop_id, sku_id, location_id, entry_type text CHECK, qty int signed, order_id→order_fact null, reservation_id null, idempotency_key text, source text, created_at; unique(shop_id, idempotency_key)); inventory_reservation(id uuid, shop_id, sku_id, location_id, qty, state text CHECK(held|committed|released|expired), expires_at, checkout_ref/order_id, idempotency_key, created_at). Keep inventory_level_fact unchanged as the Shopify-observed shadow. Follows existing shop_id + service-role scoping convention (resolveShopId at app/lib/supabase.server.ts:32); reuse the alerts table for drift. New action types registered alongside the existing inventory write-backs.

**Grounding.** Net-new in full. EXISTS today: inventory_level_fact as append-only observation (tests/engine/schema/migrations/20260426000002_inventory_and_location.sql:17-26), upserted with ignoreDuplicates so it cannot be decremented (transform.server.ts:121-131); InventoryRow carries only available/observed_at/source_version (app/lib/ingest/types.ts:28-35). Write-back inventoryAdjustQuantities exists but moves deltas between two locations and depends on Shopify as authority (inventory.server.ts:79-136). Grep-confirmed ABSENT: any reservation/hold/oversell/balance table in supabase/migrations and tests/engine/schema. There is NO transactional decrement primitive and NO oversell guard anywhere in the repo.

**MVP rationale.** The MVP definition's word 'safely' is exactly this feature: without an owned reservation + atomic oversell guard + decrement-on-sale, two real buyers can purchase the last unit and the merchant oversells on the first day. A Shopify-mirror that lags behind webhook re-ingest cannot prevent that race at checkout. The decrementable balance + reservation + oversell guard are mvp-core; multi-location allocation can degrade to a single default location for the first sale (fast-follow).

**Risks:**
- Concurrency correctness is the whole game — the conditional decrement must run inside a real Postgres transaction/row lock; the warehouse today never does mutable concurrent writes, so this is a new failure mode for the codebase.
- Dual-authority drift: while the app stays embedded in Shopify, Shopify can also mutate stock; reconciliation must define Calderyn-as-authority + drift alerting or the ledger and Shopify silently diverge.
- No Postgres RLS on the warehouse (service-role + manual .eq('shop_id')) — a mutable cross-tenant inventory authority raises the blast radius of any missed shop_id filter.

### #5-shipping — Shipping-as-product-data: rate-critical attributes (required + validated at write)

**What it is.** First-class, REQUIRED, write-time-VALIDATED shipping attributes on the owned variant so the shipping quote engine (#6) can compute a correct, safe rate at checkout. Today the only shipping attribute anywhere is weight, stored as sku_dim.grams and sourced from Shopify's variant.inventoryItem.measurement.weight (added in 20260616120000_true_ship_cost.sql:22; line-weight derivation noted at app/lib/ingest/types.ts:66-71) — there are no dimensions, no ship-from origin, no destination restrictions, and no delivery constraints; grep-confirmed there is no shipping-zone or carrier-rate table at all. This feature adds a validated variant_shipping record carrying the fields a real carrier quote needs: canonical weight, package dimensions (for dimensional weight), ship-from origin country, destination country allow/deny restrictions, and delivery constraints (signature, handling/lead days). Validation runs at the action boundary: a physical variant cannot be saved with weight ≤ 0 or missing dimensions; restricted_countries must be valid ISO codes; non-physical (digital/service) variants set requires_shipping=false and bypass the physical checks. A wrong or absent weight produces a wrong shipping charge to the buyer — i.e. an unsafe sale — which is why these are required, not optional.

**Includes:**
- Canonical weight: promote sku_dim.grams → variant_shipping.weight_grams, validated > 0 for physical variants (today grams can be null = 'unknown', types.ts:66-71)
- Dimensions: length_mm / width_mm / height_mm — required for dimensional/volumetric weight, which carriers bill on
- Origin: origin_country (ISO-3166) ship-from, for rate zones and customs
- Destination country restrictions: restricted_countries text[] allow/deny, enforced before a quote is offered
- Delivery constraints: signature_required, handling_days/lead time, no-PO-box flag
- Write-time validation at the action boundary: reject incomplete/invalid physical variants; requires_shipping=false short-circuits the physical requirements for digital/service goods
- Dashboard parity: surface and validate the same required shipping fields in the dashboard's catalog editor against its own stack

**Depends on:** #5

**Data model / contracts.** New variant_shipping (1:1 with variant_dim): variant_id→variant_dim, weight_grams int NOT NULL CHECK(>0) for physical, length_mm/width_mm/height_mm int, origin_country text CHECK ISO-3166, restricted_countries text[] not null default '{}', signature_required bool default false, handling_days int default 0, requires_shipping bool. Promote sku_dim.grams as the weight backfill source. Consumed by #6 quote engine as required inputs. Same *_dim/shop_id conventions; validation enforced in the Remix action (DTO), with DB CHECK constraints as the backstop.

**Grounding.** Net-new. EXISTS today: ONLY weight, as sku_dim.grams from Shopify measurement (20260616120000_true_ship_cost.sql:22; order_line_fact.grams same migration:21; weight semantics types.ts:66-71). ABSENT (grep-confirmed across supabase/migrations + tests/engine/schema): width/height/length, origin/origin_country, freight, hazmat, dimensions — and any shipping_zone/carrier_rate/carrier_service table. Existing ship infra (shipping_cost_period, shipping_invoice_line, order_fact.ship_cost_* in 20260616120000:5-56) is COST analytics for the merchant's P&L, NOT a buyer-facing rate input.

**MVP rationale.** A real buyer completing a real paid purchase 'safely' must be charged a correct shipping amount; #6 cannot quote a real rate without weight, dimensions, origin, and destination eligibility, and an unvalidated/missing weight yields a wrong charge — the literal unsafe-sale failure. These rate-critical fields are the thinnest set that makes a checkout shipping quote trustworthy.

**Risks:**
- Backfill gap: grams is null for many variants today (treated as 'unknown'), so flipping weight to NOT NULL needs a merchant-facing fill-in flow before the first quote, or quotes fail closed.
- Validation must fail visibly (rule 12) — a silently skipped shipping field becomes a mispriced order at checkout.

### #6.1 — Shipping-as-product-data model + origin & restrictions config (consumes #5)

**What it is.** The physical-shipment data substrate the quote engine needs but the warehouse does not have today. Calderyn currently knows only a flat per-variant gram weight (sku_dim.grams) and order header totals — it has zero package dimensions, ship class, origin, handling time, or restriction data. This slice adds a per-variant/per-package dimensional + classification model (length/width/height, dim-weight, packaging unit, ship_class, hazmat/restricted flags, freight flag, country-of-origin/HS code, declared value) plus a per-shop/per-location origin & handling-time config, and captures the privacy-safe destination geo (postal zip3 + country) needed to form a real quote and to later train delivery prediction. It is the read-only mirror extended with Calderyn-owned shipping attributes, mirroring how sku_dim already carries vendor/collections/grams.

**Includes:**
- package_dim table: per variant (and optional multi-package) length/width/height (mm), weight, dim-weight divisor, packaging type, ship_class enum, freight/LTL flag, hazmat/restricted flags, HS code, country_of_origin, declared_value_cents
- Per-shop/per-location origin config: ship-from address(es) keyed to location_dim, default handling/processing days, cutoff times, business-day calendar/holidays
- Shopify ingest extension: pull variant weight/weight_unit + (if present) harmonized_system_code/country_code_of_origin from productVariant/inventoryItem GraphQL, plus write_shipping/read_fulfillments scope additions
- Restriction ruleset: per-SKU and per-zone allow/deny (no PO boxes, no hazmat air, region embargoes) consumed by the engine to suppress invalid service options
- Destination-geo capture: store dest country + postal zip3 (truncated, no full PII) on a quote-context/fulfillment row so prediction has training lanes
- Merchant editing surface for missing dims (App home Polaris + dashboard mirror) with confidence/source provenance like ship_cost_source

**Depends on:** #5 (shipping-as-product-data ingestion/normalization)

**Data model / contracts.** New: package_dim (shop_id, sku_id FK sku_dim, dims, weight, ship_class, hazmat/freight flags, hs_code, country_of_origin, source, confidence) following sku_dim _dim conventions; ship_origin_config (shop_id, location_id FK location_dim, address, handling_days, cutoff, calendar); ship_restriction_rule (shop_id, scope sku/zone, rule). Extend sku_dim ingest only — do not overload grams. Add scopes write_shipping,read_fulfillments to shopify.app.calderynextension.toml:10.

**Grounding.** Net-new. Today sku_dim has only grams (true_ship_cost.sql:30 'alter table sku_dim add grams') plus vendor/collections (sku_product_facets 20260616190000) — NO dims/class/origin/restrictions. order_fact has customer_country/region/city but NO postal zip (orders_and_fulfillments.sql), and minimizeOrderWebhook strips the shipping address entirely keeping only total_shipping_price_set amount (mappers.server.ts:449). v_order_ship_features already falls back to item_count when any line lacks weight (20260616120200_v_order_ship_features.sql) — proof weight coverage is sparse today. Current scopes (read_inventory,read_locations,read_orders,read_products,write_inventory,write_products at shopify.app.calderynextension.toml:10) lack write_shipping/read_fulfillments.

**MVP rationale.** A carrier cannot return a real rate without package weight/dims, an origin, and a destination. Without this substrate every quote is a guess, so the thinnest safe real-sale path requires at least weight+origin+destination (dims can be approximated for v1, hazmat/freight deferred).

**Risks:**
- Dimension coverage is sparse — many merchants never set package dims; need a safe default (bounding-box from grams) plus visible 'estimated' provenance (rule 12) so quotes are never silently wrong
- Capturing destination zip touches PII boundary the warehouse deliberately avoids (mappers.server.ts:449 strips address) — must truncate to zip3 and document the carve-out
- Scope additions force merchant OAuth re-consent, a friction point before any sale

### extend:ActionAdapter — Store-action adapter (set price / reserve-decrement inventory / publish product)

**What it is.** Today the action system is ad-campaign-only: the ActionAdapter interface exposes pause/resume/setDailyBudget/getState over a CampaignActionState (actions.ts:44-50), actionAdapterForShop dispatches by ad Platform = meta|google|tiktok + showcase (action-registry.server.ts:11-24, adapter.ts:6), and executeAction is hardwired to read ad_campaign_dim, ownership-check on shop_id, compute pre/post budget states, and switch on ExecutableKind = pause/resume/reduce/increase budget (execute.server.ts:14-18, :178-334). The pivot adds a parallel StoreActionAdapter (setPrice / reserveInventory / releaseInventory / publishProduct / editPage) and store-action ExecutableKinds beside the campaign ones. Crucially the audit+idempotency tail is ALREADY resource-agnostic — priorExecutionForKey (execute.server.ts:48) and insertAuditWithIdempotency (execute.server.ts:119) take an action_kind string + params + pre/post JSON and write one append-only action_audit row keyed by action_idempotency — so a store executor reuses that tail verbatim and only swaps the resolve step (sku/product instead of ad_campaign_dim) and the platform call. The Shopify-side write primitives already exist but OUTSIDE this system (setVariantPrice price.server.ts:110, inventoryAdjustQuantities inventory.server.ts:79); the pivot re-points those writes at Calderyn's OWNED commerce tables so Calderyn is the system of record rather than asking Shopify and waiting for the mirror webhook.

**Includes:**
- StoreActionAdapter interface beside ActionAdapter (setPrice, reserveInventory, releaseInventory, publishProduct, editPage) with a StoreActionError reusing the retriable/isRetriableFailure classification (actions.ts:15-42)
- Store-action branch in the executor that resolves against the owned catalog/inventory tables instead of ad_campaign_dim, reusing priorExecutionForKey + insertAuditWithIdempotency unchanged (execute.server.ts:48,119)
- Registry dispatch entry (storeActionAdapterForShop) parallel to meta/google/tiktok, keeping the dispatcher resource-blind (action-registry.server.ts:11)
- Idempotent inventory reserve/decrement used by checkout (oversell/double-decrement guard) — the safety-critical write
- Wire the existing setVariantPrice / inventoryAdjustQuantities mutations behind the adapter, switching their target from Shopify Admin to the owned commerce layer

**Depends on:** extend:IngestETL, extend:TenantIdentity

**Data model / contracts.** New StoreActionAdapter TS interface + new ExecutableKind union members (set_price, reserve_inventory, publish_product). Reuse action_audit + action_idempotency tables AS-IS (action_kind is already a free string, params/pre_state/post_state are JSON). Net-new owned tables: a decrementable inventory ledger (inventory_ledger / inventory_reservation) because inventory_level_fact is an append-only OBSERVATION with onConflict sku_id,location_id,source_version (transform.server.ts:121-131), not a balance you can atomically decrement; and a writable owned price column on the commerce SKU table (today sku_dim.retail_price_cents is a read-only Shopify mirror value).

**Grounding.** EXISTS: the entire audit/idempotency tail and adapter/registry pattern (execute.server.ts:48,119,178; action-registry.server.ts:11; actions.ts:44), plus the Shopify write primitives (price.server.ts:110, inventory.server.ts:79). NET-NEW: the StoreActionAdapter interface, store ExecutableKinds, the executor's store-resolve branch, an owned decrementable inventory ledger, and a writable owned price field. Honest gap: executeAction's MIDDLE (steps 0-5: budget validation, ad_campaign_dim read, optimistic mirror update — execute.server.ts:183-315) is NOT reusable for store actions; only the head (idempotency) and tail (audit) are. This is a parallel executor that shares the bookends, not a drop-in adapter swap.

**MVP rationale.** For a buyer to complete a real paid purchase safely, the platform must set the authoritative price and atomically reserve/decrement real stock at checkout — that write path is what makes Calderyn the system of record rather than a Shopify mirror. Idempotent inventory decrement is a safety requirement (prevents oversell/double-charge), so it cannot be deferred. The autopilot-DRIVEN variant (brain proposing price/inventory store actions) is fast-follow; the raw merchant/checkout-invoked write is mvp-core.

**Risks:**
- inventory_level_fact's append-only observation model gives no atomic balance — a naive reserve-at-checkout will oversell under concurrency; the new ledger needs row-level locking or a conditional decrement, not an upsert
- executeAction is campaign-shaped in the middle; forcing store actions through it (vs a sibling executor) risks coupling unrelated semantics — decide the split before coding
- No Postgres RLS (service-role + manual .eq shop_id) means the store-resolve branch must replicate the cross-tenant ownership guard executeAction does at :199-206 or leak writes across tenants

### extend:ShipCostAdapter — Carrier rate-quote adapter layer (buyer-facing rates, reusing the cost connector pattern)

**What it is.** A second, quote-direction capability on the existing provider-blind shipping adapter contract. Today the adapter family fetches ACTUAL PAID charges for cost analytics (EasyPost selected_rate.rate, the post-purchase amount). This slice adds a getRates(shipment) path that, given origin+destination+packages+requested service levels, returns live carrier rate options (carrier, service, amount, currency, quoted transit days, guaranteed-delivery flag). It reuses the same integration_credentials store, crypto, provider-blind seam, and cron/error-visibility discipline, but hits the rate-quote endpoint instead of the charges endpoint. MVP-thin ships one aggregator (EasyPost: USPS/UPS/FedEx in one credential); the deep version adds direct carrier accounts and more providers.

**Includes:**
- RateQuoteAdapter interface alongside ShipCostAdapter: getRates(originAddr, destAddr, parcels[], serviceFilter) -> NormalizedRateOption[] (carrier, service_code, service_name, amount_cents, currency, est_transit_days, guaranteed, delivery_date_estimate)
- EasyPost rate-quote implementation: create Shipment -> read all rates (reuse easypost.server.ts auth/paging, new endpoint), negotiated-rate support
- Provider-blind normalization (NormalizedRateOption) so engine/checkout never branch on carrier — mirrors NormalizedShipmentCost
- Credential reuse: same integration_credentials kind easypost_ship via crypto.server.ts; no new auth model for v1
- Timeout/fallback contract: hard p95 budget (carriers are slow; checkout callback must answer in <~5s) with a static fallback-rate table when the carrier API is slow/down
- Per-shop rate adjustments hook (markup %, handling surcharge, free-ship threshold) applied by the engine, not the adapter

**Depends on:** #6.1

**Data model / contracts.** New RateQuoteAdapter contract mirroring app/lib/ship-cost/adapters/adapter.ts; NormalizedRateOption type. Optional ship_rate_quote_log (shop_id, request_hash, options jsonb, latency_ms, provider, fallback_used) for observability + cache. No new credential table — reuse integration_credentials (kind easypost_ship).

**Grounding.** Extends an existing, proven pattern. app/lib/ship-cost/adapters/adapter.ts:7 defines ShipProvider = easypost|shippo|shipbob|shiphero and a provider-blind ShipCostAdapter; easypost.server.ts:1-31 already authenticates (HTTP Basic API key) and reads selected_rate.rate — but that is the COST side (actual paid), grep-confirmed there is NO buyer rate-quote call anywhere. land.server.ts/runner.server.ts show the cron + failure-visibility discipline to mirror. integration_credentials already supports easypost_ship (20260601010000 + 20260616150000_shippo_ship_kind.sql).

**MVP rationale.** 'Real carrier rates' is in the feature's one-line definition and ON BY DEFAULT — the first real buyer must see a real rate. One aggregator delivering USPS/UPS/FedEx is the thinnest real version; more providers/direct accounts are deepening.

**Risks:**
- Carrier APIs are slow and flaky; without a strict timeout + fallback the checkout callback will time out and Shopify will show NO rates (blocks the sale) — fallback table is mandatory, not optional
- Cost-side EasyPost integration reads selected_rate post-purchase; rate-quote uses a different request shape (Shipment create + rate list) and may need rate-shopping creds/carrier accounts the merchant hasn't configured
- Negotiated vs list rates can mislead margin if not reconciled against the existing cost side

### #6.3 — Single-source-of-truth shipping quote engine

**What it is.** The deterministic core that every surface calls so checkout, storefront, and buy-in-chat can never disagree. Given a cart (line items -> package_dim), a ship-from origin, a ship-to destination, and requested service options, it assembles parcels, calls the rate adapters, applies merchant rules (markup, handling, free-ship thresholds, zone overrides, restriction filtering, blended/cheapest/fastest selection), attaches a delivery-date window per option, and returns a canonical ShippingQuote object. It is pure server code with no model-in-the-loop (rule 5: rates/thresholds are deterministic), is idempotent + cacheable by request hash, and degrades to a fallback rate when carriers are unavailable so it always returns something safe. This is the contract all three consumer surfaces share.

**Includes:**
- quoteShipping(cart, origin, destination, options) -> ShippingQuote{options:[{service, carrier, amount_cents, delivery_window{earliest,latest}, guaranteed, pickup_available}], currency, source, fallback_used}
- Parcel assembly: pack cart lines into parcels from package_dim (dim-weight, multi-box, freight detection) with bounding-box fallback when dims missing
- Merchant rule layer: markup/handling, free-shipping threshold by cart value/region, zone overrides, blended-rate flattening, restriction suppression (no PO box / hazmat air / embargo)
- Delivery-window assembly: combine carrier quoted transit days + origin handling/cutoff/business-calendar -> earliest/latest date; pluggable to #6.6 prediction later
- Caching + idempotency: request-hash cache (short TTL), so identical checkout re-quotes are cheap and stable
- Fallback policy: deterministic static rate/zone table when adapters error/timeout, flagged fallback_used (rule 12 visibility)
- Single typed DTO consumed by checkout callback, storefront, and MCP — no per-surface re-implementation

**Depends on:** #6.1, extend:ShipCostAdapter

**Data model / contracts.** New ShippingQuote DTO (canonical, typed, shared). ship_zone_config / ship_rule_config (shop_id, region matcher, free_threshold_cents, markup, blended_flag, override_amount_cents) — merchant rule store. ship_fallback_rate (shop_id, zone, weight_band, amount_cents) for degraded mode. Engine lives in app/lib/shipping/ alongside app/lib/ship-cost/.

**Grounding.** Net-new; no quote engine exists (grep-confirmed ABSENT: checkout, shipping-zone, tax-rate, storefront). The closest existing analog is the ship-COST resolver (runner.server.ts) which reads ONE source (the v_order_ship_features view) — same single-source discipline to mirror, but cost-direction. Rule 5 in CLAUDE.md mandates thresholds/routing live in deterministic code, not the model — this engine is that deterministic seam.

**MVP rationale.** This is the 'single source of truth consumed by every surface' the feature explicitly requires. Even the thinnest real sale needs one trustworthy quote path that checkout calls; building it once prevents checkout/storefront/chat from quoting different prices (a safety failure).

**Risks:**
- Free-ship thresholds + markup interacting with carrier rates is where merchants lose money silently — every applied rule must be auditable, not averaged (rule 7)
- Cache TTL vs rate freshness: stale cached rates at checkout can quote a price the carrier no longer offers; bound TTL tightly
- Parcel-packing heuristics are a deep rabbit hole; v1 must ship a simple single-parcel-by-weight model and flag low confidence

### extend:IngestETL — Owned-checkout event source into the raw -> transform -> DLQ pipeline

**What it is.** The ingestion spine is reusable and source-pluggable: transformPendingWebhooks pulls unprocessed rows from raw_shopify_webhook, canonicalizes the topic, dispatches to apply{Order,Inventory,Product,Refund}, upserts facts idempotently (onConflict external_id/source_version, last-writer-wins), and routes any failure to the DLQ while still stamping processed_at so nothing loops (transform.server.ts:28-78). Today the SOURCE is Shopify webhooks forwarded into raw_shopify_webhook. The pivot keeps the transform/upsert/DLQ worker and the apply* upserters but changes the source: Calderyn's own checkout/admin emits the same fact-shaped events (e.g. CHECKOUT_COMPLETED, INVENTORY_RESERVED) into a raw intake table via /internal/*, and a new canonicalTopic branch maps them to the existing upserters. Two contract changes follow from owning (not mirroring) the data: order_fact today carries ZERO customer PII because minimizeOrderWebhook strips name/email/phone/address (mappers.server.ts:449) — a real store of record must instead CAPTURE customer identity for fulfillment, receipts, and support; and the inventory branch must move from upserting an append-only observation (transform.server.ts:121-131) to appending a decrementable ledger entry, because a real purchase moves stock. The idempotency key shifts from Shopify GID + source_version to the checkout/event id, but the replayable, DLQ-backed, idempotent shape is preserved.

**Includes:**
- New intake: raw_calderyn_event table (or a namespaced topic family inside raw_shopify_webhook) fed by checkout via the existing /internal/* forward path
- New canonicalTopic dispatch branches (CHECKOUT_COMPLETED -> applyOrder, INVENTORY_RESERVED/RELEASED -> ledger) reusing the transformPendingWebhooks loop + DLQ verbatim (transform.server.ts:40-78)
- Order mapper that CARRIES owned data instead of minimizing a Shopify payload — reversing minimizeOrderWebhook's PII strip (mappers.server.ts:449) into a real customer capture
- Inventory apply rewritten from observation-upsert to ledger-append/decrement (shared with extend:ActionAdapter's reserve path)
- Idempotency keyed on the checkout/event id; keep the DLQ (ingestion_dlq) + processed_at stamping so failed events are visible and replayable (rule 12)

**Depends on:** extend:TenantIdentity, extend:ActionAdapter

**Data model / contracts.** Net-new raw_calderyn_event intake (shop_id, event_id, topic, payload, processed_at) or a reserved topic namespace in raw_shopify_webhook. order_fact EXTENDED with a customer FK (or a new customer_dim holding the PII that minimizeOrderWebhook currently strips). Net-new decrementable inventory ledger replacing observation-only semantics for owned stock. Idempotency contract: event_id (not Shopify GID+source_version). Reuse ingestion_dlq + the writeDlq path (transform.server.ts:63) unchanged.

**Grounding.** EXISTS: the full transform/upsert/DLQ worker and all four apply* upserters with their idempotent onConflict keys (transform.server.ts:28-252), the /internal/* forward intake, and ingestion_dlq. NET-NEW: the checkout event emitter, a raw intake table/topic for native events, the customer-capture order mapper (reversing the PII strip at mappers.server.ts:449), and the decrementable inventory ledger. Honest gap: last-writer-wins + source_version is a MIRROR-reconciliation strategy (external truth wins); for owned writes the checkout IS truth, so the conflict model changes from 'newest external version wins' to 'event id is authoritative, dedup-only' — same mechanism, different invariant.

**MVP rationale.** This is the data spine of a real paid purchase: the order must land as owned order_fact/order_line_fact and stock must move, or there is no record of the sale and no inventory truth. The pipeline is already built and idempotent/DLQ-backed; only the source and two table contracts are net-new, making it a required-but-bounded mvp-core enabler.

**Risks:**
- Reversing minimizeOrderWebhook reintroduces customer PII into a warehouse with NO RLS — PII now lives behind service-role + manual .eq(shop_id), so the privacy posture that justified the strip must be re-established before storing real buyer data
- Observation-to-ledger change is not a mapper tweak: every downstream view/derivation that reads inventory_level_fact as 'latest observation' (stockout_forecast, v_* views) must be revisited or it reads the wrong stock model
- Mixing native events and Shopify mirror events in one transform loop risks topic-collision; namespacing must be explicit or a native CHECKOUT_COMPLETED could be mis-dispatched

### #1 — Buyer identity & consent (guest)

**What it is.** Net-new buyer-side identity for a Calderyn-native storefront. A buyer at checkout supplies contact email plus shipping/billing addresses and records explicit acceptance of terms/privacy plus an optional marketing-consent flag; no password is required (guest checkout). This is a brand-new OLTP store of customer PII that must live deliberately OUTSIDE the analytics warehouse, because order_fact/OrderRow strip every customer field by design (ingest/types.ts:37-57, mappers.server.ts:444-449). Checkout links an order to a buyer record by internal UUID only; name/email/address never cross into the warehouse. It is a different subject from the existing merchant peer-data consent (shops.peer_data_consent, calderyn.server.ts:1931).

**Includes:**
- Guest buyer record (email normalized + optional phone), unique per shop
- Address book: validated shipping + billing addresses
- Consent capture: ToS/privacy acceptance (version + timestamp), marketing opt-in boolean, source IP/UA as proof
- PII access boundary using Postgres RLS (current_shop_id()) — NOT the legacy service-role + manual .eq('shop_id') pattern
- Order→buyer linkage stored only in the OLTP order table, never emitted to order_fact
- Merchant-facing customer list mirrored into the dashboard surface (parity)

**Depends on:** extend:storefront-tenant-resolution

**Data model / contracts.** New OLTP tables: buyer_dim(id uuid, shop_id, email_normalized, phone, created_at; unique(shop_id,email_normalized)); buyer_address(id, buyer_id, kind 'shipping'|'billing', name/line1/line2/city/region/postal/country/phone, is_default); buyer_consent(id, buyer_id, policy 'tos'|'privacy'|'marketing', version, accepted, source_ip, ua, captured_at). RLS modeled on ad_click_ref (20260606130000_attribution.sql) and the security hardening migration (20260619170000_security_audit_rls_hardening.sql). Hard invariant: warehouse order_fact gains NO PII columns.

**Grounding.** Net-new in full: no cart/checkout/customer/address/consent table exists (grep-confirmed absent). order_fact/OrderRow carry zero customer fields (ingest/types.ts:37-57) and minimizeOrderWebhook strips name/email/phone/address before storage (mappers.server.ts:444-449), so a PII store cannot reuse the warehouse and must be a separate OLTP domain. The only existing 'consent' is merchant peer-data consent (calderyn.server.ts:1931-1957) — unrelated subject. RLS pattern to copy already exists on newer tables (current_shop_id()).

**MVP rationale.** A buyer cannot receive goods or a receipt without a contact and a shippable address, and the store cannot transact 'safely' without recording terms/privacy acceptance. Guest-only keeps it thin: no login system is needed for the first real sale.

**Risks:**
- PII now lives in Calderyn's own DB; the legacy 'no RLS, manual .eq(shop_id)' pattern is unsafe here and must be replaced with RLS + buyer-scoped policies
- Must hold the invariant that NO PII ever leaks into order_fact/the warehouse
- Address validation/i18n is a scope-creep magnet — keep to a flat schema for the pilot

### #6.4 — Checkout surface — Shopify CarrierService registration + live callback (ON BY DEFAULT)

**What it is.** The integration that makes Calderyn the actual rate provider a real buyer sees at real checkout — the gating path for 'a real buyer completes a real, paid purchase.' On install/connect, Calderyn registers a CarrierService against the shop (Admin GraphQL, like setVariantPrice does for price write-back) pointing Shopify at a Calderyn callback URL. At checkout Shopify POSTs the cart + full destination directly to that endpoint; Calderyn calls the quote engine and returns rate options in Shopify's carrier-rate JSON shape within the timeout. This is what 'ON BY DEFAULT' means: once registered, every checkout uses Calderyn rates with no theme edits.

**Includes:**
- CarrierService registration mutation (Admin GraphQL) on connect, with callback_url, service_discovery=true — written via the existing authenticated Admin client, same pattern as price.server.ts setVariantPrice
- Public, unauthenticated-but-HMAC-verified callback route (Shopify-signed) receiving {rate:{origin, destination, items, currency}} and returning {rates:[{service_name, service_code, total_price, currency, min/max_delivery_date}]}
- Strict latency budget + fallback: must answer within Shopify's window or checkout shows no rate — wire engine fallback_used path
- De-dup/idempotency on the callback (Shopify retries) keyed like webhook handlers
- Lifecycle: re-register on scope/app upgrade, deactivate on uninstall, surface registration status in app home
- write_shipping scope add + re-consent flow

**Depends on:** #6.3

**Data model / contracts.** New ship_carrier_service_registration (shop_id, carrier_service_gid, callback_url, active, registered_at). Reuse Admin GraphQL via app/shopify.server.ts authenticated client. Callback route under app/routes/ (public, HMAC-verified) — NOT a dashboard.api.* route. Returns Shopify CarrierService rate JSON, not dashboardJson.

**Grounding.** Net-new; grep-confirmed ABSENT: checkout, CarrierService, deliveryPromise. The write-back mechanism mirror exists: setVariantPrice (price.server.ts:110) and inventoryAdjustQuantities (inventory.server.ts:79) already mutate Shopify via the authenticated Admin client — CarrierService registration is the same shape. Current scopes (shopify.app.calderynextension.toml:10) lack write_shipping, which CarrierService requires.

**MVP rationale.** This is literally the surface where the first real paid purchase computes its shipping cost. Without CarrierService registration the engine is invisible at checkout and no real sale uses it. It is the definitional MVP gate.

**Risks:**
- CarrierService callbacks have a hard timeout; a slow carrier or cold start makes Shopify drop rates and the buyer cannot check out — the engine fallback path is load-bearing for the sale, not a nicety
- Registration requires the merchant on a plan/shop config that permits third-party carrier-calculated shipping (historically an Advanced/annual or Carrier Calculated Shipping entitlement) — a real onboarding blocker to detect and surface
- Callback endpoint is public and Shopify-signed; HMAC verification must be exact or it is an open rate oracle / spoofing surface

### #2 — Cart, checkout & order state machine (order origination)

**What it is.** The transactional spine. A buyer builds a cart priced against sku_dim variants (retail_price_cents), enters checkout (address from #1, payment from #3), and on successful payment Calderyn ORIGINATES an order in a new OLTP source-of-truth with an explicit state machine (cart → checkout_pending → paid → fulfilled / cancelled / refunded). Today orders exist only as read-only mirrors of Shopify arriving via webhook ETL; net-new, Calderyn becomes the system of record. Critically, each state transition emits the SAME warehouse rows the Shopify path produces — order_fact (onConflict shop_id,external_id), order_line_fact (onConflict order_id,external_line_id) and attribution rows — so sku_pnl, sku_velocity, stockout_forecast, campaign_grade and the autopilot ad-brain keep working unchanged. The paid transition itself is driven by #3's Stripe webhook.

**Includes:**
- cart + cart_line priced against sku_dim
- checkout_session with totals (tax/shipping as flat/manual placeholders for the pilot)
- Order state machine with audited transitions
- Inventory reservation/decrement at checkout to prevent oversell ('safely')
- Order-confirmation page + email
- Warehouse emission adapter: OLTP order → order_fact/order_line_fact/attribution_fact via the existing idempotent upsert contract
- Merchant order-management view mirrored into the dashboard surface (parity)

**Depends on:** #1, extend:inventory-ledger

**Data model / contracts.** New OLTP: cart/cart_line, checkout_session, order (SoT: id uuid, shop_id, buyer_id→#1, state enum, totals, currency, financial_status, attribution snapshot), order_line. Warehouse contract: synthesize external_id as a Calderyn-native GID (e.g. gid://calderyn/Order/<uuid>) and source_version as a monotonic clock (Date.parse on transition time) to satisfy the last-writer-wins upserts at transform.server.ts:162/190; emit attribution as ad_click_ref(order_id,platform,click_id). order.state mirrors into order_fact.financial_status.

**Grounding.** order_fact is mirror-only today, written by transform.server.ts (upsert onConflict shop_id,external_id:162; order_line_fact onConflict order_id,external_line_id:190); an origination seam already exists as internal.forwardWebhook → raw_shopify_webhook with 23505-tolerant idempotency (calderyn.server.ts:1960-1983). Net-new: cart/checkout/order-SoT/state-machine (grep-confirmed absent). Inventory today is append-only observation, NOT a decrementable ledger (inventory_level_fact upsert onConflict sku_id,location_id,source_version, ignoreDuplicates — transform.server.ts:121-130), so reservation is a genuine new subsystem.

**MVP rationale.** This IS the purchase. Without cart→checkout→order and a paid-state transition there is no sale at all. Oversell protection (reservation) is part of transacting 'safely.'

**Risks:**
- inventory_level_fact is an append-only observation, not a ledger — reservation/decrement is net-new (surfaced as extend:inventory-ledger), otherwise the store can oversell
- The Calderyn-native order external_id/source_version scheme must not collide with Shopify GIDs if a store is ever dual-sourced
- No tax-rate/shipping-zone tables exist (grep-confirmed absent) — first pilot must use flat/manual rates; full tax/shipping is a later feature

### #7 — Storefront rendering + hosting + domain routing

**What it is.** A public, server-rendered storefront that lets an anonymous buyer browse a pilot merchant's owned catalog (home, collection/list, product detail) and start a purchase — the minimum surface a buyer can buy from. It is a small fixed set of hard-coded SSR templates parametrized by per-shop brand settings (name, logo, palette), NOT a visual builder. It introduces a fundamentally new request posture for this codebase: an unauthenticated, multi-tenant entry point that resolves the incoming Host/subdomain to an internal shop UUID and manually scopes every read by shop_id (there is no Postgres RLS). It reads the owned mirror (sku_dim, collections, inventory_level_fact for availability) and hands the buyer's add-to-cart/checkout intent off to the separate commerce-write/checkout feature. Domain routing attaches each merchant's storefront host (wildcard *.calderyn or custom domain) to the right tenant and serves it on a public origin distinct from the embedded admin and the dashboard.

**Includes:**
- Public SSR Remix routes (home, collection, product detail, cart shell) that live OUTSIDE the authenticate.admin guard — a new unauthenticated route group
- Host/subdomain -> shop UUID resolution via resolveShopId, with mandatory manual .eq('shop_id') scoping on every storefront query (no RLS)
- A small fixed template set (2-3 themes) parametrized by thin brand/store settings (name, logo asset ref, color palette, homepage hero) — the thin config that substitutes for the #8 builder
- Read path over the owned catalog: group sku_dim variants into products, render price/currency, derive availability from inventory_level_fact (observation, not a ledger), collection listing
- Product image source: net-new ETL to mirror Shopify product image URLs into the catalog (sku_dim has none today), or consume owned URLs from #9
- Domain routing + hosting: Vercel wildcard domain / custom-domain attach, public-storefront CSP + cache headers distinct from the embedded-admin security headers in vercel.json
- Buyer SEO basics: title/meta/OpenGraph, robots, sitemap — a real storefront must be indexable
- Buy/add-to-cart entry that hands off to the checkout/payment feature

**Depends on:** checkout-payment (commerce-write: cart/checkout/order capture — not in this set; storefront alone cannot take money), catalog-image-mirror (extend ingest to pull Shopify product image URLs), #9 (stable owned asset hosting; can degrade to hotlinking Shopify CDN at first)

**Data model / contracts.** Extend the catalog mirror with image URL(s) (SkuRow/sku_dim or a product_dim grouping on product_id, app/lib/ingest/types.ts:8-26). New store_settings_dim (shop_id, store_name, logo_asset_ref, theme_palette, template_id) and a domain_dim mapping host -> shop_id for routing. Public read view(s) v_storefront_product scoped by shop_id (consistent with existing v_* + manual shop scoping; service-role only).

**Grounding.** Net-new in its entirety. Today app/routes/_index.tsx is a static marketing stub that redirects ?shop= to the embedded admin /app — there is no product/collection/cart/checkout route. Every one of ~30 app.* routes is authenticate.admin-gated (shopify.server.ts:13) and the dashboard is dash_live_ bearer-gated, so NO public unauthenticated tenant-scoped render path exists. sku_dim has no image field (app/lib/ingest/types.ts:8-26) and ingest never pulls product images. vercel.json is a single Remix project (region pdx1) with one rewrite and no wildcard/custom-domain routing.

**MVP rationale.** It is literally the surface a buyer loads to see products and begin a purchase — without it there is no place to transact. It is scoped to the thinnest viable renderer (fixed templates + brand settings + domain routing), explicitly excluding the visual builder (#8). It is on the critical path for the first real, paid sale.

**Risks:**
- No Postgres RLS — every storefront query must manually scope shop_id or risk cross-tenant catalog/price/inventory leakage on a public surface
- inventory_level_fact is an append-only observation (onConflict sku_id,location_id,source_version), not a decrementable ledger — naive 'in stock' display can oversell or show stale availability
- Product images are not mirrored today; storefront has nothing visual to render until the image-mirror ETL or #9 lands
- New public origin = new attack surface and a CSP/header posture that diverges from the embedded-admin headers in vercel.json; cannot reuse the App Bridge/Polaris embedded assumptions
- Storefront cannot complete a paid purchase by itself — it depends on the separate checkout/payment feature

### #3 — Payments (Stripe) + transaction ledger

**What it is.** Net-new money movement. Checkout creates a Stripe PaymentIntent rendered through the Stripe Payment Element so raw card data never touches Calderyn servers (PCI SAQ-A), confirms/captures it, and on Stripe's webhook confirmation drives the #2 order to 'paid'. Every money event (authorization, capture, failure) is recorded in an append-only transaction ledger that becomes the financial source of truth and feeds order_fact.financial_status. Today there is zero payment surface — no Stripe, no payment/transaction/payout tables (grep-confirmed absent); the only write-backs in the system are Shopify Admin price/inventory mutations.

**Includes:**
- Stripe PaymentIntent create/confirm/capture
- Stripe Payment Element on the checkout page (no PAN on Calderyn servers)
- Idempotent Stripe webhook handler (charge.succeeded/failed) driving order state
- Append-only transaction_ledger
- Currency handling + payment-failure/retry UX
- Reconciliation of each Stripe event → order + ledger

**Depends on:** #2

**Data model / contracts.** New tables: payment_intent(stripe_pi_id, order_id, amount_cents, currency, status); transaction_ledger(id, shop_id, order_id, kind 'auth'|'capture'|'refund'|'fee'|'payout', amount_cents signed, stripe_ref, occurred_at — append-only); stripe_event(stripe_event_id unique — idempotency mirroring raw_shopify_webhook's unique(webhook_id), 23505-tolerant insert at calderyn.server.ts:1970-1979). On capture: set order.state=paid and emit order_fact.financial_status='paid' through #2's adapter. Stripe secret via process.env / .env.local per repo secret rules.

**Grounding.** No payments anywhere (grep-confirmed absent: stripe/paymentIntent/transaction/payout). Existing write-back is Shopify Admin mutations only (setVariantPrice price.server.ts:110, inventoryAdjustQuantities). Idempotency pattern to copy: raw_shopify_webhook unique(webhook_id) with 23505-tolerant insert (calderyn.server.ts:1970-1979). Entirely net-new money rail.

**MVP rationale.** 'A real buyer can complete a real, PAID purchase' — payment capture is the literal definition of the MVP. The append-only ledger is required so the paid state is trustworthy and auditable ('safely').

**Risks:**
- PCI: must use Stripe Elements/PaymentIntents and never touch raw card numbers (SAQ-A); a single mistake escalates compliance scope
- Webhook idempotency and out-of-order/duplicate events must be handled or order state corrupts
- Ledger must be append-only and reconcile to Stripe exactly — per rule 12, never report a paid order it can't tie to a captured charge

### #13 — Warm-lead one-click import (orchestrator + cutover state machine)

**What it is.** A guided migration that converts an already-installed Shopify shop (currently a read-only mirror) into a Calderyn-owned org that the merchant can actually transact on. It is a state machine over the shop record — mirror -> importing -> dual_run -> live_on_calderyn (+ rolled_back) — that orchestrates a consistent snapshot of the mirrored warehouse, a promote step that materializes owned source-of-truth tables, a set of gap-fill jobs for things the mirror cannot carry (customers, theme, redirects), a hard parity+payment gate, and the actual cutover that flips the storefront/checkout and the write-back path. It is the 'warm lead' funnel because the merchant has already installed the extension, so ~70% of the catalog/inventory/order data is already sitting in Supabase keyed by Shopify GID — the import is mostly 'promote what we already mirror' plus honest gap-fill. For the first pilot this is white-glove (operator-triggered, one shop), not the eventual self-serve one-click button. The state machine is the spine; the promote engine (#13.promote), write-back flip (extend:write-back), customer re-pull (#13.customers), and theme/SEO bridge (#13.aesthetics-seo) hang off it.

**Includes:**
- shops.org_mode column (mirror | importing | dual_run | live_on_calderyn | rolled_back) extending the existing provisionShop row (supabase.server.ts:54)
- Snapshot/freeze step: pin a consistent source_version watermark across the mirror tables so the promote read is point-in-time (mirror facts are last-writer-wins by external_id+source_version)
- migration_run fact (audit of each cutover attempt: started_at, watermark, parity result, gate decisions, operator) — mirrors the action_audit pattern
- Parity gate: reconcile owned vs mirror (SKU count, location count, order GMV total, inventory on-hand sum) and BLOCK cutover on any mismatch, surfacing the diff (rule 12, fail visibly)
- Go-live safety gate: refuse cutover until a payment processor is live AND a test transaction has cleared — this is the 'safely' / 'real paid purchase' bar of the MVP
- Cutover step: flip storefront/checkout to Calderyn, ship the redirect map, and switch the write-back target (calls extend:write-back)
- Rollback: keep Shopify warm for N days; one operator switch returns org_mode to mirror and re-points checkout
- Operator/onboarding surface: a new 'Go live on Calderyn' path that slots into the existing onboarding wizard (app.onboarding.tsx) on the embedded side and a mirrored progress screen on the dashboard

**Depends on:** #13.promote, extend:write-back, Owned commerce primitives (cart/checkout/payment/customer SoT) — ABSENT today; #13 fills/cuts over to them but does not build the checkout engine itself

**Data model / contracts.** New: shops.org_mode (enum/text col on existing shops table, resolveShopId/provisionShop already own this row, supabase.server.ts:32/54); migration_run fact (shop_id, run_id, watermark_source_version, phase, parity_json, payment_ok bool, started_at, cutover_at, rolled_back_at) following the *_fact + action_audit naming; cutover_gate_result (per-check rows). Reuses shop_id UUID tenancy (manual .eq('shop_id'), no RLS) and external_id (Shopify GID) as the join key into import_map (#13.promote).

**Grounding.** Net-new state machine; nothing like it exists. Grounded seams: provisionShop (supabase.server.ts:54) already upserts the shops row + seeds autopilot features — org_mode and the migration trigger extend it. resolveShopId (supabase.server.ts:32) gives the internal UUID. The onboarding wizard exists (app.onboarding.tsx, 5 steps incl. a live Admin round-trip on the 'shopify' step) and is the natural host. Grep confirms NO existing cutover/org_mode/checkout/payment scaffolding (only an unrelated SQL fn matched). Owned commerce (cart/checkout/payment/customer) is grep-confirmed ABSENT, so the cutover target tables are themselves net-new dependencies.

**MVP rationale.** The MVP bar is 'a real pilot merchant runs their store ON Calderyn and a buyer completes a real paid purchase.' Until a shop is promoted and cut over, every shop is a read-only mirror — no store actually lives on Calderyn, so no sale can happen. The promote+gated-cutover spine for ONE white-glove pilot is therefore the literal precondition. Only the self-serve 'one-click', dual-run reconciliation polish, and rollback automation defer to fast-follow; the gates (parity + payment-cleared) are core because they are the 'safely'.

**Risks:**
- Webhooks keep arriving during importing/dual_run; without import_map dedup by external_id the same Shopify entity gets written to both mirror and owned tables, doubling counts
- Cutover is irreversible for in-flight buyer sessions (carts/checkouts started on Shopify can't be handed to Calderyn) — needs a quiet-period or drain before the flip
- Parity gate can pass on counts but miss semantic drift (e.g. fulfillment_fact is stale — no webhook path, GraphQL backfill only), so order state may look migrated but be wrong

### #13.promote — Mirror->Owned promote/seed engine + import_map

**What it is.** The data-materialization core that reads the point-in-time mirror snapshot and writes the owned source-of-truth rows, building an import_map (external_id -> owned_id) as it goes so the two worlds reconcile and post-cutover webhooks don't duplicate. This is the cheapest part of the whole migration: catalog/variants, locations, inventory opening balances, and historical orders/refunds already exist in Supabase as Shopify mirrors keyed by GID, so promote is largely 'copy mirror row -> owned row, record the GID mapping.' It deliberately reuses the existing seed-writer primitive (writeSeedDataset, children->parents INSERT_ORDER) rather than inventing a new bulk writer. It also surfaces, per entity type, exactly what the mirror canNOT supply so #13's gates know what still needs gap-fill (e.g. SKUs have no shipping weight/dimensions; inventory is an observation not a ledger).

**Includes:**
- import_map table (shop_id, entity_type, external_id [Shopify GID], owned_id, source_version, promoted_at) — the durable mirror<->owned bridge and webhook-dedup key
- Catalog promote: sku_dim -> product_sot/variant_sot (retail_price_cents, unit_cost_cents, inventory_policy, tracked, category, vendor, tags carry 1:1; external_id preserved)
- Location promote: location_dim -> location_sot (cheap, 1:1)
- Inventory promote: latest inventory_level_fact observation -> opening on-hand in a NEW mutable inventory_ledger (the source fact is append-only onConflict sku_id,location_id,source_version, NOT decrementable)
- Order history promote: order_fact + order_line_fact -> owned order history for analytics continuity (headers only, NO customer linkage — see #13.customers)
- Refund history promote: refund_fact -> owned refund history (read-only continuity)
- Reuse of writeSeedDataset's wipe/insert + batched ordering (writer.ts:95, WIPE_ORDER/INSERT_ORDER) so promote inherits the parents->children ordering and error-surfacing
- Per-entity 'cannot-port' report fed to the #13 parity gate (missing shipping attrs, stale fulfillment, no PII)

**Depends on:** #13, Owned catalog/inventory SoT tables (product_sot/variant_sot/inventory_ledger) — net-new schema this engine writes into

**Data model / contracts.** New: import_map (the GID bridge), product_sot/variant_sot, location_sot, inventory_ledger (mutable: on_hand, reserved, with decrement/reserve ops — distinct from the append-only inventory_level_fact), owned order/refund history tables. Reads existing mirrors: sku_dim, order_fact, order_line_fact, inventory_level_fact, refund_fact, location_dim — all already shop_id+external_id keyed. Naming: keep *_sot for owned entity SoT vs the existing *_dim mirror, and *_ledger/_fact for mutable/append.

**Grounding.** Cheap-promote is real: sku_dim/order_fact/order_line_fact/inventory_level_fact/refund_fact/location_dim already mirror Shopify keyed by GID external_id + source_version. The write primitive exists: writeSeedDataset (app/lib/seed/writer.ts:95) does ordered, batched insert with explicit children->parents WIPE_ORDER/INSERT_ORDER and throws on first error. Honest gaps confirmed in source: sku_dim has NO shipping attributes (types.ts SkuRow has price/cost/category/vendor/tags/collections, no weight/dims); inventory_level_fact is an OBSERVATION not a ledger (InventoryRow: available+observed_at+source_version, types.ts:28); fulfillment_fact has no webhook path (backfill-only) so order fulfillment state can be stale.

**MVP rationale.** No owned rows = no store to sell from. The catalog/inventory/location promote is the minimum data needed for a buyer to see products and for checkout to decrement stock, so it is core. The mutable inventory_ledger (vs the append-only mirror) is specifically core because a real paid purchase must decrement real stock safely — the mirror physically cannot do that.

**Risks:**
- inventory_level_fact is a point-in-time observation that can be hours stale; seeding opening on-hand from it can oversell on day one unless reconciled against a fresh Admin pull at cutover
- Missing shipping attributes on sku_dim mean owned checkout cannot compute shipping rates from promoted data — needs a re-pull of variant weight/HS code or merchant entry before go-live
- fulfillment_fact staleness (no webhook) means promoted order history may show wrong fulfillment status, polluting post-migration analytics

### extend:write-back — Cutover the write-back path from Shopify Admin to owned SoT

**What it is.** Today every Calderyn mutation is an ASK to Shopify — setVariantPrice via productVariantsBulkUpdate (price.server.ts:110) and inventoryAdjustQuantities (inventory.server.ts:79) — and the result re-enters Calderyn via webhook into the mirror. Once a shop is live_on_calderyn, Shopify is no longer the system of record, so the same actions must instead write the owned product_sot/variant_sot price and the inventory_ledger directly, and the autopilot/brain's executeAction path must route to the owned writer based on org_mode. This is a routing/adapter change, not a new brain: the ActionAdapter and execute.server.ts pipeline stay; only the terminal writer flips. The mirror webhook path stays wired during dual_run (so Calderyn can still shadow Shopify and reconcile) and is decommissioned (or reversed — Calderyn pushing to Shopify) after cutover.

**Includes:**
- org_mode-aware write router: if live_on_calderyn -> owned writer; else -> existing Shopify Admin mutation (price.server.ts / inventory.server.ts) unchanged
- Owned price writer (writes variant_sot.retail_price_cents) mirroring setVariantPrice's input/result shape so callers don't change
- Owned inventory writer that performs a real ledger decrement/adjust against inventory_ledger (vs Shopify's inventoryAdjustQuantities)
- executeAction / ActionAdapter (execute.server.ts:178, ads/actions.ts:44) routing so pause/resume/setDailyBudget stay on the platforms but catalog/inventory actions hit the owned SoT post-cutover
- action_audit continuity: same audit rows regardless of write target, with a target field (shopify_admin | owned_sot)

**Depends on:** #13, #13.promote (variant_sot + inventory_ledger must exist to write into)

**Data model / contracts.** No new tables; extends behavior of existing write paths. Writes variant_sot.retail_price_cents and inventory_ledger.on_hand/reserved (from #13.promote). action_audit gains a write_target column. Keeps the existing AdminGraphqlClient/SetVariantPriceInput/InventoryAdjustInput shapes so the autopilot caller surface is unchanged.

**Grounding.** Today's write-back is Shopify-only: setVariantPrice (price.server.ts:110, productVariantsBulkUpdate) and inventoryAdjustQuantities (inventory.server.ts:79). These are called by the autopilot pipeline executeAction (execute.server.ts:178) via ActionAdapter (ads/actions.ts:44). Net-new is the owned writer + the org_mode branch; the calling surface and audit already exist, so this is a true extend, not a rewrite.

**MVP rationale.** 'Run their store ON Calderyn' means a price change or stock decrement must land in Calderyn's own tables, not be round-tripped through Shopify. A buyer's purchase must decrement the owned ledger or you oversell. So the inventory-decrement write path is core; the price write path can technically lag (prices change less often) but ships in the same small change.

**Risks:**
- Dual-run window with both writers live can double-apply an adjustment (Shopify webhook re-enters AND owned writer fired) — the router must be strictly org_mode-gated, not additive
- Autopilot actions queued before cutover but executed after must re-resolve their target world, or they hit the wrong system of record

---

### #16 — Agentic store generator ("describe it / connect your catalog → AI builds the store")

> *(MVP-core — added 2026-06-28 by founder decision; build **Step 7b**. The Replit-like "AI builds your store" headline. This is the GENERATOR, not the visual editor — that's `#8`, deferred.)*

**What it is.** An agentic orchestrator that composes a complete, sellable, **published** store in one pass — from a free-text brief ("describe your store") or the owned catalog ("connect your catalog"). Deterministic compose loop: pick one of `#7`'s **fixed** templates, generate grounded **store- and collection-level** copy with the existing in-app Claude harness (store name, tagline, homepage hero, collection names + groupings, hero/featured selection), bind imagery from the catalog's existing (imported) product images, then write the result into `#7`'s flat brand/store-settings contract so the `#7` SSR storefront serves it. It fills `#7`'s fixed-template slots and **never emits a block tree** (that's `#8`). Human-in-the-loop: produces a reviewable proposal the merchant approves before publish (mirrors the assistant propose-then-confirm pattern); a **deterministic fallback** always yields a publishable store if the LLM is unavailable.

**Includes:**
- `generateStore` orchestrator, two entry modes: **brief** (free-text intent) and **catalog** (reads the owned catalog `#5` and composes from what's there). Deterministic control flow in code (rule 5); Claude does only language work.
- Template selection from `#7`'s **fixed** set — deterministic heuristic + optional Claude suggestion, validated to the allowed enum (never invents a layout).
- Grounded **store/collection-level** copy via `app/lib/assistant/*` under a **locked, validated output contract** (`StorePlan`) + deterministic fallback — mirroring `claude_layer.py`'s `_assert_covers_input` (reject fabricated ids) and untrusted-evidence (prompt-injection) discipline. **No per-product copy in the thin path** (cost + it would write John's catalog tables — deferred).
- Catalog **read + grouping plan**: group products into collections, pick hero/featured, select imagery from existing `product_media.url` (hotlinked — **no `#9`**). Any write into the owned catalog goes through John's catalog-write contract — Eric never edits his tables directly.
- Review/apply/publish gate: write a reviewable `store_generation_proposal` → merchant approves → apply into `#7`'s brand/store-settings (+ collection groupings via the catalog-write seam) → publish flips the store live for `#7` SSR. **Never auto-publishes unreviewed AI copy.**
- `store_generation` run/audit record (rule 12): every skipped product, validation rejection, fallback-to-template surfaced.
- Per-run token/cost budget (rule 6). Single **imagery-source interface** (hotlink today; `#9`+Higgsfield later) and single **output-target interface** (`#7` settings today; `#8` document later) so fast-follow swaps are localized.
- Dashboard parity: brief input + proposal review + "Generate my store" CTA mirrored on the dashboard stack.

**Depends on:** `#5` (owned catalog — read; bind to its canonical `product_dim/variant_dim/product_media` names, **not** `#13.promote`'s `*_sot`), `#7` (fixed templates + its **frozen** brand/store-settings contract — the binding gate). Reuses the already-built Claude harness (`app/lib/assistant/*`, `claude_layer.py` patterns) — **no new model infra**. Soft: `#13.promote` (Step 9) materializes the real imported catalog so "connect your catalog" reaches full fidelity; "describe it" runs on `#5` alone at Step 7b.

**Data model / contracts.** PRODUCER into existing contracts + two small net-new audit tables. Writes `#7`'s per-shop brand/store-settings (store name, logo ref, palette, homepage hero, `template_id` enum); collection groupings via the catalog-write seam. Reads `product_media.url` (no `asset_dim`/`#9` in the thin path). Net-new (shop_id-scoped, migrations sequenced **after** John's commerce-core numbering): `store_generation(shop_id, run_id, source brief|catalog, brief_text, template_chosen, model, status draft|applied|published, …)` + `store_generation_proposal(run_id, plan_json)`. Locked `StorePlan` output (validators: only real owned collection/variant ids; bounded copy; deterministic template fallback).

**Grounding.** EXISTS (reused): the in-app Claude harness `app/lib/assistant/*` (`getAnthropic`, `assistantModel = claude-sonnet-4-6`, `runAssistantTurn`, system+cache-breakpoint prompt) and the engine locked-contract pattern `engine/calderyn_engine/claude_layer.py` (`_assert_covers_input`, untrusted-evidence, deterministic `_fallback`). Higgsfield generate-N-score loop exists (`screener/higgsfield.server.ts`) but is ad-specific → fast-follow imagery, not thin MVP. NET-NEW: the compose-a-store orchestration, `StorePlan` schema, the two audit tables, the review/apply/publish gate. `#5`'s catalog + `#7`'s settings tables are themselves net-new (Steps 2, 7) — `#16` binds to them.

**MVP rationale.** Founder decision — the headline activation surface: turns the owned catalog (`#5`) + fixed templates (`#7`) into a complete, sellable, published store in one pass, so a pilot merchant isn't left hand-assembling a store before any guest can buy. Marginal MVP cost is **orchestration + a locked contract + a review gate**, not new model infra (the Claude harness exists). Stays thin by reusing imported product images + store/collection copy only and writing `#7`'s flat settings — keeping the heavy editor (`#8`) and original generated imagery (`#9`/Higgsfield) **out** of the MVP. Off the payment critical path → parallels `#2`/`#3`.

**Risks:**
- **Naming/media conflict (rule 7):** `#5` = `product_dim/product_media`; `#13.promote` = `product_sot/variant_sot` and promotes **no media table** — at cutover the generated store's imagery breaks. Make `#5` canonical AND add `product_media` to `#13.promote` before coding.
- **Ownership seam:** `#16` is Eric's; in the thin path it writes ONLY `#7`'s settings directly. Collection-grouping/catalog writes go through John's catalog-write contract.
- **`#7` settings contract is the gate:** `#16` is blocked until `#7`'s `store_settings_dim` shape is frozen.
- LLM can hallucinate ids → validate every reference against real owned ids; deterministic fallback always yields a valid store (rule 12).
- Catalog text is untrusted (prompt-injection) → reuse `claude_layer`'s evidence-untrusted discipline.
- Public storefront copy → merchant-approval gate mandatory; no auto-publish.
- Scope creep toward `#8` → keep strictly to `#7`'s fixed-template slots, never emit blocks.
- Hotlinked Shopify image URLs can rotate → acceptable for pilot; the imagery-source interface makes the `#9` swap localized.

---

## Tier 2 — Fast-follow (the near-term differentiators)

### #12 — Tenant isolation hardening (Postgres RLS)

**What it is.** A defense-in-depth upgrade that moves tenant isolation from purely application-level shop_id filtering to structural Postgres Row-Level Security, so a single forgotten filter cannot leak one merchant's data to another. Today Calderyn connects with the Supabase service-role key which BYPASSES RLS, and the only tenant guard is a manual .eq('shop_id') repeated 755 times across the codebase — a posture the code itself acknowledges ('Service-role bypasses RLS, so .eq("shop_id") is the tenant guard'). The work enables RLS policies on the ~70 dim/fact/owned tables keyed on shop_id, introduces a request-scoped tenant context (a non-service-role role plus per-transaction SET app.shop_id) for the read/dashboard paths, and retains an audited service-role lane only for legitimate cross-tenant ETL and nightly training. The result is isolation enforced by the database rather than by reviewer diligence across hundreds of call-sites.

**Includes:**
- ENABLE ROW LEVEL SECURITY + shop_id policies on the ~70 *_dim / *_fact / owned tables; ensure v_* views run security_invoker or carry policies
- A request-scoped tenant context: a dedicated authenticated DB role with per-tx SET LOCAL app.shop_id (or moving reads off service-role), applied at the resolveShopId boundary (supabase.server.ts:32)
- A sanctioned, audited service-role lane for cross-tenant ETL (transformPendingWebhooks) and nightly training (api/engine) that explicitly logs its shop scoping (rule 12)
- Raw SQL migrations under supabase/migrations (Supabase Postgres is outside Prisma) for the policies and roles
- A test harness proving a wrong-tenant query returns zero rows under RLS
- Belt-and-suspenders audit of the 755 .eq('shop_id') call-sites so app-level guard stays even with RLS on
- Bind the dashboard dash_live_ bearer session shop to the same tenant context (session.server.ts)

**Depends on:** —

**Data model / contracts.** ALTER TABLE ... ENABLE ROW LEVEL SECURITY and CREATE POLICY per table: USING (shop_id = current_setting('app.shop_id')::uuid); a non-service-role DB role distinct from service_role; SET LOCAL app.shop_id per transaction. No table-shape changes. v_* views must be security_invoker or policy-covered so they don't re-open the leak.

**Grounding.** supabase.server.ts:19 creates the client with SUPABASE_SERVICE_ROLE_KEY (bypasses RLS). 755 .eq('shop_id') references across app code; calderyn.server.ts:1193 and 1217 comments confirm .eq('shop_id') is the only tenant guard. resolveShopId (supabase.server.ts:32) is the domain->UUID boundary where a tenant context would be set. No RLS exists today. Honest gap: this is a large retrofit (~70 tables + v_* views) on an architecture intentionally built around service-role, so enabling RLS is an architecture change, not a config toggle.

**MVP rationale.** Surfacing a conflict (rule 7): the orchestrator's premise that RLS 'gates real buyer/payment data' does not hold against the grounded schema — the warehouse is mirror-only, order_fact carries NO customer PII (minimizeOrderWebhook strips it; production OrderRow has zero customer fields) and stores no payment/transaction data at all, so RLS protects merchant-confidential COGS/margin/ad data, not buyer payment data. With a single pilot there is also no second tenant, so a cross-tenant leak is physically impossible for the first safe sale — making this not strictly mvp-core for that literal first transaction. It is fast-follow because it must be promoted to mvp-core the instant a SECOND real merchant is onboarded (one missed .eq then leaks another merchant's margins), and it is cheap structural insurance worth landing right after the first sale works. Promotion trigger: second real tenant, or any feature (#10 delivery PII, #11 billing identifiers) that introduces buyer/payment data into the warehouse.

**Risks:**
- Because the app connects as service-role, enabling RLS without switching the connection role does NOTHING — this is an architecture change, and a half-done migration gives false confidence (rule 12)
- ETL (transformPendingWebhooks) and the nightly engine (api/engine/run.py) are inherently cross-tenant; they need a sanctioned, audited service-role path or they break under RLS
- 70 tables plus v_* views: a single missed policy or a security_definer view silently re-opens the cross-tenant leak

### #13.customers — Consented customer re-pull (PII re-acquisition)

**What it is.** Customers are the one thing the warm-lead mirror fundamentally cannot promote, because Calderyn strips ALL customer PII at ingest by design — minimizeOrderWebhook drops name/email/phone/billing+shipping addresses before anything is stored, and the production OrderRow has zero customer fields. So the owned org starts with no customer base. This feature re-acquires customers through a consented, one-time path rather than pretending the mirror has them: either a gated bulk pull from Shopify's Customer API (requires protected-customer-data Level 2 approval Calderyn likely does not hold today) or progressive re-collection at the buyer's next login/checkout on the new storefront. Either way, passwords never transfer (Shopify never exposes hashes), so every buyer must re-authenticate, and saved addresses / store credit / loyalty balances only come over if explicitly re-pulled and re-modeled.

**Includes:**
- customer_sot table (owned, consent-stamped) — net-new, since no customer table exists anywhere today
- Path A: one-time consented bulk pull via Shopify Customer/GraphQL API gated behind protected-customer-data approval, with a clear refusal+UX if approval is absent
- Path B: progressive re-collection at next checkout/login on Calderyn (no historic PII assumed)
- Order<->customer relinking: map promoted order_fact history to re-pulled customers by external order GID via import_map where consent allows
- Explicit honest-limit copy: passwords don't transfer; buyers re-auth; loyalty/store-credit do not carry unless separately sourced

**Depends on:** #13, #13.promote

**Data model / contracts.** New: customer_sot (id, shop_id, external_id [Shopify customer GID], email, consent_source, consent_at, ...). Optional order->customer FK added to the promoted owned order history via import_map. NO reuse possible from order_fact — it has zero customer columns by design.

**Grounding.** Hard wall confirmed in source: minimizeOrderWebhook (mappers.server.ts:449, comment lines 444-448) strips name/email/phone/billing+shipping/notes/IP BEFORE storage to stay at Shopify protected-customer-data Level 1; production OrderRow (types.ts:37-57) has zero customer fields (only totals + attribution UTMs). Grep confirms NO customer table exists. So this is entirely net-new acquisition work, not a promote.

**MVP rationale.** A NEW buyer can complete a first paid purchase on Calderyn without any pre-existing customer base — checkout just creates a fresh customer_sot row at purchase (Path B). The first sale therefore does not require importing the historic customer list. Re-acquiring the existing base (and the marketing value of it) is the near-term differentiator right after the first sale works, and it's gated on PCD approval timelines, so it's fast-follow not core.

**Risks:**
- Protected-customer-data Level 2 approval may not be held; bulk pull (Path A) is then legally/technically blocked and only progressive re-collection works
- Re-collecting consent for existing buyers risks deliverability/spam-complaint blowback if framed as marketing rather than a migration notice

### #1b — Buyer accounts, login & saved profile

**What it is.** Upgrades the guest buyer (#1) into a real account: passwordless magic-link (or password) login, a buyer session primitive, saved addresses, a saved payment method (Stripe Customer + SetupIntent), and order history ('your orders'). It mirrors the design of the existing merchant dashboard session (HMAC-signed __Host- bearer with revocation + sliding TTL, session.server.ts:55) but targets a different audience — buyers, not merchants — so it is a separate session namespace and cookie.

**Includes:**
- Signup/login (magic-link first, password optional)
- Buyer session cookie, separate from the merchant dash_live_ namespace
- Saved-address reuse at checkout
- Stripe Customer linkage + saved cards (vaulted in Stripe)
- Order-history view
- Password reset + GDPR account deletion that respects the PII/warehouse split

**Depends on:** #1, #3

**Data model / contracts.** Extend buyer_dim with auth (password_hash nullable + a magic_link_token table). New buyer_session(token_hash, buyer_id, shop_id, expires_at, revoked) modeled on dashboard_sessions (20260609130000_dashboard_sessions.sql). New buyer_payment_method(buyer_id, stripe_customer_id, stripe_pm_id, brand, last4, exp). Account deletion cascades buyer PII while preserving warehouse facts (which hold none).

**Grounding.** Dashboard sessions exist as a reusable template (session.server.ts:55; dashboard_sessions migration) but are merchant-scoped — buyer sessions are net-new. Stripe Customer/saved cards require #3. No buyer account/login exists today.

**MVP rationale.** Guest checkout from #1 is sufficient for the first paid sale. Accounts and saved cards drive repeat purchase — the near-term differentiator right after the first sale works, not a prerequisite for it.

**Risks:**
- A second session system to secure and rate-limit (don't conflate with the merchant dashboard session)
- Account deletion must honor the PII boundary while leaving warehouse facts intact
- Saved-card flows must keep card data in Stripe to avoid expanding PCI scope

### #3b — Refunds-as-actions

**What it is.** Converts refunds from a mirrored read into a first-class Calderyn ACTION. Today refund_fact is a read-only mirror of Shopify refunds/create (parseRefundWebhook/minimizeRefundWebhook, mappers.server.ts:381-440). Net-new, a merchant — or the autopilot/MCP brain — issues a refund as an audited action that calls the Stripe Refund API, writes a negative transaction_ledger row, transitions the #2 order to refunded/partially-refunded, and emits refund_fact natively. It slots into the existing ActionKind / executeAction / action_audit machinery rather than inventing a new control path.

**Includes:**
- New ActionKind issue_refund (full/partial, by line or amount)
- executeAction branch that calls Stripe Refund + writes a refund transaction_ledger row
- Order state transition to refunded/partially-refunded
- Native refund_fact emission (onConflict shop_id,external_line_id) with a Calderyn-native external_line_id
- action_audit record + undo-window semantics
- Merchant refund UI on BOTH app.* (Polaris) and dashboard surfaces (parity); MCP propose_action support

**Depends on:** #3

**Data model / contracts.** Extend the ActionKind enum (migration pattern of 20260621150000_action_kind_adjust_price.sql) and add an executeAction branch (execute.server.ts:178). refund_fact written natively (external_line_id as gid://calderyn/RefundLine/<uuid> instead of gid://shopify/RefundLineItem); transaction_ledger kind='refund'. Reuses action_audit + the autonomous undo window (20260621130000_autonomous_undo_window.sql).

**Grounding.** Refunds are mirror-only today (parseRefundWebhook, mappers.server.ts:381; refund_fact upsert onConflict shop_id,external_line_id, transform.server.ts:248). Action machinery to extend already exists: executeAction with action_kind branches and action_audit (execute.server.ts:178, e.g. adjust_price/reduce_campaign_budget). Net-new: refund as an executable action calling Stripe.

**MVP rationale.** The first paid sale does not require an in-app refund button — a pilot merchant can refund directly in the Stripe dashboard initially. Making refunds an audited, autopilot-aware Calderyn action that natively writes refund_fact is the near-term differentiator right after sales work.

**Risks:**
- Refund must update Stripe + ledger + order state + refund_fact atomically — per rule 12 a partial failure must fail visibly, not silently double-refund or drift
- Double-refund / over-refund guard required
- Dashboard parity for the action button (both surfaces) is part of the task, not a follow-up

### #9 — Owned asset storage / CDN

**What it is.** An owned, public, cache-friendly asset store with CDN delivery that persists and serves storefront imagery under Calderyn's control. Its core job is to capture third-party generated imagery (Higgsfield/Meta output URLs, which are external and ephemeral) into a durable owned copy and return a stable owned URL — the persistence step that does not exist today, where higgsfield.server.ts merely passes the third-party url through. It also accepts merchant uploads (logo, brand, hero, custom images) with validation, and optionally mirrors Shopify product images into owned storage so the storefront is fully self-hosted rather than hotlinking. An asset_dim metadata table tracks each asset's owning shop, kind, source (upload/generated/mirrored), mime, dimensions, storage key, and public URL, and image transform/responsive variants serve storefront performance. It extends the existing private-bucket pattern (currently used only for internal digest PNGs) into a public, CDN-backed delivery path.

**Includes:**
- Public CDN-backed bucket + delivery path (vs the existing PRIVATE, download-gated social-digest bucket) — net-new public serving
- Persistence pipeline: fetch a third-party Higgsfield/Meta output URL -> store an owned copy -> return a stable owned URL (the missing step in higgsfield.server.ts:206-213)
- Merchant uploads with content-type allowlist, size limits, and basic moderation for a public surface
- asset_dim metadata table (owner shop_id, kind, source, mime, bytes, width/height, storage key, public URL)
- Image transform / resize / responsive variants + cache headers for storefront performance
- Optional mirror of Shopify product images into owned storage (full ownership vs hotlinking)

**Depends on:** generative:higgsfield-page-imagery (the re-prompted Higgsfield client that produces owned page imagery)

**Data model / contracts.** New asset_dim (shop_id, storage_key, public_url, kind, source upload|generated|mirrored, mime, bytes, width, height, created_at), shop_id scoped. A public Supabase Storage bucket (or @vercel/blob) extending the private-bucket pattern in app/lib/social-digest/store.server.ts:44,57. Referenced by the storefront image field (#7) and content_block props (#8).

**Grounding.** Largely net-new. The only asset storage today is a PRIVATE Supabase bucket for internal digest slide PNGs (app/lib/social-digest/store.server.ts:3,44,57) — download-gated, not public/CDN. Higgsfield outputs are third-party images:[{url}] URLs that the app extracts and passes through but never persists (app/lib/screener/higgsfield.server.ts:68-76,206-213). There is no public CDN, no @vercel/blob, and no asset table. The private-bucket helper is the only reusable precedent; public delivery, generated-imagery persistence, asset_dim, and merchant uploads are all new.

**MVP rationale.** The thin storefront (#7) can launch the first sale by hotlinking Shopify-hosted product image URLs once mirrored, so owned asset hosting is not a hard blocker to transact. It becomes the near-term necessity the moment merchants upload brand assets or the re-prompted Higgsfield client produces owned page imagery — third-party generated URLs are ephemeral and must be persisted to be durable and owned. That makes it the right-after-first-sale differentiator, not a transact blocker.

**Risks:**
- Persisting third-party (Higgsfield/Meta) generated imagery raises rights/licensing questions for owned redistribution
- A public bucket is an abuse, hotlinking, and egress-cost surface — needs auth on writes, rate limits, and signed/owned read URLs
- Higgsfield output URLs are ephemeral; capture must happen promptly or the asset is lost (a race against expiry)
- Public-facing user uploads require image moderation and a content-type/size allowlist to avoid hosting malicious or infringing content

### extend:MCP+storefront — Storefront delivery-promise display + agentic buy-in-chat quoting

**What it is.** Brings the same single quote to the two non-checkout surfaces. On the storefront (PDP/cart), a 'Get it by <date>' / service-options widget renders from the engine via an App Proxy (or storefront-callable) endpoint, using a coarse/geolocated destination so the buyer sees a promise before checkout. On the agentic buy-in-chat surface, a new MCP read tool lets the assistant quote shipping (and surface delivery date + service/pickup options) as part of completing a purchase in chat, so the chat-driven sale uses the identical engine output as checkout. Both are thin adapters over #6.3 — no re-implementation, satisfying the 'single source of truth across checkout, storefront, AND buy-in-chat' requirement.

**Includes:**
- App Proxy / storefront endpoint returning a delivery-promise + cheapest/fastest options for a PDP/cart given coarse destination (geo-IP or entered zip)
- Storefront UI hook (theme app embed / proxy-rendered) showing 'Delivered by X' and service choices — product-neutral, no provenance markers
- MCP tool quote_shipping (read/propose) added to ASSISTANT_TOOLS so the buy-in-chat agent fetches the same ShippingQuote; wired through makeToolDispatcher
- Dashboard mirror: delivery-promise + service-options panel in the dashboard's existing primitives (cd-* / CDIcon), not Polaris JSX
- Consistency guarantee: all three surfaces call quoteShipping with the same rule layer so quoted price/date match

**Depends on:** #6.3

**Data model / contracts.** Extend ASSISTANT_TOOLS in app/lib/assistant/tools.server.ts with quote_shipping (input: line items + destination; output: ShippingQuote). New App Proxy route (public, proxy-signed). Reuse dashboardJson envelope + requireSameOrigin for the dashboard panel. No new tables (reads engine).

**Grounding.** Extends existing seams. MCP read/propose tools already exist (ASSISTANT_TOOLS incl list_skus, propose_action at tools.server.ts:15-90; makeToolDispatcher:132) — quote_shipping slots in beside them. Storefront is grep-confirmed ABSENT today, so the storefront widget is net-new. Dashboard mirror is mandated by CLAUDE.md 'Dashboard parity' and the dashboard already renders ship-cost (dashboard.api.ship-cost.tsx).

**MVP rationale.** The gating first sale happens at checkout (#6.4); storefront promise and chat quoting are the near-term differentiator that makes Calderyn's shipping visible pre-checkout and powers the agentic channel — high value immediately after checkout works, but not required for the first paid purchase.

**Risks:**
- Storefront quoting uses a coarse destination (no zip yet) so the promise can differ from the exact checkout rate — must be labeled an estimate to avoid a bait-and-switch perception
- Buy-in-chat completing a real purchase has its own payment path (grep-confirmed no cart/checkout/payment today) — chat quoting is only as real as that surface; if buy-in-chat isn't transacting yet, this is display-only
- App Proxy adds a public surface needing signature verification

### #10 — Fulfillment lifecycle state machine

**What it is.** A real-time system that turns Calderyn's currently stale, read-only fulfillment mirror into a live state machine tracking each order through Shopify's fulfillment lifecycle (unfulfilled -> in_progress / partially_fulfilled -> fulfilled -> in_transit -> delivered, plus on_hold / cancelled). Today fulfillment data has no webhook path and is only refreshed by an occasional GraphQL backfill, so it goes stale, and orders enter the warehouse via minimizeOrderWebhook which captures financial_status but drops fulfillment_status entirely. This feature subscribes to Shopify fulfillment webhooks, maps each event idempotently into fulfillment_fact plus a new status/state column, and applies deterministic (code-side) transition rules with an event-ordering guard so out-of-order webhooks don't regress state. It closes the 'did the buyer actually receive their order' loop the mirror cannot answer in real time today, and feeds corrected ship/deliver timestamps into stockout_forecast, sku_velocity, and ship-cost order matching. It surfaces fulfillment status to both the embedded admin order views and the dashboard (parity).

**Includes:**
- New webhook subscriptions in shopify.app.calderynextension.toml: fulfillments/create, fulfillments/update, orders/fulfilled (consider fulfillment_events for in_transit/delivered)
- Webhook route handlers under app/routes/webhooks.* reusing the existing authenticate.webhook -> forwardWebhook -> raw_shopify_webhook -> transformPendingWebhooks -> ingestion_dlq pipeline
- A fulfillment mapper in mappers.server.ts (sibling to minimizeOrderWebhook) extracting status, tracking_no, tracking_company, tracking_url, shipped_at, delivered_at, location_id, and per-line quantities
- Deterministic state-machine transition logic in code (rule 5) with idempotent last-writer-wins keyed on external_id + source_version plus an updated_at/event-time guard so late events don't downgrade state
- A current fulfillment status surfaced on the order (new column on order_fact or a v_* view) so the autopilot/dashboard read one canonical state
- Keep the GraphQL backfill as a reconciliation/catch-up path for missed webhooks rather than the primary source
- Parity surfacing: order fulfillment status in embedded app order views AND the dashboard order screens
- Wire corrected ship/deliver timing into stockout_forecast, sku_velocity, and ship-cost order matching consumers

**Depends on:** existing ETL (forwardWebhook/transformPendingWebhooks), #12

**Data model / contracts.** Extend fulfillment_fact with status, tracking_company, tracking_url, shipped_at, delivered_at, and source_version ordering; add a canonical fulfillment status to order_fact or a v_order_fulfillment view; add the fulfillment webhook topics; idempotency key external_id + source_version reusing raw_shopify_webhook + ingestion_dlq. If delivery tracking requires destination/recipient data, that PII must NOT land in the existing PII-free order_fact (collides with #12).

**Grounding.** EXISTS: fulfillment_fact table is consumed read-only by ship-cost (inputs.server.ts:60 selects order_id; land.server.ts:138 selects order_id, tracking_no) and by views v_order_ship_features / v_sku_regional_demand (supabase/migrations 20260616120200, 20260616130500, 20260611120000 derive fulfillment_count). NET-NEW: no fulfillment writer exists in app or engine code (grep found only seed/writer.ts test seeding); no fulfillment webhook topic in shopify.app.calderynextension.toml (topics are app/uninstalled, products/update, inventory_levels/update, orders/create, refunds/create at lines 25-44); minimizeOrderWebhook (mappers.server.ts:449) captures financial_status but NOT fulfillment_status. Honest gap: the table partially exists but the entire real-time path, mapper, state column, and transition logic are net-new.

**MVP rationale.** Fulfillment is by definition POST-purchase: the buyer's paid order completes at Shopify checkout and Shopify's own inventory_levels/update webhook still decrements Calderyn's inventory observation, so the first safe sale does not require Calderyn to track fulfillment. It is the near-term differentiator right after the first sale works: it makes the autopilot's inventory/stockout decisions trustworthy and gives the merchant real post-sale visibility instead of a stale backfill, which is exactly the fast-follow tier.

**Risks:**
- order_fact deliberately strips customer PII/address; delivery-state tracking that needs a destination would force a PII-scoped store and collides with #12 and Shopify protected-customer-data review
- fulfillments/update can arrive out of order; without a source_version/event-time guard, last-writer-wins will regress state (e.g. delivered -> in_transit)
- Dual-writing from both webhook and GraphQL backfill can double-count fulfillment_count in the existing ship-feature views unless onConflict keys are aligned

### #14 — Agentic commerce surface — buy-in-chat (accurate-quote commerce core + thin protocol adapters)

> **Tier override: PROMOTED to MVP-core (2026-06-28 "both surfaces as one MVP" decision).** Built at Step 8b on the owned checkout core. Listed under Tier 2 only because the catalog was generated before the decision.

**What it is.** A new owned commerce core that lets an external AI assistant (ChatGPT/Stripe ACP, Google AP2, Shopify universal cart, or a Claude MCP client) browse a merchant's live catalog, get an ACCURATE binding quote (price + tax + real shipping rate for a given destination), and place a real paid order — with the transaction completing through Shopify so payment/PSP risk stays on Shopify rails. The commerce logic lives once (catalog projection, quote, order placement) behind the existing Calderyn MCP/OAuth seam; each agentic protocol is a thin translation adapter onto that one core, so there is no per-surface quote logic. Because chat gives 'no second chance' on a wrong quote, the quote path must call Shopify's own cart/draftOrder calculate (real delivery + tax), not estimate from the mirror. The placed order re-enters Calderyn through the existing orders/create webhook mirror, so attribution and the warehouse stay consistent. This is the feature that turns Calderyn from a read-only analytics/autopilot layer into something a buyer can actually transact through.

**Includes:**
- Catalog projection endpoint: a v_agentic_catalog view over sku_dim (retail_price_cents, availability from inventory_level_fact, inventory_policy/tracked, category/vendor/tags) shaped to the protocol's product-feed schema; respects out-of-stock/untracked
- Accurate live-quote engine: server call to Shopify cartCreate+cost/deliveryGroups or draftOrderCalculate for a destination address → returns subtotal/shipping/tax/total in cents with an expiry; NEVER estimates from the mirror (sku_dim has no shipping attributes)
- Quote persistence + idempotency: append-only commerce_quote_fact keyed by external cart GID + source_version (mirrors order_fact upsert discipline), so a re-presented quote is the same quote
- Purchase action: a place_order tool that completes the held quote via Shopify (cart checkout completion / draftOrderComplete) and returns an order confirmation; payment authorized on Shopify, not an owned PSP in v1
- New MCP commerce toolset on the existing seam: get_catalog / create_quote / get_quote / place_order added to ASSISTANT_TOOLS + dispatcher (app/lib/assistant/tools.server.ts), gated by scope so the read/propose assistant cannot accidentally transact
- Thin protocol adapters: ACP (OpenAI/Stripe), AP2 (Google), Shopify universal cart, MCP-commerce — each maps its request/response onto the one core; adapter holds zero pricing logic
- External-client auth reuse: lean on existing OAuth DCR/PKCE (mcp_oauth.server.ts) for third-party AI clients, plus a per-client commerce scope + spend/rate guardrail (deterministic, not model-decided)
- Order re-ingest + attribution tag: placed orders carry a Calderyn channel marker so order_fact/order_line_fact attribute the sale to the agentic surface (feeds #15's reward)
- Dashboard parity: a merchant-facing 'Agentic channel' surface (cd-*/CDIcon screen + dashboard.api.* route) showing connected AI clients, quotes issued, and orders — mirror the contract into the dashboard, do not port Polaris JSX

**Depends on:** Existing MCP endpoint app/routes/app.mcp.tsx + OAuth seam (mcp_oauth.server.ts, mcp_tokens.server.ts), Shopify Admin GraphQL client from authenticated session (same client setVariantPrice uses), order_fact / order_line_fact webhook mirror + resolveShopId tenant mapping (supabase.server.ts:32), guardrail_config pattern (per-action caps) extended to a per-client commerce spend cap

**Data model / contracts.** NET-NEW: commerce_quote_fact (shop_id, quote_id, external_cart_gid, line_items jsonb, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, destination_hash, source_version, expires_at) — append-only, onConflict(external_cart_gid, source_version) like order_fact; agentic_order_fact OR a channel column on order_fact (shop_id, order external_id, quote_id, protocol, client_id); view v_agentic_catalog over sku_dim+inventory_level_fact. REUSE: mcp_oauth_clients as the external AI client registry (+ a commerce scope/spend-cap column); ASSISTANT_TOOLS contract in app/lib/assistant/tools.server.ts extended with commerce tools behind a dispatcher scope. Quote/order both call Shopify Admin and re-enter via the existing raw_shopify_webhook → transformPendingWebhooks fact upsert (last-writer-wins on external_id+source_version).

**Grounding.** HONEST GAP: the prompt's 'owned checkout core' does NOT exist — cart/checkout/draftOrder/payment/transaction return zero matches in app/lib and app/routes; order_fact strips all customer PII (mappers.server.ts:449) and sku_dim carries no shipping/weight/requires_shipping attributes (sku_dim migrations + v_skus_flat_ship_pnl treat shipping only as cost analytics). So catalog-feed shaping is cheap (sku_dim is rich) but quote+payment+order placement are entirely net-new and MUST be built on Shopify's calculate/complete APIs. WHAT EXISTS to reuse is the surface, not the commerce: external MCP endpoint app/routes/app.mcp.tsx; full OAuth 2.0 DCR/PKCE/token issuance in app/lib/mcp_oauth.server.ts (registerClient:102, issueAuthCode:168); the read/propose toolset app/lib/assistant/tools.server.ts:15-113 (list_alerts…propose_action — NO commerce tool today); the mirror-then-webhook write-back discipline (price.server.ts:110 setVariantPrice; execute.server.ts:296-315 optimistic mirror + ingest reconcile).

**MVP rationale.** The MVP bar is literally 'a real buyer can complete a real, paid purchase — safely,' and this is the only feature whose output is a completed paid order through Calderyn. The 'no second chance in chat' accuracy requirement IS the safety bar, so the accurate-quote path (calling Shopify's real cart/tax/shipping calculate rather than estimating from the mirror) is non-negotiable for v1. Scope the mvp slice tightly: ONE protocol/surface + Shopify-hosted payment completion + the catalog/quote/place_order core. The multi-protocol breadth (ACP AND AP2 AND universal cart at once) and any owned PSP/managed-cart are fast-follow — needed for reach, not for the first safe sale.

**Risks:**
- Quote accuracy is existential: any path that estimates shipping/tax from the mirror (sku_dim has no shipping attrs) will mis-quote in chat with no recovery — every quote must round-trip Shopify's calculate API
- Payment/compliance surface: completing payment off Shopify (owned PSP) pulls in PCI/fraud/refund obligations — v1 must keep payment on Shopify rails or it stops being 'thin'
- Letting an external AI client transact widens the OAuth seam from read/propose to spend — needs a hard per-client deterministic spend/rate guardrail, not model judgement (rule 5)

### #15 — Agentic experimentation engine — generate→pre-screen→live bandit→auto-promote, as a real-state tournament bracket

**What it is.** A closed-loop experimentation system that generates candidate variants (ad creatives now; store-UI later), runs them through the existing vision pre-screen as a cold-start prior, then puts the survivors into a live Thompson-sampling bandit where REAL conversions (deterministic owned-checkout attribution from #14, falling back to order_line_fact + UTM today) are the reward, and auto-promotes the winner via the existing live-push path. It is visualized as a single-elimination 'multiplying' bracket on the dashboard shell that is bound to real experiment state — each match is a real arm comparison, each advance is a real posterior update, NOT a timed animation. The simulator is explicitly a pre-filter and cold-start bridge, never the decider: a sim_calibration loop continuously compares predicted sim score against realized conversion so the pre-screen earns or loses trust over time (the same calibrate-vs-reality discipline pair_calibration already applies to actions). The engine reuses Calderyn's Beta(alpha,beta) machinery, the screener's generate-and-score stack, and Higgsfield generation; the net-new work is per-arm bandit state, the reward wiring, and the live bracket UI.

**Includes:**
- Experiment + arm model: experiment_dim and experiment_arm_dim with per-arm Beta(alpha,beta) counters (mirrors pair_calibration's columns but keyed per arm, not per detector/action)
- thompsonSample() over arm posteriors to allocate live traffic/budget; reuse the sampling + graduation/confidence/guardrails math already in app/lib/calibration
- Generation stage: Higgsfield variant generation via screener generate.server.ts/higgsfield.server.ts ('generate N, keep winners' already proven in orchestrate.server.ts:executeScreen)
- Pre-screen stage: the 13-dimension vision scorecard (score.server.ts) + calibrate.server.ts composite/grade/confidence as the cold-start prior that seeds initial alpha/beta — NOT the final decision
- Reward wiring: experiment_assignment_fact (arm ↔ order/visitor external_id, append-only) joined to order_line_fact; deterministic owned-checkout attribution from #14 when present, UTM attribution (parseLandingSite) as the honest fallback today
- sim_calibration loop: persist predicted sim_score vs realized conversion per arm so the simulator is continuously calibrated against reality (prevents the pre-filter from quietly becoming the decider)
- Auto-promote: winning arm pushed live through the existing meta-push.server.ts/meta-creative.server.ts path, written through action_audit for undo/legibility like every other Calderyn action
- Live bracket UI: a new dashboard screen (SCREENS registry in DashboardApp.tsx, or extend ScreenLabs/ScreenGenerator) using cd-*/CDIcon, fed by a v_experiment_bracket view + the dashboard.api.realtime-token live feed — state-driven, explicitly NOT the setTimeout staged animation used in app.screener.tsx
- Store-UI arm (later): a second surface type once a Shopify theme/section write-back seam exists — today only setVariantPrice + inventoryAdjustQuantities can write back, so store-UI variants have no live channel yet

**Depends on:** #14 (deterministic owned-checkout attribution as the clean reward signal; without it the bandit runs on weaker UTM/order_line attribution), pair_calibration Beta machinery + app/lib/calibration graduation/confidence/guardrails, Screener generate/score/calibrate stack (orchestrate.server.ts, score.server.ts, generate.server.ts, runs.server.ts), meta-push.server.ts / action-registry.server.ts for live-promote; Higgsfield (only wired generative engine), Dashboard shell (DashboardApp.tsx SCREENS registry, cd-*/CDIcon, dashboard.api.realtime-token) for the bracket, A Shopify theme/storefront write-back seam (does not exist today) to enable the store-UI surface

**Data model / contracts.** NET-NEW: experiment_dim (shop_id, experiment_id, surface 'ad'|'store_ui', objective, status, winner_arm_id, created_at); experiment_arm_dim (shop_id, experiment_id, arm_id, variant_ref e.g. higgsfield asset id or theme section, alpha numeric, beta numeric, impressions, conversions, spend_cents, sim_score) — alpha/beta columns intentionally mirror pair_calibration; experiment_assignment_fact (shop_id, arm_id, order/visitor external_id, source_version) append-only like inventory_level_fact; experiment_event_fact OR reuse order_line_fact via join for reward; sim_calibration (shop_id, predicted sim_score, realized conv_rate) following pair_calibration's calibrate-vs-reality pattern; view v_experiment_bracket for the UI. REUSE: thompsonSample over experiment_arm_dim posteriors; promotion writes through action_audit (action_kind 'promote_variant') so it inherits idempotency/undo from execute.server.ts.

**Grounding.** REAL reuse: pair_calibration IS Beta(alpha,beta) Thompson sampling (supabase/migrations/20260620160000_pair_calibration.sql:5-21) — but keyed (shop_id, detector_id, action_kind) for ACTION trust, so a per-ARM table is net-new (the math/pattern is reused, not the table). The generate→score pre-filter genuinely exists end-to-end: orchestrate.server.ts:executeScreen (startRun→scoreCreative→calibrate→completeRun), the 13-dim vision scorecard (score.server.ts), and Higgsfield variant generation (generate.server.ts/higgsfield.server.ts). Live-promote exists for ads (meta-push.server.ts, meta-creative.server.ts). HONEST GAPS: (1) the clean reward (owned-checkout attribution) depends on #14 — today only UTM/order_line attribution exists (orchestrate resolveSkuFromUrl via parseLandingSite). (2) Store-UI experimentation is a much larger lift than ads: the only Shopify write-backs that exist are setVariantPrice (price.server.ts:110) and inventoryAdjustQuantities (inventory.server.ts:79) — there is NO theme/section/storefront write-back seam, so store-UI arms cannot go live yet. (3) The bracket must bind to real arm state; app.screener.tsx already uses setTimeout staged copy 'while the real score request is in flight' (~line 413/692) — that animation pattern is exactly what the bracket must NOT be.

**MVP rationale.** Not needed for the first safe paid sale — the MVP transacts via #14; experimentation optimizes what is sold, it does not enable the sale. It is the near-term differentiator the moment the first sale works, because the live bandit needs a real conversion reward to exist (which #14 provides), making it naturally the next slice. Within the feature, the AD surface is the fast-follow slice (generation + pre-screen + meta-push all exist); the STORE-UI surface and the multiplying-bracket polish are 'later' because they require a net-new Shopify theme write-back seam and real-state UI plumbing.

**Risks:**
- Simulator drift: if the pre-screen score is allowed to gate promotion instead of merely seeding the prior, it silently becomes the decider — the sim_calibration loop must be live and the bandit must be able to overrule a high sim score with real conversions
- Reward sparsity/attribution: low-volume pilot stores produce few conversions, so arm posteriors stay wide — needs a minimum-exposure graduation guard (reuse confidence.ts) before auto-promote, and clean per-arm attribution (UTM is leaky)
- Bracket UI faking liveness: the temptation to animate advancement with timers (as app.screener does) would violate the explicit 'bound to REAL experiment state' requirement — must be driven by the realtime feed over v_experiment_bracket
- Store-UI surface has no live channel today (no theme write-back), so promising both surfaces in the mvp slice would over-scope

### #5-shipping-advanced — Shipping-as-product-data: advanced/regulated attributes (hazmat, temperature, freight, packaging, customs)

**What it is.** The second tier of owned shipping attributes covering carrier eligibility and regulated/oversized goods, layered onto variant_shipping after the rate-critical core. These govern WHICH carriers/services a variant is even eligible for and what compliance a shipment must carry: hazmat (boolean + class/UN number for restricted/dangerous goods), temperature class (ambient/chilled/frozen cold-chain), freight eligibility (parcel vs LTL/freight for oversize/overweight), packaging rules (package type, units-per-package, fragile/non-stackable), and customs data (HS code, declared value/currency) for cross-border. None of these exist today (grep-confirmed absent). They are required+validated only for variants that declare the relevant flag — hazmat=true forces a hazmat_class; freight=true relaxes parcel weight ceilings — so the validation is conditional rather than universal. The quote engine (#6) uses them to filter eligible carrier services and attach compliance, but a generic first physical sale does not need them, which is why they are tiered behind the rate-critical core.

**Includes:**
- Hazmat: hazmat boolean + hazmat_class/UN number; conditional validation (true ⇒ class required), gates carrier eligibility
- Temperature class: ambient/chilled/frozen — cold-chain constraint on service selection
- Freight eligibility: parcel vs freight/LTL flag with oversize/overweight thresholds that relax the parcel weight ceiling
- Packaging rules: package_type, units_per_package, fragile, non-stackable
- Customs: hs_code, declared_value_cents + currency for cross-border quotes/labels
- Conditional write-time validation: each advanced field required only when its governing flag is set; otherwise omitted

**Depends on:** #5-shipping

**Data model / contracts.** Extend variant_shipping: hazmat bool default false, hazmat_class text (CHECK required when hazmat), temperature_class text CHECK(ambient|chilled|frozen), freight_eligible bool default false, freight_class text, package_type text, units_per_package int, fragile bool, hs_code text, declared_value_cents int, declared_value_currency text. Consumed by #6 as carrier-eligibility + compliance inputs. Conditional CHECK constraints + action-boundary validation.

**Grounding.** Net-new; entirely absent today (grep over supabase/migrations + tests/engine/schema returns no hazmat/temperature/freight/packaging/HS columns or tables). Builds strictly on variant_shipping introduced by #5-shipping; no current code path touches carrier eligibility.

**MVP rationale.** The first real paid sale of a generic physical product transacts safely on the rate-critical core (weight/dims/origin/destination); hazmat, cold-chain, freight, packaging, and customs are vertical/regulatory differentiators needed soon after for specific merchants and cross-border, but not to make the first sale happen safely.

**Risks:**
- Regulated-goods compliance (hazmat/customs) carries legal exposure — incorrect classification on a label is a liability, so this should ship validated, not best-effort.
- Conditional validation logic is easy to get wrong (flag set but field empty must fail loudly per rule 12).

### extend:Higgsfield — Re-prompt the image client for storefront/page aesthetics

**What it is.** The Higgsfield client is already generic and ad-agnostic at the HTTP layer: higgsfieldImageClient takes {prompt, referenceImageUrl, count}, submits POST /{model}, polls /requests/{id}/status to a terminal state, and returns image URLs — nothing in it is advertising-specific (higgsfield.server.ts:85-166). All the ad-specificity lives in two narrow places: buildImagePrompt, whose copy literally says 'Generate an improved advertising image... Match the look of the merchant's winning ads' and is driven by the ad scorecard's weak dimensions (higgsfield.server.ts:169-186), and the imageGenerator wrapper, which swaps the output into an AD creative and judges it with the SAME ad-creative re-score vision gate (higgsfield.server.ts:193-219). The pivot keeps higgsfieldImageClient verbatim and adds a new prompt builder (buildStorefrontImagePrompt) plus a new generator mode that targets PAGE aesthetics — hero banners, PDP/product-page shots, collection tiles, brand palette/layout context — and writes the result into an owned storefront/page image slot rather than an ad creative. The ad-performance vision gate is ad-specific, so it is dropped or replaced with a lightweight brand/quality check; the model (DEFAULT_MODEL soul/standard, higgsfield.server.ts:30) and aspect ratios may shift toward product-photo defaults (16:9 hero, 4:5 PDP).

**Includes:**
- buildStorefrontImagePrompt targeting page/PDP aesthetics (brand palette, on-white or lifestyle product shots, layout context) instead of ad weak-dimensions (replaces buildImagePrompt's ad copy at higgsfield.server.ts:169)
- New storefront/page generator mode that attaches output to an owned page-image slot, not a CreativeCandidate (replaces imageGenerator at higgsfield.server.ts:193)
- Drop/replace the ad-creative re-score vision gate with a brand/quality acceptance check appropriate to page imagery
- Aspect-ratio + model presets for page contexts (hero 16:9, PDP 4:5) reusing higgsfieldImageClient's opts (higgsfield.server.ts:91-99)
- Reuse higgsfieldImageClient and HIGGSFIELD_API_KEY/SECRET unchanged (higgsfield.server.ts:85,105)

**Depends on:** extend:TenantIdentity

**Data model / contracts.** higgsfieldImageClient + its env contract reused AS-IS (no change). Net-new: a buildStorefrontImagePrompt builder and a page-image generator; an owned page/storefront media slot table (page_image / asset) keyed by shop_id to hold the produced URLs. Soft contract on the owned catalog for the product the image depicts.

**Grounding.** EXISTS: the entire Higgsfield HTTP client — submit/poll/extract, DI-injectable fetch, parallel-with-allSettled, the only wired generative engine (higgsfield.server.ts:85-166). NET-NEW: the storefront prompt builder, the page-output generator mode, the brand/quality acceptance check (replacing the ad vision gate), and an owned page-image asset slot to write into. Honest gap: the client is reusable verbatim, but the output today is a CreativeCandidate fed back through the ad scorecard (higgsfield.server.ts:198-218) — there is no storefront/page surface to attach a page image to yet, so this depends on a net-new storefront/page builder existing.

**MVP rationale.** A pilot merchant can bring their own product photos to stand up a storefront and take a real paid order, so generated page imagery is not required for the first safe sale. It is the near-term differentiator that accelerates store setup and elevates the storefront right after transacting works — a fast-follow wow, not a transact-blocker.

**Risks:**
- There is no storefront/page surface to attach output to yet, so this is blocked on the net-new store-builder; shipping the prompt change alone produces orphan URLs
- The ad re-score gate was the quality guarantee (generation never trusted blindly, higgsfield.server.ts:4-5); replacing it with a weaker page check risks shipping low-quality storefront imagery unless a real acceptance check is built
- soul/standard is tuned for creative/portrait generation; product/page fidelity may need a different model, so the DEFAULT_MODEL assumption should be re-validated

### extend:fulfillment-ingest+brain — Fulfillment webhook ingest + shipping-performance tracking & carrier scorecard (brain/detector signal)

**What it is.** Closes the loop: tracks whether the promised delivery actually happened and turns carrier performance into a brain signal. Today fulfillment_fact has carrier/shipped_at/delivered_at but NO webhook path (GraphQL backfill only, goes stale). This slice adds real fulfillments/create + fulfillments/update webhook ingestion, records promised-vs-actual per shipment, and rolls it up into a per-carrier/per-lane scorecard (on-time %, transit-time distribution, tracking-scan quality, fulfillment/handling speed, delivery consistency/variance). That scorecard becomes a detector signal (alerts on carrier degradation, breached promises) and a feature for the autopilot action model so the brain can recommend carrier selection or tighten/loosen the promise — mirroring how campaign_grade_fact + the ActionAdapter already drive ad decisions.

**Includes:**
- fulfillments/create + fulfillments/update webhook handlers through the existing authenticate.webhook -> forwardWebhook -> raw_shopify_webhook -> transformPendingWebhooks pipeline (idempotent external_id+source_version)
- delivery_promise_fact: promised window (from the quote at order time) vs actual shipped_at/delivered_at, breach flag, transit days, tracking-scan completeness
- carrier_scorecard_fact / v_carrier_performance: per (shop, carrier, service, lane zip3->zip3) on-time %, p50/p90 transit, consistency variance, scan-quality — modeled on campaign_grade_fact
- Detector/alerts: carrier on-time below threshold, promise-breach spike, fulfillment-speed regression -> alerts (reuse alerts pipeline)
- Autopilot action: new ActionKind (select_carrier / adjust_delivery_promise) registered in action-registry.server.ts, executed via the executeAction/ActionAdapter seam with guardrails/undo
- Nightly performance training: extend the autopilot_train.py / moat model pattern to learn carrier-lane transit so the scorecard feeds back into promises

**Depends on:** #6.3, #6.1

**Data model / contracts.** New delivery_promise_fact (shop_id, order_id FK order_fact, carrier, promised_earliest/latest, shipped_at, delivered_at, breached bool, transit_days). New carrier_scorecard_fact + v_carrier_performance view (security_invoker, _fact/v_ conventions). Extend fulfillment ingest (mappers + transformPendingWebhooks). New ActionKind enum value via supabase/migrations action_kind_* pattern (e.g. 20260620190000_action_kind_*). Store the promised window at order time so breach is computable.

**Grounding.** Extends/repairs an existing gap. fulfillment_fact (orders_and_fulfillments.sql) has carrier/shipped_at/delivered_at/status but the grounding facts confirm NO webhook path (GraphQL backfill only, can go stale) — needs a real fulfillments/* handler in the documented webhook pipeline. The brain seam to mirror is concrete: campaign_grade_fact + action-registry.server.ts + ads/actions.ts:44 ActionAdapter + autopilot_train.py nightly mu training. Alerts pipeline already exists (alerts_* migrations).

**MVP rationale.** Performance tracking needs accumulated post-sale fulfillment history, so it cannot exist before the first sales flow. It is the near-term differentiator (turning shipping into a brain signal like ads) right after transacting works — valuable immediately but not on the critical path to the first paid purchase.

**Risks:**
- fulfillment_fact going stale today means promised-vs-actual will be incomplete until the webhook path is added — must fail visibly (rule 12), not silently mark deliveries on-time
- Promise breach requires storing the quote's promised window at order time; if not captured at #6.3/#6.4 time it is unrecoverable retroactively — sequencing dependency
- Adding a carrier-selection autopilot action touches money/fulfillment, so it needs the same guardrail/graduation/undo rigor as ad actions before any autonomy

### #17 — Viral product sourcing (discovery → pick → auto-store)

> *(Fast-follow — added 2026-07-05 by founder decision. The dropshipper **cold-start** funnel: a merchant with NO catalog gets a ranked feed of viral products, picks one, and Calderyn wires the supplier + auto-builds the store on `#16`. Sits UPSTREAM of the whole owned-commerce stack — it fills the empty catalog the rest of the spec assumes already exists. Owner: Eric.)*

**What it is.** A merchant-side product-discovery funnel for the cold-start case the rest of the spec never addresses — an operator with no products and no idea what to sell. A nightly, low-API signal-ingest job pulls a small set of cheap external virality signals into a global `source_product_signal` table; a deterministic scorer (no model in the ranking loop, rule 5) computes a `virality_score` per candidate; and a new **Discover** dashboard screen renders the ranked feed. The merchant picks a product and Calderyn materializes it into the owned catalog through the existing write-path (`app/lib/catalog/catalog.server.ts:createProduct:338`, hotlinking supplier imagery via `product_media.external_url` — migration `20260703141000_product_media_external_url.sql`), records a shop-scoped `sourced_product_link` back to the global source + supplier, and invokes the already-built agentic store generator (`app/lib/storegen/generate.server.ts:generateStore:40`) to produce a previewable draft store. "Choose a viral product → have a store selling it" is therefore ~80% reuse: the only net-new runtime is the signal ingest + scorer + the Discover screen + the supplier connector's read side. The supplier/manufacturer link is a new provider-blind `SupplierAdapter` (Zendrop / CJ / AliExpress impls) mirroring the repo's existing provider-blind adapter families (`app/lib/ship-cost/adapters/adapter.ts`, `app/lib/ads/adapter.ts`); its live order-routing half is `#17.fulfillment`.

**Includes:**
- Nightly low-API signal ingest over a global `source_product` candidate catalog, modeled on the existing import drain + `import_run` state machine (`app/routes/cron.import.tsx:12`, `app/lib/import/run.server.ts:drainImports:68`) — batched, cached, rate-limited, DLQ-backed; NEVER a per-request scrape
- Deterministic `virality_score` scorer (velocity + momentum − saturation/decay − margin/lead-time penalties), no LLM in the ranking loop (rule 5); mirrors the Python detector-brain pattern (`engine/calderyn_engine/`), not a model call
- Sparse, budgeted (rule 6) LLM use ONLY to label/categorize/name a candidate, reusing the locked-contract harness (`app/lib/assistant/*`, `app/lib/catalog/listing-prompt.ts`) with the same `_assert_covers_input` / untrusted-evidence discipline as `claude_layer.py`
- `SupplierAdapter` read side: provider-blind `getTrending()` / `getProduct()` over Zendrop/CJ/AliExpress; the dropship provider's own order-volume / "hot products" feed is a near-free primary signal (already authenticated for `#17.fulfillment`)
- Discover dashboard screen: **surfaced under the Store Builder nav group as its cold-start front door** — a merchant with no catalog starts here (pick → auto-write catalog → auto-generate the store), so it feeds `#16` rather than sitting as a standalone top-level tab; it also backs the Store Builder's empty/no-catalog state. A ranked feed showing virality + unit cost + margin + lead time + supplier reliability side by side (rule 7 — surface the tradeoff, don't average it into one number), registered in the 4-place screen pattern (`context.ts` `Screen` union, `routes.ts` seg/parsePath, `DashboardApp.tsx` `SCREENS`/`NAV`, screen-cache), modeled on the async job-polling `ImportShopify.tsx`
- Pick → catalog: reuse the AI product-draft write path (`NewProductFlow.tsx` + `/dashboard/api/listing-draft`) so a sourced product flows through the same validated `createProduct` boundary; write a shop-scoped `sourced_product_link`
- Pick → store: invoke `generateStore()` (`#16`, already built) to produce a draft store for the chosen product, previewable pre-cutover

**Ranking model — externals-first, own-data on a hard gate (the "accurate over time" contract).** Phase 1 (now → <2,000 users): `virality_score` is computed from external signals ONLY (Google Trends momentum + the dropship provider's own order-volume/"hot" feed + 1–2 cheap best-seller ranks). Phase 2 (≥2,000 platform users — the founder-set proxy for "enough real Calderyn sales"): Calderyn's own `sku_velocity` / conversion / ROAS become the ground-truth reward that re-weights the score — the compounding moat a blind-scraping competitor can't match. The switchover is a concrete, deterministic promotion trigger (`user_count >= 2000`), documented exactly like `#12`/RLS's "promote on second tenant" gate — a threshold in code, not a model judgment (rule 5). A saturation/decay term is always-on in both phases so a product that has peaked stops being surfaced.

**Depends on:** `#5` ✓ (owned catalog — write, via John's catalog-write contract), `#16` ✓ (store generator) — both already exist in `app/lib/storegen/*` + `app/lib/catalog/*`. Soft: `#10` for the live-fulfillment half (`#17.fulfillment`).

**Data model / contracts.** A deliberate carve-out from the shop-scoped/RLS convention: the *research catalog is platform-global reference data* (the same viral product is offered to every merchant), so NEW global tables written only by the ingest cron and read-only to merchants — `source_product(id, provider, external_id, title, category, image_urls[], unit_cost_cents, moq, lead_time_days, supplier_id, first_seen_at, last_seen_at)`, `source_product_signal(source_product_id, signal_kind, value, captured_at)`, `source_product_score(source_product_id, virality_score, phase, decay, computed_at)`, `supplier(id, provider, external_supplier_id, name, reliability_score, …)`. The tenant-specific data stays shop-scoped: NEW `sourced_product_link(shop_id, product_id→product_dim, source_product_id→source_product, supplier_id→supplier, picked_at)` — the join the storefront and `#17.fulfillment` resolve through. NO new catalog tables — a pick reuses `product_dim`/`variant_dim`/`product_media.external_url` via `createProduct` and `store_generation` (`#16`). Migrations sequenced after John's commerce-core numbering (work-split convention #5).

**Grounding.** Mostly reuse; one net-new domain. EXISTS: the store generator (`storegen/generate.server.ts:40`), the catalog write-path (`catalog/catalog.server.ts:createProduct:338`, `setVariantPrice:470`), hotlink imagery (`product_media.external_url`, `20260703141000`), the AI product-draft flow (`NewProductFlow.tsx` + `/dashboard/api/listing-draft`), the job-polling ingest template (`cron.import.tsx` + `import_run` + `drainImports`), the deterministic detector-brain + nightly-train pattern (`engine/calderyn_engine/`, `autopilot_train.py`), the provider-blind adapter families (`ship-cost/adapters/adapter.ts`, `ads/adapter.ts`), and the 4-place dashboard-screen registration. NET-NEW (grep-confirmed absent — the ONLY supplier hits are `PurchaseOrders.tsx:10` "supplier/ETA/status fields don't exist" and `po/pdf.server.ts:105`'s blank supplier block): the entire sourcing/supplier domain — the global reference tables, the virality scorer, the Discover screen, the `SupplierAdapter`. Honest gap: the global reference tables break the warehouse's shop_id-everywhere + RLS convention; they must be platform-written and merchant-read-only, with every merchant-specific fact (which products a shop picked, its margins) confined to the shop-scoped `sourced_product_link` — a missed boundary here leaks one merchant's product strategy to another.

**Tier rationale (fast-follow, not MVP-core).** The MVP is "the first safe paid sale for a pilot merchant who already has a catalog" (Shopify import or manual entry). Viral sourcing is a *cold-start acquisition funnel* for merchants with NO catalog — high growth value, but it doesn't gate the first sale, so it is fast-follow. Its hard deps (`#5`, `#16`) already exist, so the discovery half can begin early in the fast-follow window; the live-fulfillment half (`#17.fulfillment`) rides `#10`, so both are formally slotted at Step 11.

**Risks:**
- External signal sources are fragile and ToS/rate-limit-sensitive — favor official low-API feeds (the dropship provider's own order-volume, Google Trends) over scraping, cache aggressively, and degrade to last-known-good visibly (rule 12); never silently serve a stale or empty feed as "current."
- Global reference tables depart from the RLS-everywhere convention — platform-written + merchant-read-only is mandatory, and all tenant-specific data (picks, margins, supplier terms) must live only in the shop-scoped link table, or a merchant's product strategy leaks cross-tenant.
- "Viral" decays fast — without an always-on saturation/decay term the feed keeps pushing dead trends; decay is part of the score, not a later add.
- A viral product with thin margin or a slow/unreliable supplier is a trap — the feed must show unit cost, margin, lead time, and supplier reliability beside the virality number, not fold them into one score (rule 7).
- The 2,000-user posterior flip needs real sales volume to be meaningful — it is a hard gate, not a gradual blend; before it, the feed is honestly "external-signal only" and must be labeled as such, not oversold as Calderyn-proven.

### #17.fulfillment — Live dropship order-routing + tracking sync (SupplierAdapter write side)

> *(Fast-follow — added 2026-07-05. The live-supplier half of `#17`: a buyer buys a sourced product → Calderyn auto-places the order with the manufacturer and syncs tracking back. Rides the fulfillment lifecycle `#10`. Owner: Eric.)*

**What it is.** The write half of the `SupplierAdapter`: when a guest buyer completes a paid purchase (`#2`/`#3`) of a product carrying a `sourced_product_link`, Calderyn automatically places the corresponding order with the supplier (Zendrop/CJ/AliExpress) via `SupplierAdapter.placeOrder()`, records the supplier order id, and receives/polls supplier tracking to drive the order through `#10`'s fulfillment state machine. It reuses the store-action executor's idempotency+audit tail (`app/lib/actions/execute.server.ts:priorExecutionForKey:48`, `insertAuditWithIdempotency:119`) so a webhook retry or double-submit never double-orders, reconciles against the `#3` Stripe capture (never route an unpaid order), and fails visibly into `#10` (a supplier-order failure surfaces as an alert + a stuck fulfillment state, never a silently dropped order — rule 12).

**Includes:**
- `SupplierAdapter` write side: provider-blind `placeOrder(supplierOrder)` / `getTracking(supplierOrderId)` / `cancelOrder()`, normalized across providers like `NormalizedShipmentCost`
- A new store `ExecutableKind` (`place_supplier_order`) registered beside the existing kinds (`action-registry.server.ts`), routed through the `executeAction` idempotency+audit tail so it is exactly-once and auditable
- Trigger on the owned `CHECKOUT_COMPLETED` / paid-order event (`extend:IngestETL`) filtered to lines carrying a `sourced_product_link`; reconcile against `#3` capture before routing
- Supplier tracking → `#10`: map supplier fulfillment/tracking updates onto `#10`'s fulfillment state machine + `fulfillment_fact`, feeding `extend:fulfillment-ingest+brain`'s promised-vs-actual scorecard
- `supplier_order(shop_id, order_id→order, source_product_id, supplier_id, supplier_order_ref, state, idempotency_key, placed_at)` — the durable order↔supplier bridge and dedup key
- Merchant visibility: supplier-order state + tracking surfaced in the dashboard order view; failures raise an alert (reuse the alerts pipeline)

**Depends on:** `#17`, `#10`, `#2`, `#3`, `extend:IngestETL`, `extend:ActionAdapter` (reuses its executor tail).

**Data model / contracts.** NEW `supplier_order` (shop-scoped, `unique(shop_id, idempotency_key)` — the exactly-once guard). Reuse `action_audit` + `action_idempotency` AS-IS (`action_kind` is a free string). New `place_supplier_order` `ExecutableKind` via the `action_kind_*` migration pattern. Consumes `#10`'s fulfillment state contract for the tracking→state mapping. Money-critical invariant: no supplier order is placed until the `#3` charge is captured, and every placement is idempotent on the order id.

**Grounding.** Net-new, but on proven seams. EXISTS: the idempotency+audit executor tail (`execute.server.ts:48,119`) and adapter/registry pattern (`action-registry.server.ts`), the owned paid-order event (`#2` + `extend:IngestETL`), the `#10` fulfillment state machine + `fulfillment_fact`, and the alerts pipeline. NET-NEW: the `SupplierAdapter` write impls, the `supplier_order` table, the `place_supplier_order` kind, and the tracking→`#10` mapping. Honest gap: live order-routing introduces an *external money+fulfillment side-effect* the executor has never had (today's kinds write internal tables or ad platforms); the reconcile-against-capture + idempotency + visible-failure rigor is load-bearing, not optional.

**Tier rationale (fast-follow, Step 11).** Depends on `#10` (fulfillment lifecycle, Step 11) and the owned checkout (`#2`/`#3`), so it cannot precede them; it joins the Step 11 fast-follow wave alongside `#10` + `extend:fulfillment-ingest+brain`.

**Risks:**
- Money+fulfillment side-effect on an external API — a non-idempotent placement double-orders on webhook retry; the `unique(shop_id, idempotency_key)` guard + reconcile-against-`#3`-capture are mandatory, not hardening.
- Supplier APIs are slow/flaky — routing must be async (queue/retry), never inline in the buyer's checkout response, and a routing failure must surface (alert + stuck state), never silently drop the buyer's paid order (rule 12).
- Price/stock drift at the supplier between sourcing and sale — the supplier can be out of stock or repriced at order time; define the policy (hold / cancel / refund via `#3b`) rather than silently eating margin or overselling.

---

## Tier 3 — Later (valuable, not needed to transact)

### #11 — Billing / subscription system (charge merchants)

**What it is.** A Shopify-native billing system so Calderyn can actually charge merchants, which is entirely absent today. It would use Shopify's Billing API (appSubscriptionCreate via the authenticated Admin GraphQL session, or Managed Pricing config) so charges land on the merchant's Shopify invoice exactly as the Terms already promise ('fees presented through the Shopify billing system'). It includes plan/price definitions, a subscribe/upgrade flow with the confirmationUrl redirect, an app_subscription state table, an app_subscriptions/update webhook handler, and feature-gating of premium autopilot capability behind active subscription state. Because a pilot can run free or be manually invoiced, this is about commercialization and self-serve scale, not about enabling the first transaction. It must mirror to the dashboard's own plan/billing screen (parity).

**Includes:**
- Shopify Billing API integration: appSubscriptionCreate mutation + confirmationUrl redirect, OR Managed Pricing configured in the Partner Dashboard
- app_subscriptions/update webhook subscription + idempotent handler through the existing webhook pipeline
- A new subscription-state table (plan, status, current_period_end, trial, test flag) keyed by shop_id
- Plan and pricing registry defined deterministically in code (rule 5), not in the model
- New billing route app/routes/app.billing.tsx (none exists) and a parity plan/billing screen on the dashboard
- Subscription-state gate read before premium autopilot actions, with a free-pilot / comp bypass flag
- No new OAuth scope (Billing API uses the session); update distribution/config as needed

**Depends on:** #12

**Data model / contracts.** New app_subscription table: shop_id, shopify_subscription_gid, plan, status, current_period_end, trial_ends_at, is_test; app_subscriptions/update webhook topic; an in-code plan registry. Mirror subscription state into the dashboard's own postgres/withShopContext stack (match contract, not code).

**Grounding.** Grep-confirmed ABSENT: no appSubscription, recurringApplicationCharge, recurring/managed_pricing anywhere; shopify.app.calderynextension.toml has no billing config. terms.tsx:101-103 already legally routes fees through 'the Shopify billing system' (intent present, implementation absent). IMPORTANT not to conflate: the billing_read references in calderyn.server.ts (~389,422) and app.settings.tsx are ShipBob carrier-invoice cost-analytics scope, NOT Shopify app billing. Honest gap: everything here is net-new.

**MVP rationale.** The MVP is a buyer completing a paid purchase, and the buyer pays the MERCHANT through Shopify checkout, not Calderyn — charging the merchant is orthogonal to the first sale. The prompt explicitly notes a pilot can defer billing via free pilots or manual invoicing, so billing blocks neither the first safe sale nor the immediate next-step differentiator. It becomes necessary only for paid self-serve and a public App Store listing (which requires Managed Pricing), both of which are post-pilot.

**Risks:**
- A future public App Store listing requires Managed Pricing / Billing API compliance; pilot comp-bypass design must not paint the team into a corner there
- Billing API test charges must be hard-gated by dev-store/test flag so a real merchant is never charged during pilot
- Feature-gating on subscription state can silently disable autopilot if webhook lag leaves status stale — needs a grace/fallback (rule 12: fail visibly)

### #13.aesthetics-seo — AI theme approximation + SEO/attribution equity bridge

**What it is.** The two equity classes a replatform destroys: store look-and-feel and search/attribution standing. Calderyn has no theme scope and Liquid is not portable, so the storefront cannot be copied — the best achievable is an AI-regenerated approximation built from the live storefront's rendered DOM/screenshots into Calderyn's own storefront stack, which the merchant must review and edit; pixel-parity is explicitly not promised. On SEO, a replatform changes URL structure (Shopify /products/handle -> Calderyn URLs), so rankings drop unless the cutover ships a 301 redirect map + canonical + regenerated sitemap, and even then a transient ranking dip is expected; backlink/domain authority only survives if the SAME domain is carried to Calderyn at cutover. Live attribution (pixels/CAPI) must be re-instrumented on the new domain — past-order attribution (landing_site/referring_site/utm on order_fact) is retained for analytics continuity, but it does not transfer live conversion tracking.

**Includes:**
- Storefront capture (rendered DOM + screenshots of key templates) and AI regeneration into Calderyn's storefront primitives — net-new tooling; Higgsfield (the only wired generative engine) does ad IMAGES, not theme/Liquid, so this cannot reuse it
- Merchant review/edit loop on the approximated theme with an explicit 'approximation, not a copy' disclosure
- redirect_map table + emitted 301s from old Shopify URLs -> Calderyn URLs at cutover, plus canonical + regenerated sitemap.xml
- Same-domain carry path (DNS) to preserve backlink/domain authority where the merchant controls the apex
- Re-instrumentation checklist for pixels/CAPI on the new storefront; retention note that order_fact.landing_site/referring_site/utm_* keep PAST-order attribution only

**Depends on:** #13

**Data model / contracts.** New: redirect_map (shop_id, old_path, new_path, status=301), theme_draft/theme_asset for the regenerated approximation. Reuses existing attribution columns on order_fact (landing_site, referring_site, utm_source/medium/campaign/content/term — types.ts:50-56) for historical continuity only; no new attribution capture here.

**Grounding.** No theme scope exists (the app requests admin/ads/inventory scopes, not themes) and Liquid is not portable, so regeneration is the only option — and it is net-new because Higgsfield, the ONLY wired generative engine (app.generator.tsx / screener/higgsfield.server.ts), produces ad images, not theme code. Attribution columns DO exist on the order mirror (types.ts:50-56) and are retained, which is why dashboard/analytics stats survive even though SEO equity does not.

**MVP rationale.** A pilot merchant can transact on a plain, functional Calderyn storefront and eat a temporary SEO/aesthetic hit; neither blocks a real paid purchase. Theme regeneration is high-effort net-new generative tooling and SEO equity is a longer-horizon concern, so both are 'valuable but not needed to transact' — later. (Basic 301 redirects at cutover are cheap enough to pull forward into #13 if the pilot keeps its domain.)

**Risks:**
- AI theme approximation will visibly differ from the original; over-promising parity erodes merchant trust at the highest-stakes moment (go-live)
- Missing/incomplete 301 map causes a hard, sometimes weeks-long, organic-traffic drop that the merchant blames on the migration
- If the domain is NOT carried over, backlink equity is simply lost — no redirect can recover authority pointed at the old host

### #3c — Stripe payout reconciliation

**What it is.** Reconciles Stripe payouts and processing fees into Calderyn's finance layer so the merchant sees true net revenue. Stripe payout/fee webhooks (payout.paid, balance_transaction) land processing-fee and payout rows in the transaction_ledger and a payout_fact, letting net = gross − refunds − Stripe fees roll into the same P&L surfaces that today only see cost analytics (cogs_fact, sku_pnl, shipping_cost_period). None of it blocks a buyer from transacting.

**Includes:**
- Stripe payout.paid / balance_transaction ingestion
- Fee + payout rows in transaction_ledger
- payout_fact + reconciliation of payout → underlying charges/orders
- Gross-vs-net tie-out report (vs Stripe balance)
- Merchant payout/fee reporting mirrored into the dashboard surface (parity)

**Depends on:** #3, #3b

**Data model / contracts.** New payout_fact(stripe_payout_id, shop_id, gross_cents, fee_cents, net_cents, arrival_date, status) with a payout→charge reconciliation join; transaction_ledger kind in ('fee','payout'); optionally a v_* finance view alongside sku_pnl so net revenue surfaces in existing P&L screens.

**Grounding.** No payout/fee/transaction tables exist (grep-confirmed absent). Existing finance facts are cost-only (cogs_fact, sku_pnl, shipping_cost_period/shipping_invoice_line per the prior map). Stripe (#3) is the new money rail this reconciles against.

**MVP rationale.** Payouts arrive on Stripe's own schedule and Stripe already reports fees/net in its dashboard — none of this is needed for a buyer to complete a paid purchase. It is finance-accuracy analytics that is valuable but strictly post-transaction.

**Risks:**
- Reconciliation correctness across fees, partial payouts, negative balances and cross-currency is fiddly
- Per rule 12, never surface a net figure that can't be tied exactly to a Stripe balance transaction
- Lowest urgency makes it easy to under-resource and let drift accumulate

### #6.8 — Duties/DDP, checkout tax, restricted-item gating & freight/LTL (deep layer)

**What it is.** The deep, international-and-edge-case layer that makes the engine accurate at every surface for hard shipments. Adds landed-cost calculation (import duties + taxes, DDP vs DDU) for cross-border quotes, checkout tax-rate computation where the merchant relies on it, hard restriction/compliance gating (hazmat, prohibited items, embargoed regions, age-restricted), and freight/LTL quoting for oversized/heavy items that parcel carriers can't price. These are additive modules behind the same ShippingQuote contract, so surfaces don't change — they just get richer/accurate options for the long tail.

**Includes:**
- Landed-cost/duties module (HS code from package_dim + destination -> duty+tax estimate; DDP option) via a duties provider
- Checkout tax computation path (where shop uses Calderyn for tax) integrated into the quote/callback
- Restriction enforcement: hard-block invalid service options at quote time (hazmat air, prohibited destinations, PO box exclusions) with buyer-visible reasons
- Freight/LTL adapter + quoting for items flagged freight in package_dim (palletized, class-rated)
- Pickup / local-delivery / in-store options surfaced as service choices
- Multi-origin / split-shipment routing for items stocked across location_dim

**Depends on:** #6.1, #6.3, extend:ShipCostAdapter

**Data model / contracts.** Extend ShippingQuote options with duties_cents, tax_cents, ddp_flag, freight_class. New duties/tax provider adapters under the same provider-blind pattern. New ship_freight_rate / duties_estimate_log tables. Reuse ship_restriction_rule from #6.1 for hard gating.

**Grounding.** Net-new and deepest. grep-confirmed ABSENT: tax-rate, shipping-zone, duties, freight — none exist. country_of_origin/HS code only arrive with #6.1. This is explicitly the 'deep version' the prompt distinguishes from the MVP-thin path; parcel-only domestic rates ship far earlier.

**MVP rationale.** A first pilot merchant can transact safely with domestic parcel rates + a delivery promise. Duties, checkout tax, freight, and compliance gating are valuable for international/edge merchants but are not needed for the first real sale — classic later-tier depth.

**Risks:**
- Duties/tax are legally sensitive — a wrong landed-cost quote can create a compliance/chargeback liability; must be clearly estimated and bounded
- Freight/LTL pricing is a separate carrier ecosystem with class codes and accessorials — effectively its own integration project
- Restriction gating that is too aggressive silently kills sales; too loose ships prohibited goods — needs careful, visible rules

### #8 — Store builder (page/section/block/template data model + visual editor)

> **Note:** the *generator* (`#16`) is MVP-core and composes stores on `#7`'s fixed templates; `#8` (this — the visual *editor*) stays later (Step 12) and will receive `#16`'s editable block output once it lands — the generator becomes `#8`'s cold-start, not a competitor to it.

**What it is.** A merchant-facing visual editor plus a normalized content model (template -> page -> section -> block tree, with draft/published versioning) that lets a merchant compose their storefront beyond the fixed templates of #7. The builder writes a published page document that #7's SSR renderer consumes instead of a hard-coded template, turning Calderyn from a renderer into an actual store builder. The editor lives in the dashboard's own non-Polaris cd-* stack and can reuse the react-grid-layout drag/resize substrate already loaded there. Blocks (hero, product grid, rich text, image, collection list) bind to the owned catalog and pull imagery from #9, including re-prompted Higgsfield-generated page imagery. Per the dashboard-parity rule this must be mirrored on the standalone dashboard's postgres/withShopContext stack, not just here.

**Includes:**
- Content data model: template / page / section / block tree (typed block schema), per-shop scoped, with draft-vs-published versioning
- Visual editor UI in the dashboard cd-* design system, reusing the existing react-grid-layout drag/resize grid as the canvas substrate
- Block library bound to the owned catalog (product grid, collection list, hero, rich text, image) plus brand/theme controls
- Publish pipeline: builder writes the published document that #7's SSR reads; draft preview rendered through the same renderer
- Asset insertion via #9; generated page imagery via the re-prompted Higgsfield client landing in #9
- Dashboard-parity re-implementation of the same page/block contract on the standalone dashboard stack (match the contract, not the Polaris/Remix code)

**Depends on:** #7 (the SSR renderer that consumes the published page document), #9 (asset insertion + generated imagery into blocks)

**Data model / contracts.** Net-new normalized tables: template_dim, store_page (shop_id, slug, status draft|published, version), page_section (page_id, order, kind), content_block (section_id, type, typed JSON props) — all shop_id scoped to match the manual-scoping pattern. A render contract (published page document) that #7 reads in place of a hard-coded template. Block props reference asset_dim (#9) and catalog product/collection ids.

**Grounding.** Fully net-new: no theme/page/section/template tables exist in Supabase migrations (grep empty). The only reusable substrate is the dashboard SPA and react-grid-layout already imported in app/routes/dashboard._index.tsx:17,22-26, which gives a drag/resize editor canvas to build on. Everything else (block schema, publish pipeline, editor) does not exist.

**MVP rationale.** The first real sale needs only #7's fixed templates parametrized by thin brand settings; a merchant does not need a drag-drop block editor to transact safely. It is the platform differentiator but heavy and off the purchase critical path, and the MVP definition is the thinnest store that can take a sale. The prompt explicitly separates the thin storefront (#7) from the full builder (#8).

**Risks:**
- Large scope; the typed block schema is a long-lived contract whose migrations are costly to change later
- Merchant-authored blocks render on a public surface — rich text/HTML blocks are an XSS vector that must be sanitized in #7's renderer
- Dashboard-parity mandate roughly doubles the work (re-implement the block contract on the postgres/withShopContext stack)
- Editor must round-trip losslessly to the #7 renderer; drift between editor preview and SSR output erodes trust

---

## MVP build order (dependency-sequenced)

**MVP definition.** The thinnest end-to-end commerce platform on which ONE white-glove pilot merchant can be cut over from a read-only Shopify mirror to running their store ON Calderyn (owned catalog, owned inventory, owned checkout), and a real anonymous (guest) buyer can browse, get a correct price+shipping quote, pay, and receive an order confirmation — with no oversell, no PII leaking into the analytics warehouse, and every paid order tied to a captured charge. Concretely the MVP = owned tenant identity + first-party merchant login + owned catalog SoT + decrementable inventory ledger with atomic oversell guard + rate-critical shipping product data + a single-source shipping quote engine fed by one carrier-rate adapter + buyer guest identity/consent + cart→checkout→order state machine + Stripe payment with append-only ledger + a thin SSR storefront + the owned-event ingest spine + the store-action write path + the white-glove promote/cutover spine with parity & payment-cleared gates. Everything that optimizes, scales, or beautifies the sale (accounts, refunds-as-action, builder, experimentation, billing, deep shipping, fulfillment brain) is deferred.

> **DECISION (2026-06-28 — founder): BOTH surfaces ship as one MVP.** The agentic buy-in-chat surface (`#14`) + its quote MCP tool (`extend:MCP+storefront`) are promoted from fast-follow into MVP-core and built at **Step 8b** (below), on top of the owned checkout core. The owned storefront/checkout is *also* MVP. So the first sale can happen on either surface, both on Calderyn's own rails. This is the bigger MVP, chosen deliberately for two-surface coverage from day one. (Agentic *experimentation* `#15` stays deferred — distinct from the buy-in-chat surface.)

> **DECISION (2026-06-28 — founder): the agentic store generator (`#16`) is also MVP-core.** Built at **Step 7b** on `#7`'s fixed templates + the existing Claude harness — the "describe it / connect your catalog → AI builds the store" headline ships in v1. It drags nothing else in (verified: `forcedIntoMvp` empty). The heavy visual *editor* (`#8`) and original generated imagery (`#9`/Higgsfield) stay deferred.

**Step 1 — `extend:TenantIdentity`**

Foundational, zero-dependency enabler and the closest-to-done seam (shops.id UUID already isolates every fact/dim table; only the lookup KEY is Shopify-coupled). A pilot merchant with no *.myshopify.com domain needs a shops row provisioned from an owned org id. SessionAuth, IngestETL, ActionAdapter, catalog, and cutover all hang off this, so it lands first. Cheap because downstream UUID isolation already exists.

**Step 2 — `extend:SessionAuth`, `#5`**

Both depend only on TenantIdentity and are independent of each other. SessionAuth swaps the Shopify-OAuth IdP for first-party merchant accounts so the operator can log into the Calderyn admin to set up the store (token lifecycle already built — cheap mvp-core). #5 promotes the flat sku_dim mirror into an owned product/variant SoT (price/status/inventory_policy the checkout reads) with a sku_dim compatibility view so the ~70 downstream detectors keep resolving — the catalog authority the storefront/checkout read without round-tripping Shopify.

**Step 3 — `#4`, `#5-shipping`, `#6.1`**

All build on the owned catalog (#5). #4 is the decrementable inventory ledger + atomic oversell guard + time-boxed reservations — the literal 'safely' (two buyers can't buy the last unit); its provisional dependsOn '#5' is satisfied here. #5-shipping adds the REQUIRED, write-validated rate-critical shipping attributes (weight/dims/origin/destination restrictions) on the owned variant so a correct shipping charge is possible. #6.1 adds the package-dimension/origin/restriction substrate the quote engine consumes. Build the three together since they share the owned-variant surface.

**Step 4 — `extend:ActionAdapter`, `extend:ShipCostAdapter`**

ActionAdapter needs the owned inventory ledger (#4) + TenantIdentity: it adds the StoreActionAdapter (setPrice / reserveInventory / releaseInventory / publishProduct) reusing the resource-agnostic action_audit + idempotency tail, giving checkout the idempotent reserve/decrement write that prevents oversell/double-decrement. ShipCostAdapter (depends on #6.1) adds the buyer-facing getRates() carrier quote path (one EasyPost aggregator = USPS/UPS/FedEx) with the mandatory timeout+static-fallback contract. Independent of each other; both gate later steps.

**Step 5 — `extend:IngestETL`, `#6.3`**

IngestETL (depends on TenantIdentity + ActionAdapter) re-points the raw→transform→DLQ spine to accept owned CHECKOUT_COMPLETED / INVENTORY_RESERVED events, carries customer identity instead of stripping it, and flips inventory apply from observation-upsert to ledger-append — the data spine that records a real sale. #6.3 (depends on #6.1 + ShipCostAdapter) is the deterministic single-source-of-truth shipping quote engine every surface calls (parcel assembly, merchant rules, delivery window, fallback) — built once so checkout/storefront/chat can never disagree.

**Step 6 — `#1`, `#6.4`**

#1 (buyer guest identity/consent; depends on storefront tenant resolution provided by TenantIdentity + #7 routing) creates the net-new OLTP buyer PII store (buyer_dim/address/consent) with Postgres RLS, holding the hard invariant that NO PII enters order_fact. #6.4 (depends on #6.3) registers the Shopify CarrierService + HMAC-verified live callback so Calderyn rates appear at the real checkout ON BY DEFAULT — the definitional gate where the first sale computes shipping. Built in parallel: buyer-capture and the checkout rate surface are independent.

**Step 7 — `#2`, `#7`**

#2 (cart/checkout/order state machine; depends on #1 + the inventory ledger from #4) is the transactional spine: cart priced against owned variants, reservation at checkout, order origination as SoT, and the warehouse-emission adapter that keeps order_fact/order_line_fact/attribution flowing to the existing brain. #7 (thin SSR storefront; depends on owned catalog #5, routes to checkout) is the public unauthenticated tenant-scoped surface a buyer loads to browse and start a purchase — fixed templates + brand settings, explicitly NOT the builder. Built together: storefront hands add-to-cart intent to the checkout spine.

**Step 7b — `#16`** *(MVP-core, founder decision — parallel to Step 8, off the first-sale critical path)*

The agentic store generator — "describe it / connect your catalog → AI builds the store." Rides `#5` (owned catalog) + `#7`'s fixed templates + its frozen brand/store-settings + the already-built Claude harness (`app/lib/assistant/*`, `claude_layer` locked-contract pattern); writes `#7`'s flat settings, never `#8` blocks. Reuses imported product imagery (hotlink, no `#9`) and generates store/collection-level copy only — so it drags **nothing** else into the MVP (`#9`, Higgsfield, `#8`, `#15` all stay deferred; `forcedIntoMvp` verified empty). Produces a previewable `#7`-rendered draft pre-cutover; the "connect your catalog" mode reaches full fidelity at Step 9 when `#13.promote` materializes the real catalog. Off the payment critical path → parallels `#3` (Step 8). **Owner: Eric.** Two pre-code fixes (rule 7): make `#5`'s `product_dim/product_media` names canonical (vs `#13.promote`'s `*_sot`) and add `product_media` to `#13.promote`, else the generated store's imagery breaks at cutover.

**Step 8 — `#3`**

Payments (Stripe) + append-only transaction ledger depends on the order state machine (#2). PaymentIntent via Stripe Payment Element (PCI SAQ-A, no PAN on Calderyn), idempotent webhook drives order→paid, every money event recorded so the paid state is auditable. This is the literal '…complete a real, PAID purchase.' Comes after the order spine exists because the paid transition mutates #2's state machine.

**Step 8b — `#14`, `extend:MCP+storefront`** *(MVP per the 2026-06-28 decision)*

The agentic buy-in-chat surface, built on the owned checkout core from Steps 7–8 — so the in-chat purchase action reuses #2/#3 and the quote reuses #6.3, with NO per-surface logic. Adds: a thin protocol adapter exposing catalog + the single-source live quote + a purchase action to external AI assistants over one emerging standard (ACP/AP2/MCP commerce), extending the existing Calderyn MCP read/propose seam; plus the `quote_shipping` MCP tool + storefront delivery-promise widget (thin adapters over #6.3). Built after payments (#3) because the in-chat purchase completes through the same owned checkout. With this, the MVP transacts on BOTH surfaces.

**Step 9 — `#13.promote`, `#13`, `extend:write-back`**

The cutover spine, last because it materializes and flips onto everything above. #13.promote builds import_map + copies the mirror (catalog/locations/inventory opening balances/order history) into the owned SoT tables (#5/#4) — cheap 'promote what we already mirror.' #13 is the org_mode state machine (mirror→importing→dual_run→live) with the hard parity gate AND the payment-cleared go-live gate (a test transaction must clear — this IS the 'safely'). extend:write-back flips the executeAction terminal writer from Shopify Admin to the owned price column + inventory ledger so post-cutover a purchase decrements Calderyn's own stock. After this step ONE pilot merchant is live on Calderyn and a guest buyer can transact — the MVP is met, on BOTH the owned storefront/checkout (Steps 7–8) and the agentic buy-in-chat surface (Step 8b).

**Step 10 — `#1b`, `#3b`, `#12`, `#9`, `#13.customers`**

First fast-follow wave, right after the first sale works. #1b upgrades guest→accounts (magic-link, saved cards via Stripe, order history) to drive repeat purchase. #3b makes refunds a first-class audited Calderyn action (Stripe refund + negative ledger + order transition + native refund_fact) on both surfaces. #12 (RLS hardening) is promoted to near-term because it MUST become core the instant a SECOND tenant onboards — cheap structural insurance against a missed .eq('shop_id'). #9 (owned asset CDN) persists merchant uploads and ephemeral generated imagery. #13.customers re-acquires the historic customer base via consented re-pull/progressive collection (gated on PCD approval).

**Step 11 — `extend:fulfillment-ingest+brain`, `#10`, `extend:Higgsfield`, `#5-shipping-advanced`, `#15`, `#17`, `#17.fulfillment`**

Second fast-follow wave — differentiators that need accumulated post-sale data or larger lifts. #10 + extend:fulfillment-ingest+brain add real fulfillments/* webhooks, a live fulfillment state machine, promised-vs-actual delivery tracking, and the carrier scorecard as a brain signal. extend:Higgsfield re-prompts the image client for storefront/page aesthetics (needs a page surface to attach to). #5-shipping-advanced adds regulated/oversized attributes (hazmat/cold-chain/freight/customs) for vertical merchants. #15 is the agentic experimentation engine (generate→pre-screen→live Thompson bandit→auto-promote) — the ad surface ships first since generation+pre-screen+meta-push already exist; it needs a real conversion reward, which the owned checkout now provides. #17 + #17.fulfillment (viral product sourcing) also join this wave: the discovery half (#17) only needs #5/#16 (both built by Step 9) so it can begin earlier in the fast-follow window, but the live dropship order-routing (#17.fulfillment) needs #10's fulfillment state machine, which lands here; owner Eric. (#14, the agentic buy-in-chat surface, is NOT here — it was promoted to MVP at Step 8b per the 2026-06-28 "both surfaces as one MVP" decision.)

**Step 12 — `#3c`, `#6.8`, `#8`, `#11`, `#13.aesthetics-seo`**

Later tier — valuable but not needed to transact and off the immediate-differentiator path. #3c reconciles Stripe payouts/fees into net-revenue P&L (Stripe already reports these; finance accuracy, post-transaction). #6.8 is the deep shipping layer (duties/DDP, checkout tax, restriction gating, freight/LTL) for international/edge merchants. #8 is the full visual store builder (page/section/block model + editor) — heavy, off the purchase path; #7's fixed templates suffice to transact. #11 is Shopify-native merchant billing — orthogonal to the first sale (buyer pays the merchant, not Calderyn) and a pilot can run comp/manual-invoice. #13.aesthetics-seo is AI theme approximation + SEO/301 equity bridge — a pilot can eat a temporary aesthetic/SEO hit (basic 301s can be pulled into #13 cutover if the domain is kept).

---

## What's explicitly cut from the MVP

OUT of the MVP (safe to defer): (1) Buyer accounts/saved cards (#1b) — guest checkout (#1) is sufficient for the first paid sale; accounts drive repeat, not first, purchase. (2) Refunds-as-action (#3b) — a pilot merchant refunds directly in the Stripe dashboard day one; native audited refunds are fast-follow. (3) Stripe payout reconciliation (#3c) — Stripe reports fees/net itself; pure post-transaction finance analytics. (4) Advanced/regulated shipping (#5-shipping-advanced, #6.8) — a generic domestic parcel sale transacts safely on weight/dims/origin/destination; hazmat/freight/duties/checkout-tax are vertical/international depth. (5) ~~Storefront delivery-promise + buy-in-chat quoting + agentic commerce core (#14)~~ **— PROMOTED TO MVP (2026-06-28 decision), no longer cut: #14 + the quote MCP tool (extend:MCP+storefront) ship in the MVP at Step 8b on the owned checkout core.** (6) Fulfillment lifecycle + carrier brain (#10, extend:fulfillment-ingest+brain) — strictly post-purchase; needs accumulated history. (7) Store builder (#8) and generated page imagery (#9, extend:Higgsfield) — #7's fixed templates + merchant-supplied photos suffice to transact. (8) Experimentation engine (#15) — optimizes what is sold, doesn't enable the sale. (9) Billing (#11) — buyer pays the merchant via Stripe, not Calderyn; pilot runs comp/manual-invoice. (10) Theme/SEO equity bridge (#13.aesthetics-seo) and historic customer re-pull (#13.customers) — a fresh storefront + fresh customer_sot rows at checkout let the FIRST sale happen; migrating equity/customers is near-term value, not a transact blocker. (11) Viral product sourcing (#17, #17.fulfillment) — a cold-start *acquisition* funnel (viral-product feed → pick → auto-store → live dropship) for merchants with NO catalog; it grows the top of funnel but does not gate the first sale of a pilot merchant who already imported or hand-entered a catalog, so it is fast-follow (its deps #5/#16 are already built; the live-fulfillment half rides #10 at Step 11). Notable reconciliation: RLS (#12) was argued non-core by its own brief (single pilot = no second tenant = cross-tenant leak physically impossible) and is held at fast-follow with an explicit promotion trigger (second real tenant). Its premise that 'RLS gates buyer/payment data' is corrected: in this MVP buyer PII lives in a NEW RLS-from-day-one OLTP store (#1), not the warehouse, so warehouse RLS protects merchant COGS/margin, not buyer payment data.

---

## Conflicts surfaced & resolved (rule 7)

Conflicts surfaced and resolved (rule 7, not averaged): (A) **[RESOLVED 2026-06-28 — founder chose BOTH surfaces as one MVP.]** #14 (agentic buy-in-chat) self-tiered mvp-core; the sequencer provisionally reconciled it DOWN to fast-follow on the grounds that the owned checkout (#2/#3/#6.4/#7) already gates the first sale. The founder overruled: BOTH the owned storefront/checkout AND the agentic surface ship in the MVP. #14 + its quote MCP tool (extend:MCP+storefront) are promoted to MVP-core and built at **Step 8b**, on top of the owned checkout core (the in-chat purchase reuses #2/#3; the quote reuses #6.3 — no per-surface logic). The bigger MVP, deliberately chosen for two-surface coverage from day one. (B) Two parallel shipping-data features overlap: #5-shipping (rate-critical attrs on variant) and #6.1 (package_dim + origin/restriction config). Their dataModelContracts collide (both own dims/origin/restrictions). Treated as one logical substrate built together in step 3; if built by separate teams, dedupe table ownership (variant_shipping vs package_dim) before coding or they clobber each other. (C) extend:ActionAdapter and extend:write-back both 'flip the inventory/price writer to owned tables' — ActionAdapter introduces the StoreActionAdapter; write-back adds the org_mode routing so the SAME actions hit owned-vs-Shopify based on cutover phase. Sequenced so ActionAdapter (the adapter) precedes write-back (the org_mode router), both after #4/#13.promote. (D) Dependency-conflict fixes applied: #4's provisional dependsOn '#5' is honored (catalog before inventory ledger). #2 depends on #1 + the inventory ledger (#4), so #1/#4 precede it. #13/#13.promote/extend:write-back depend on owned commerce primitives that are net-new — sequenced last so they materialize/flip onto already-built SoT tables. After reconciliation NO mvp-core feature depends on a later-tier feature. (E) Hard invariants to enforce throughout (rule 12, fail visibly): NO buyer PII ever enters order_fact/the warehouse (#1 + IngestETL must capture PII into the separate RLS OLTP store, not reverse the strip into order_fact); inventory decrement must be a real row-locked conditional UPDATE, not an upsert; every paid order must tie to a captured Stripe charge; the cutover payment-cleared gate must block go-live until a test transaction clears. (F) Feature-isolation rule: each step should be built in its own git worktree per the repo contract; dashboard parity is part of each user-visible feature, not a follow-up.

---

## Work distribution — John ↔ Eric (parallel MVP, no trampling)

Two builders shipping the MVP simultaneously. Split by **existing strength** *and* by **file domain**, so daily work touches disjoint directories and integration happens only at a few explicit contracts.

**The split principle.** John has owned the **autopilot + server engine**; Eric has owned **ads + product surfaces**. Extend that line:
- **John → the owned-commerce data core + autopilot.** Catalog source-of-truth, the inventory ledger, the store-action executor (`ActionAdapter`/write-back — his autopilot seam), the ingest ETL spine, the cutover/migration, and (post-MVP) promoting the autopilot onto owned data + store-autonomy.
- **Eric → the buyer-facing surfaces + external integrations + agentic + ads.** Storefront, cart/checkout/order flow, buyer identity, Stripe payments, the shipping quote engine + carrier adapter, the agentic buy-in-chat surface + MCP, the experimentation engine's ad side, and the existing ad stack.

**Directory ownership (the anti-trample rule): one owner per directory; cross-domain changes go through the seam contract below — never by editing the other's files.**

| Domain | Owner | Primary dirs/files |
|---|---|---|
| Identity/session spine (Step 1–2) | **John** (Eric unblocked fast) | `shopify.server.ts` retire, `supabase.server.ts` (resolveShopId), `dashboard/session.server.ts` |
| Owned catalog SoT | **John** | catalog data layer in `calderyn.server.ts`, commerce-core migrations |
| Inventory ledger | **John** | new ledger module + migrations |
| Store-action executor + write-back | **John** | `app/lib/actions/*` (his autopilot seam) |
| Ingest ETL spine | **John** | `app/lib/ingest/*` |
| Cutover / warm import | **John** | new import/migration module |
| Storefront renderer + hosting | **Eric** | new storefront routes |
| Cart / checkout / order flow | **Eric** | new checkout routes + order state machine |
| Buyer identity (OLTP + RLS) | **Eric** (John advises RLS) | new buyer tables/routes |
| Stripe payments | **Eric** | new payments module + webhook |
| Shipping quote engine + carrier adapter | **Eric** | new shipping module |
| Agentic surface + MCP | **Eric** | `app/lib/assistant/*`, MCP tools |
| Ads stack + experimentation (ad side) | **Eric** | `app/lib/ads/*`, `app/lib/meta/*`, screener/generator |
| Agentic store generator (`#16`) | **Eric** | new `app/lib/storegen/*` + the `app/lib/assistant/*` Claude harness; writes `#7` settings; reads John's catalog via the read contract (never edits his tables) |
| Viral product sourcing + supplier adapter (`#17`/`#17.fulfillment`) | **Eric** | new `app/lib/sourcing/*` (signal ingest, virality scorer, `SupplierAdapter`) + Discover dashboard screen; materializes picks through John's catalog-**write** contract (never edits his tables); invokes `#16` `generateStore`; routes buyer orders to the supplier and emits fulfillment events into `#10` |

**The integration contracts — agree these UP FRONT, then build to them in parallel (this is what prevents trampling):**
1. **Catalog read contract** — John publishes the owned-catalog read types/API; Eric's storefront + checkout consume. *(John → Eric)*
2. **`StoreActionAdapter` interface** — `reserve / release / decrement / setPrice`; John builds, Eric's checkout calls. The ONLY path from checkout to inventory. *(John → Eric)*
3. **Owned-event schema** — `CHECKOUT_COMPLETED` / `INVENTORY_RESERVED` + the `order_fact`/`order_line_fact`/`attribution_fact` emission shape; Eric's checkout emits, John's ETL ingests. Both build to the agreed schema. *(Eric ↔ John)*
4. **Shipping quote interface** — `getRates(parcel, dest) → rates[]`; Eric builds, checkout + (later) the autopilot consume. *(Eric → John)*
5. **Migrations ordering** — both add `supabase/migrations/*` (real collision risk). Convention: **John owns commerce-core migration numbering; Eric sequences surface migrations after John's for any shared table.** Never two un-coordinated migrations touching the same table in one cycle.
6. **Catalog write contract** — `createProduct / createVariant / setVariantPrice` (`app/lib/catalog/catalog.server.ts`); John owns the catalog tables, Eric's `#17` sourcing calls this to materialize a picked product (and `#16`/store-gen stays settings-only). Extends contract #1 from read-only to a guarded write seam so the sourcing funnel never edits John's tables directly. *(John → Eric)*

**Day-1 parallel start (nobody blocked):**
- **John:** Steps 1–2 — identity/session spine + catalog SoT. Unblocks everyone.
- **Eric, in parallel with zero deps on John:** the self-contained external integrations — Stripe spike, the EasyPost/carrier shipping adapter, and the storefront shell against a *stub* catalog. When John's catalog read contract lands, swap the stub for the real one.
- **Converge:** Eric's checkout calls John's `StoreActionAdapter` and emits the owned-event schema John's ETL consumes; both ship behind the cutover gate John builds last (Step 9).

**Process guardrails (already in the repo contract):**
- **One worktree per feature** (`git worktree add ../calderyn-<feature> -b feat/<feature>`) — exactly the isolation this needs; John and Eric each work in their own worktrees, never the same branch.
- **Dashboard parity is each owner's job** for their own features — not a handoff.
- Integrate via PRs (the team's existing flow); the five seam contracts are the review checklist.

---

## Warm-lead on-ramp — one-click Shopify import (existing approved extension)

The already-App-Store-approved Shopify extension is the acquisition channel **and** the importer: a merchant installs it, and one click migrates their existing Shopify store onto the owned Calderyn platform. This is the answer to the biggest non-engineering risk ("why would a merchant leave Shopify") — it collapses the *technical* switching cost by reusing ingest the repo already has.

**Mostly a REUSE/EXTEND, not a fresh build.** The extension already mirrors catalog, inventory, orders, refunds, campaigns, and SKUs into the Supabase warehouse (`ingest/transform.server.ts`). The import is largely the **seed step Slice 1/2 already call for** — promote the mirror to owned source-of-truth, keeping `external_id` as the import-map column.

**Ports cheaply (data already mirrored):**
- Product catalog (`sku_dim`), inventory levels (as opening balances for the new ledger), order + refund **history** (as records), ad campaigns + performance, COGS. Calderyn's analytics/grades/ROAS keep working because the warehouse rows are the same.

**Net-new orchestration this feature needs:**
- The one-click "migrate my store" flow: provision owned org, snapshot → transform mirror → owned tables, validate, cut over.
- **Customers cannot be ported from today's mirror** — order PII is deliberately stripped at ingest (`mappers.server.ts:449`, `ingest/types.ts:37`), so there is no customer identity in the warehouse to import. Porting customers requires a new **consented re-pull** from Shopify (un-minimized orders or a `read_customers` scope) — net-new, and a privacy/consent surface.

**Two honest limits — do not oversell "ports everything / stats stick":**
1. **Aesthetics regenerate, they don't port.** The extension's approved scopes cover *data* (read/write products+inventory, read orders/locations) but include **no `online_store`/theme/page scope** — "how the store looks" can't even be read today, and Shopify themes are Liquid (not portable) regardless. "Remade with our store builder" means **AI-regenerated approximation** (Slice 6, a generative-fidelity problem), not a faithful port. Set merchant expectations accordingly.
2. **Stats stick ≠ equity sticks.** Historical orders/analytics import as records, but **SEO ranking and pixel/attribution equity do NOT survive a replatform** (new infra, URLs, page structure) even though the dashboard numbers carry over. The data-port lowers the *technical* switch cost; it does nothing for the *risk* switch cost of moving a live revenue store onto new infra.

**Lights up incrementally:** the catalog/inventory/order-history/campaign port rides Slices 1–3 on the existing extension and is available early; the storefront-aesthetic regeneration rides Slice 6 and lands last.

---

## The strategic upgrade owning checkout buys us

Today ROAS attribution is **heuristic** — it reconstructs which order came from which ad by UTM/click-id/referrer matching of mirrored Shopify orders (`attribution/match.ts`), confidence "rough/strong." Owning checkout lets us write `attribution_fact` **deterministically, server-side, at the moment of sale.** The ad brain goes from *guessing* attribution to *knowing* it — the pivot makes the existing moat **better**, not just bigger. This is the single strongest codebase-grounded argument for going first-party.

---

## Agentic commerce — buy-in-chat, and shipping data as product data

**The surface.** A customer asks an AI assistant for a recommendation, compares a couple of options, and buys **inside the chat** — no category page, no PDP scroll, no brand journey. A fast decision on limited information. Calderyn-store products must be purchasable directly from that conversation.

**The rule that makes "accurate everywhere" true: one accurate commerce core, many surfaces.** Price, real-time stock, the shipping rate, the delivery promise, and service options are computed **once, in the owned core** (catalog + inventory ledger + shipping/quote engine + checkout); every surface — storefront, agentic chat, warm-imported store — reads the *same* answer. There is **no per-surface quote logic.** "Accurate everywhere" is an architecture (single source of truth), not a QA pass.

**Why the bar is higher here than on a storefront.** In chat there's no second chance: if the agent shows a wrong shipping rate, an unclear delivery promise, or service options that don't fit, there's no page to explain it and no room to recover. The data and logic behind the purchase must do the work the brand journey used to do. So whatever shipping depth is live when the agentic surface launches must be **real**, not "good enough."

**Shipping data is product data — and it's on by default.** The owned catalog carries, as first-class **validated** fields: weight, dimensions, origin, hazmat status, temperature requirements, freight eligibility, packaging rules, country restrictions, delivery constraints. These feed the quote engine; if they're wrong, the quote is wrong and someone eats the cost. All of it is **default** — required and validated at catalog write time, not an optional shipping app.

**Shipping performance is part of the commercial relationship.** Carrier selection, tracking quality, fulfillment speed, and delivery consistency are tracked and surfaced — they now influence acquisition, agent/marketplace ranking, and trust, not just operations.

**Reuse, don't reinvent:**
- The **Calderyn MCP already exists** (`mcp__calderyn__*` read/propose tools) — the agentic surface extends that seam with catalog + quote + purchase tools, not a bespoke API.
- **Ride the emerging standards** (OpenAI/Stripe Agentic Commerce Protocol, Google AP2, Shopify Catalog / universal cart, MCP commerce) — speak the protocol the assistants speak; keep our adapter **thin** so a wrong bet is a swap, not a rebuild.
- The purchase action reuses the owned checkout/payments/inventory core (Slices 2–3); the agentic surface is a protocol adapter over it, nothing more.

**Brain tie-in (free synergy):** shipping-data completeness, quote accuracy, and carrier performance become **detector signals** for the existing remediation/autopilot loop — "incomplete shipping data → inaccurate quotes → lost agentic sales", "margin erosion from shipping", "carrier underperformance". The same detector → rank → (graduated) action machinery extends to shipping; no new brain required.

---

## Agentic experimentation — generate → simulate → live-test → auto-promote

**Goal.** The system autonomously finds the most optimal **store UI** and the most optimal **ad**, end-to-end, with no human running the test.

**The honest architecture (four stages — "pure simulation picks the winner" is NOT it):**
1. **Generate** variants — store-UI layouts via the store builder; ad creatives via the existing Higgsfield generate-loop.
2. **Simulate / pre-screen** — score variants *cheaply* before spending real traffic or dollars. Prunes 100s of candidates to a few finalists, and it is the **only** signal available for a brand-new / no-traffic store (cold-start). For ads this **already exists**: the creative pre-screen / vision-scorecard (`app.screener`, the vision gate) predicts performance before spend.
3. **Live-test** the finalists on **real** traffic — real ad-views, real checkouts — with a **multi-armed bandit** that shifts traffic to the winner, then **auto-promote** through the existing graduation/calibration ladder. Real traffic is the *decider*; simulation only narrows the field.
4. **Calibrate the simulator against real outcomes** each round (cross-merchant) so the synthetic score becomes trustworthy over time — that calibration loop is itself a moat, and it's the same pattern the moat-trainer already runs.

**Why this shape, not pure simulation:** a simulator that *decides* the winner means you optimize to the *simulator*, not the customer — confidently shipping the wrong thing. Simulation is a pre-filter and a cold-start bridge; real conversions decide. (Pure simulation-as-decider is a different, riskier product — flagged in the risk register.)

**Reuse — this is mostly assembly, not invention:**
- **`Beta(α,β)` = Thompson sampling.** The autopilot already stores per-`(shop,detector,action)` `Beta(α,β)` in `pair_calibration`. A bandit over variants is `Beta(α,β)` **per variant** — *the same math.* Winner-promotion is the same graduation ladder. The experiment engine **is** the autopilot loop with "variant" as the candidate and "conversion lift" as the reward.
- **Ad creative pre-screen + Higgsfield generate-N-score-keep-winners already exist** (`app.generator`, the vision gate) — that's stages 1–2 for ads, today.
- **Deterministic owned-checkout attribution (Slice 3) is the reward signal** — clean per-variant conversion, server-side. (Another reason owning checkout matters.)
- **Ad write-back adapters (Meta/Google/TikTok) already exist** to allocate ad-view traffic; the store-UI side allocates via the storefront renderer (Slice 5/6).

**Two targets, different readiness:**
- **Ad experiments** — closest to done: reuse the creative pre-screen + ad write-back; add the live-bandit allocation + auto-promote loop. Can start before the store exists.
- **Store-UI experiments** — depend on the store builder (Slice 6) for variants and owned checkout (Slice 3) for the reward. Net-new orchestration on the *same* bandit/promotion engine.

---

## Experimentation UI — the elimination bracket

The agentic-experimentation surface is visualized as a **single-elimination, one-sided tournament bracket**: it fans out from the many generated variants on the left and collapses round-by-round to **the champion** (the winning store/ad) on the right. It reads as "many → few → one," which makes the autonomous optimization legible and genuinely good to watch.

**Each round is a real engine stage — not decoration.** The bracket is bound to actual experiment state, so a "win" means a variant really beat another:
- **Round 0 — fan-out:** every generated variant enters (the "multiply" stage).
- **Pruning rounds — simulate / pre-screen:** variants eliminated by the pre-screen / vision-scorecard. Cheap, fast, no real traffic spent.
- **Semifinal / final rounds — live bandit:** survivors compete on **real** ad-views / checkouts; the bandit shifts traffic and eliminates losers on real conversion data.
- **Champion — auto-promote:** the winner is promoted through the graduation ladder and goes live.

```
 variants (fan-out)     pre-screen        live bandit        champion
  V1 ┐
     ├─ S1 ┐
  V2 ┘     │
           ├─ F1 ┐
  V3 ┐     │     │
     ├─ S2 ┘     │
  V4 ┘           ├──►  ★ WINNING STORE / AD
  V5 ┐           │      (auto-promoted)
     ├─ S3 ┐     │
  V6 ┘     │     │
           ├─ F2 ┘
  V7 ┐     │
     ├─ S4 ┘
  V8 ┘
```

**Honest-UI invariant (rule 12 + browser-source-hygiene):** the bracket must reflect *real* eliminations, live-updating as pre-screen scores and bandit traffic land — **not** a scripted animation. Today's dashboard "Generator" is a `setTimeout` simulation with placeholder boxes; this replaces that pattern with real state. A bracket that "finalizes on a winner" that wasn't actually tested would be exactly the success-theater the project forbids.

**Surface & reuse:** ships on the **standalone dashboard shell** (the `cd-*` design system + Lucide via `CDIcon` — dashboard convention, not Polaris). Live bracket updates can ride the existing realtime infra (`dashboard.api.realtime-token`, the live feed). The same bracket component serves both ad and store-UI experiments — only the "competitors" differ.

---

## Build path (closest-to-done → furthest)

> The 0→6 slices below are the **conceptual arc** (and what the rest of this doc cross-references). The **dependency-sequenced 12-step MVP build order**, with the explicit cut-line, is in the Feature catalog section above.

0. **De-Shopify the auth spine** *(closest to done)* — first-party merchant accounts on the existing `dash_live_` session system; tenant identity `shop_domain → owned org id`; retire embedded Polaris. Unlocks everything else. **(M)**
1. **Own the catalog** — product/variant/pricing CRUD with native ids; seed from the `sku_dim` mirror; re-point price/discontinue executors behind the unchanged adapter seam.
2. **Own a real inventory ledger** — mutable, decrement-on-sale, reservations, oversell guard, multi-location.
3. **Thin checkout + Stripe + customers** — cart→order→payment→state-machine emitting the same `order_fact`/`order_line_fact`/`attribution_fact` rows; *attribution becomes deterministic here*. The **shipping/tax quote engine is established here as the single source of truth** — start with fewer carriers, but *real* rates, not fake flat rates (the agentic surface has no room for "good enough").
3b. **Shipping engine → first-class & default** — deepen the Slice-3 quote engine into carrier-grade rates + delivery-date prediction + service/pickup options + duties/restrictions/freight; make shipping attributes required & validated on the catalog; track shipping performance. On by default for every surface.
   - **Agentic commerce surface (buy-in-chat)** — *can ship right after 3b, before the storefront (Slice 5), since it needs no PDP/theme*: expose catalog + accurate live quotes + a purchase action to external AI assistants over the emerging agentic-commerce protocol, reusing the Calderyn MCP seam and the owned checkout core. See the "Agentic commerce" section.
4. **Promote the ad brain onto owned data + first store-autonomy** — detectors on first-party signals; new store-action adapters + `GRADUATABLE` entries + undo branches + `NO_BRAINER` seeds, reusing the trust engine verbatim. *This opens the autonomy ladder that matures to earned full autonomy — see the end-state section.* The same generate→score→gate→measure→learn loop powers **agentic experimentation** — **ad experiments can begin here** (the store-UI experiments wait for the builder).
5. **Thin storefront renderer + hosting** — SSR, small fixed template set, domain routing (not a theme editor yet) — the minimum "a buyer can actually buy" surface.
6. **Store builder + owned asset generation** — page/section/template model + visual editor + re-prompted Higgsfield into owned asset storage. Furthest-from-done, correctly last. Also produces the **UI variants the store-UI experiment engine tests** (agentic A/B).

*Cross-cutting (alongside slice 3+):* enforce Postgres RLS before real buyer/payment data; stand up billing once there is a paid product. **Warm-lead one-click import** (the existing extension) lights up incrementally across Slices 1–3 (data port) and Slice 6 (aesthetic regeneration) — see its dedicated section.

---

## Autopilot end-state — earned full autonomy

The goal is for the existing autopilot to become **fully autonomous** — operating the store end-to-end without a human — reached through the **iterative learning loop the codebase already has**, not a flip of a switch. The machinery is already in the Keep list; today it carries deliberate ceilings.

**The learning loop we already have (reuse, verbatim):**
- Per-`(shop, detector, action)` **Beta-confidence calibration** (`pair_calibration`: alpha/beta, `clean_approvals`, `consecutive_undos`, `graduation_threshold`) — the recommend → auto-execute ramp that earns trust from outcomes.
- **Nightly `mu`-dial training** (`cron.autopilot-train` → `api/engine/autopilot_train.py` → `moat.action_models`) — learns how aggressively to size each action within the guardrail ceiling.
- **Cross-merchant moat** — peer benchmarks + action-reward thresholds trained over consented shops.

**Today's deliberate ceilings (verified at source — these are by design, not bugs):**
- `GRADUATABLE_V1` = only 3 kinds may *ever* auto-run; the scale/reallocation kinds are coded but dormant.
- `adjust_price` is explicitly **never** autopilot.
- `bypassGuardrails` is **force-disabled** for autonomous calls — autonomy can never silently waive caps.
- Graduation gate 2 requires a working **undo branch** per kind; `isGraduated` fail-safes to `false` on any error.

**What "fully autonomous" requires (extend the model, don't rip it out):**
1. Expand the graduatable set (`V2+`) to the dormant scale/reallocation ad kinds **and** the net-new store-action kinds (price, inventory, publish/unpublish, page edits).
2. Each new kind ships with a real undo branch (gate-2 requirement), a reversibility-tier classification, and a `NO_BRAINER` eligibility decision.
3. A higher autonomy **tier** in the graduation ladder: once per-merchant confidence is proven, raise/relax that kind's daily ceilings — while keeping the **safety invariants intact** (undo required, fail-safe-false, append-only audit, idempotency, cross-tenant ownership). Full autonomy is the *convergence point* of the calibration loop, kind-by-kind and merchant-by-merchant — **not** a global "guardrails off."
4. Detectors firing on owned real-time signals (live stock, checkout conversion, true margin) so autonomous decisions run on first-party data (depends on Slices 1–3).

**Trajectory:** opens in Slice 4 (first store-autonomy) and matures continuously as confidence accrues; the end-state is a per-merchant fully-autonomous operator *earned* through the existing ladder, never granted on day one.

---

## Risk register (the stress-test objections, now live)

- **Scope illusion** — the autopilot governs the ad account, not the store; store autonomy is a multi-quarter build. Marketing/strategy must not claim it exists yet.
- **Full store autonomy is bet-the-merchant** — an autonomous price/inventory/product/page change with no human, on infra you host, is the highest-stakes failure mode in the whole pivot. The existing graduation/calibration/undo/guardrail loop is the mitigation, but it must be *extended per-kind* (each with an undo branch + reversibility tier), earned per-merchant, and **never** allowed to bypass guardrails for the sake of autonomy. Lifting `adjust_price`-never-auto is a deliberate policy change to make explicitly, not silently.
- **The whole commerce + monetization core is net-new** — exactly the part with zero code, and it's the regulated, fraud/PCI-exposed, high-trust surface. The codebase's skill profile (analytics/autopilot) does not match payments/checkout.
- **Inventory correctness** — observation-mirror → authoritative ledger with reservations/oversell across locations is subtle; bugs oversell/mis-ship real orders.
- **Identity-migration blast radius** — `shop_domain` is the universal tenant key (every loader, MCP token path, login, GID-keyed rows); swapping to owned identity risks cross-tenant leaks (the repo has had cross-tenant id bugs before).
- **No RLS today** — app-level isolation only; must harden before buyer/payment data.
- **Agentic checkout has no second chance** — a wrong rate / unclear delivery promise / mismatched service option in chat is unrecoverable (no page to explain). The accuracy bar exceeds a normal storefront's. Mitigation is the single-source-of-truth core: per-surface quote logic is forbidden, and the agentic surface launches only once the live shipping depth is genuinely accurate — not "flat-rate good enough."
- **Shipping data completeness is now a hard dependency** — missing/wrong weight·dims·hazmat·origin → wrong quote → someone eats the cost. Shipping attributes must be required and validated at catalog write time (default), not optional.
- **Agentic-protocol bet risk** — the agentic-commerce standards (ACP / AP2 / Shopify Catalog / MCP) are still settling. Keep the surface a thin adapter over the owned core so backing the wrong one is a swap, not a rebuild.
- **"Pure simulation picks the winner" optimizes to the simulator, not the customer** — synthetic checkouts/ad-views are a pre-filter and a cold-start bridge, never the decider. Real conversions decide, and the simulator must be continuously calibrated against real outcomes or it confidently ships the wrong UI/ad.
- **Experiments need volume** — low-traffic stores yield wide confidence intervals and slow/false winners. Use proper sequential/bandit statistics (the existing `Beta(α,β)` → Thompson sampling), not naive peeking/p-hacking; lean on the simulator pre-screen exactly where traffic is thin.
- **Go-to-market** — even a complete platform must give merchants a reason to leave Shopify (apps, payments, trust, traffic). Orthogonal to code, and the biggest non-engineering risk. The **warm-lead one-click import** (above) is the primary mitigation — it turns the installed extension base into migration leads and collapses the *technical* switch cost — but it does **not** remove the *risk* switch cost of moving a live revenue store onto new infra, nor the aesthetic/SEO-equity losses of a replatform.

---

## Doc-drift correction (rule 12)

`CLAUDE.md` is **wrong about the architecture** and must not be used as a planning input as-is:
- It says **SQLite** — the real commerce data is **Postgres/Supabase** (project `ajgrmnvzxfxxlwrxcgnu`). Prisma/SQLite holds *only* the Shopify session table.
- It frames the dashboard as a separate `withShopContext` monorepo — the deployed dashboard is **this repo's `dashboard.*` routes** using `supabase-js`; `withShopContext` does not exist here.

(Both corrections favor the pivot: the dashboard we build on already lives here and is already Shopify-independent.)

---

## Next step

Take **Slice 0** (de-Shopify the auth spine) through its own brainstorm → spec → implementation-plan cycle when ready. Everything past it depends on it. The heaviest pieces each warrant their own deep scoping before they're committed: **Slice 3** (checkout/payments), **Slice 3b** (shipping engine), **Slice 6** (store builder), the **agentic commerce surface** (buy-in-chat), and the **agentic experimentation engine** (bandit + bracket UI). The closest-to-revenue early win is **ad experiments** (Slice 4), which reuse the existing creative pre-screen.

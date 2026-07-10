# Product SEO fields — design (2026-07-10)

## Problem

PR #418 deferred "SEO fields". The pieces mostly exist but don't meet:

- `product_dim.handle` exists (`unique (shop_id, handle)`, generated at create as
  `slug + 6 random hex chars`) but is invisible in the dashboard and immutable — merchants can't
  see or clean up their product URLs.
- The SEO subsystem (`app/lib/seo/`) already layers per-product meta overrides from the `seo_page`
  table onto deterministic drafts on the PDP (`getSeoOverride` → `applyOverride` →
  `safeMetaFromDraft`), and the sitemap/robots/JSON-LD stack is live — but **nothing writes
  `seo_page` rows**: `upsertSeoOverride` has no production caller and there is no editor UI.

## Goals

1. Product editor gains a **"Search listing" card**: URL handle (editable, with full URL preview),
   meta title, meta description — with live character counters against the SEO limits (60/160) and
   the deterministic defaults shown as placeholders.
2. Handle edits are safe: slug-validated, uniqueness-checked, and **old handles 301-redirect** to
   the new one so existing links and indexed pages keep working.
3. Meta title/description persist to the existing `seo_page` table via `upsertSeoOverride` /
   `deleteSeoOverride` (empty fields = remove override, deterministic draft wins again).

## Non-goals

- Collection SEO fields (same mechanics, separate follow-up; collections already have stable
  handles).
- AI listing-flow ops for handle/meta (`ListingOp` union untouched — keep the op contract stable).
- Changing handle *generation* for new products (random-suffix stays; merchants can now clean it up
  in the editor afterwards).
- SEO settings UI changes (Search screen already owns crawler/org settings).

## Data model

One migration `supabase/migrations/20260710210000_product_handle_redirect.sql`:

```sql
create table product_handle_redirect (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  old_handle text not null,
  product_id uuid not null references product_dim(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (shop_id, old_handle)
);
```

RLS shop-scope like sibling tables. `seo_page` already exists (entity_type/entity_id,
meta_title, meta_description) — no change.

## Server changes

### Handle (catalog layer)
- `ProductDetail` + the editor loader VM (`dashboard.api.catalog.products.$id.tsx`) expose `handle`.
- `ProductInput`/`validateProductInput` accept optional `handle`: trim, lowercase; must match
  `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, length 1–80 (422 `invalid_handle`). Absent/unchanged handle =
  no-op (create keeps generating).
- `updateProduct`: when handle changes —
  1. update `product_dim.handle` (23505 → 409 `handle_conflict`, surfaced as "That URL is already
     used by another product");
  2. upsert `product_handle_redirect (shop_id, old_handle → product_id)`;
  3. delete any redirect row whose `old_handle` equals the **new** handle (handle reclaimed);
  4. redirect rows pointing at this product from older renames stay (all old URLs keep working).
- Title edits never touch the handle (collection-rename precedent).

### Meta override (seo layer write path)
- Product save payload gains optional `seo: { metaTitle?: string; metaDescription?: string }`
  (trimmed; clamp metaTitle ≤ 70, metaDescription ≤ 200 — soft-limit UI at 60/160; 422
  `invalid_seo` on non-string). In the `$id` action, after `updateProduct`: both empty →
  `deleteSeoOverride(shopId, "product", id)`; else `upsertSeoOverride`. Create route: if `seo`
  present, upsert after `createProduct` returns the id.
- The `$id` loader returns the current override (`getSeoOverride`) plus the deterministic defaults
  (`buildProductDraft(product, settings, origin)` title/description) so the UI can show placeholders
  = what renders today without an override.

### Storefront 301
- `storefront.products.$handle.tsx` loader: when `getProduct` misses, look up
  `product_handle_redirect` by `(shopId, handle)`; if found and the target product is still active,
  fetch its current handle and `throw redirect(\`/storefront/products/${current}\`, 301)`; else 404
  as today. One extra query only on the miss path.
- Sitemap already emits current handles — no change.

## UI (ProductEditor.tsx)

New `Card` "Search listing" after the Description/first card:

- **Page address**: prefix label with the store origin (`https://<slug>.calderyncompany.com/storefront/products/`)
  + handle input; helper text "Changing the address redirects the old link to the new one."
  Invalid slug / conflict errors surface inline via the existing toast + field error patterns.
- **Search title** input, counter `n/60`, placeholder = deterministic default title.
- **Search description** textarea, counter `n/160`, placeholder = deterministic default.
- A small live preview (title line + URL line + description) styled like a search result, using
  effective values (override || default). Plain-language copy, no jargon.
- Dirty-tracking joins the existing save flow: one Save button persists product + handle + seo in
  the single existing PUT.

New-product flow: unchanged (handle still generated server-side); the existing preview URL in
NewProductFlow stays as-is.

## Errors & validation

422 `invalid_handle`, 409 `handle_conflict`, 422 `invalid_seo`; all supabase errors surfaced.
Client `ProductDraft` gains `handle?` and `seo?` mirroring the server contract.

## Tests

- validate.ts: handle format/length cases, seo clamps.
- catalog.server update path: rename writes redirect row, reclaims new-handle row, 23505 → 409
  (mocked supabase, existing test style).
- seo write path: empty → delete, values → upsert.
- PDP redirect: miss + redirect row → 301 target; miss + no row → 404 (mock catalog).

## Rollout

Migration applied to prod via supabase MCP before browser verification (slug-diff check first).
Live verify on the demo shop: edit handle → old URL 301s; set meta → view-source shows override
title/description + canonical; clear meta → deterministic draft returns.

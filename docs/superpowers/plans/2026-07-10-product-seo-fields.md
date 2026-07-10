# Product SEO fields — implementation plan (2026-07-10)

Spec: `docs/superpowers/specs/2026-07-10-product-seo-fields-design.md`
Branch: `feat/product-seo` (worktree `C:\Users\famou\Desktop\calderyn-product-seo`)

Steps (one commit each):

1. **Migration** — `supabase/migrations/20260710210000_product_handle_redirect.sql`
   (table + RLS shop-scope policies matching sibling catalog tables).
2. **Catalog server** — `ProductInput.handle?` + `validateProductInput` slug rules
   (`invalid_handle`), `updateProduct` rename path (redirect upsert, reclaim delete, 23505 → 409
   `handle_conflict` via a typed error the route maps), `ProductDetail.handle`, editor loader VM
   exposes `handle`. Unit tests.
3. **SEO write path** — product save payload `seo?: {metaTitle?, metaDescription?}` validation
   (`invalid_seo`), `$id` action + create action call `upsertSeoOverride`/`deleteSeoOverride`;
   `$id` loader returns `{ seoOverride, seoDefaults }` (defaults via `buildProductDraft` +
   `getStoreSettings` + `storefrontOrigin`). Unit tests.
4. **Storefront 301** — `storefront.products.$handle.tsx` miss path checks
   `product_handle_redirect`, 301 to current handle when target still active; tests.
5. **Editor UI** — "Search listing" card in `ProductEditor.tsx` (handle input with origin prefix +
   redirect helper text, meta title 60-counter, meta description 160-counter, search-result-style
   live preview using override||default); `ProductDraft.handle?/seo?` in
   `app/lib/dashboard/client.ts`; wire into the single existing save. Any new CSS via
   `calc(Npx * var(--type-scale))`.
6. **Gate** — typecheck, lint, build (verify-client-bundle), full vitest. 8-angle /code-review.
7. **Prod migration + live verify** (orchestrator): handle rename → old URL 301; meta override →
   PDP view-source; clear → defaults return; 390px editor card.
8. **Merge** — rebase onto latest origin/main immediately before push (feat/purchase-orders may
   land first); PR; manual merge; remove worktree.

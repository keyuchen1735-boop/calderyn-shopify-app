# Search: SEO & AIO tool for Calderyn merchants (design spec)

Date: 2026-07-06
Status: Approved (design). Ready for implementation planning.
Branch/worktree: `feat/seo-aio` at `../calderyn-seo-aio`.

## Plain-language summary

A one-tab **Search** tool in the Calderyn dashboard that makes a merchant's storefront
easy to find, both on search engines (SEO) and on AI assistants (AIO).

- **SEO** = show up when someone searches Google / Bing.
- **AIO** = show up when someone asks an AI assistant (ChatGPT, Perplexity, Claude, Google AI Overviews).

The app auto-writes every piece of the hidden metadata that search engines and AI crawlers
read, the merchant reviews/edits it in one screen, the storefront serves it, every page gets
a health score, and a Google Search Console connection feeds real ranking data back so pages
that slip get rewritten.

North star: the Amboras "AI SEO" feature, referenced in-repo at
`docs/design/amboras-reference/pages/www_amboras_com_ai_seo.md` (pillars: Written, Validated, Ranked).

## Decisions locked in the brainstorm

1. **Posture: Hybrid.** The agent drafts everything automatically; the merchant reviews and can edit.
2. **Scope: full parity**, including the Google Search Console ranking loop. Built in phases (on-platform core first; the Search Console loop layers on, since it only shows data once Google has indexed the store).
3. **AIO measurement: AI-crawler detection.** There is no "AI Console" equivalent, so we measure what we actually can: when known AI crawlers (GPTBot, PerplexityBot, ClaudeBot, OAI-SearchBot, Google-Extended, CCBot) hit the store's pages, read from our own server logs.
4. **Architecture: a dedicated `seo` subsystem** (its own `app/lib/seo/` module and tables), mirroring how Autopilot is structured, so the product model stays clean and every pillar has one home.

## Current state (what exists today)

- Storefront routes: `app/routes/storefront.*` (public, SSR, multi-tenant, no Postgres RLS; reads scoped by `resolveStorefrontShop(request)`). Demo shop uses an in-memory fixture catalog.
- Meta today is bare: `<title>`, `meta description`, `og:title` only (see `storefront.tsx`, `storefront.products.$handle.tsx`).
- Missing entirely: `sitemap.xml`, `robots.txt`, `llms.txt`, JSON-LD structured data, `canonical`, `og:image`, Twitter card, per-image alt overrides.
- Product model (`app/lib/storefront/catalog.ts` `StoreProduct`): `id, handle, title, description, images[{url, alt}], variants[{sku, title, priceCents, currency, available}], collections[]`.
- Storebuilder can render a PDP from a published block document; otherwise legacy PDP markup renders.
- New dashboard screens must plug into the session screen-cache (seed + write-through + a `WARM_TARGETS` entry) per `app/lib/dashboard/screen-cache.ts` / `prefetch.ts`.
- Existing Google OAuth infrastructure exists for sign-in and Google Ads; reuse it (add the Search Console scope) rather than standing up a second Google app.

## What "SEO & AIO" concretely produces (the deliverables)

Technical SEO (per page):
- `<title>`, meta description, `canonical`, Open Graph (`og:title/description/image/url/type`), Twitter card.
- JSON-LD structured data: `Product` + `Offer` (+ `AggregateRating`/`Review` when reviews exist) + `BreadcrumbList` on product pages; `Organization` + `WebSite` on the home page; `CollectionPage` on collections.
- Alt text on every product image.
- Site-wide: per-tenant `/sitemap.xml` (home + products + collections) and `/robots.txt` (allow crawlers, link the sitemap), clean semantic heading structure on the storefront.

AIO-specific (on top of the shared plumbing):
- Per-tenant `/llms.txt` (the emerging machine-readable-store convention): a plain-text summary of the store plus its key products and facts (price, availability, materials, shipping, returns), served at the site root.
- FAQ / Q&A content + `FAQPage` JSON-LD, because answer engines lift clean question/answer facts directly.
- A merchant toggle for AI crawler access in `robots.txt`, separating "allow answer-citation crawlers" from "allow training crawlers" so a merchant can opt into being cited while opting out of training.
- Machine-readable product facts embedded so answer engines quote price/availability correctly.

## Data model (new tables, Supabase, shop-scoped, RLS)

All tables carry `shop_id uuid` and RLS policies (follow the tenant-isolation pattern from the
Step 10 RLS work). Any secret (Search Console refresh token) is encrypted at rest.

- `seo_page` — one row per optimizable entity.
  - `id, shop_id, entity_type ('product'|'collection'|'home'), entity_id, url_path,`
  - `meta_title, meta_description, canonical_url, og_image_url, jsonld jsonb, alt_overrides jsonb,`
  - `focus_keyword, faq jsonb, source ('agent'|'merchant'), status ('draft'|'published'),`
  - `health_score int, health_breakdown jsonb, updated_at, updated_by`
  - Unique `(shop_id, entity_type, entity_id)`.
- `seo_ranking` — Search Console rows (phase 2).
  - `id, shop_id, seo_page_id, query, page_url, position numeric, impressions int, clicks int, ctr numeric, captured_date date, source ('search_console')`
  - Unique `(shop_id, query, page_url, captured_date)` for idempotent daily upserts.
- `seo_settings` — per-shop config.
  - `shop_id (PK), gsc_connected bool, gsc_site_url, gsc_refresh_token (encrypted),`
  - `allow_ai_crawlers bool default true, allow_ai_training bool default false,`
  - `org_jsonld jsonb, auto_write bool default true, auto_rewrite_on_slip bool default true`
- `seo_ai_crawl_daily` — AIO signal, aggregated.
  - `shop_id, bot_name, day date, hits int` with unique `(shop_id, bot_name, day)`; incremented from storefront request logging.

## Modules (`app/lib/seo/`, server-only)

- `writer.server.ts` — from a `StoreProduct` (or collection/home context) produce a `SeoDraft` (meta title/description, canonical, og image pick, JSON-LD, per-image alt, FAQ). **Deterministic template first**; optional Claude enhancement with a graceful fallback (follow the deterministic-first + API-error-fallback pattern already used in the engine). No Claude dependency on the hot path.
- `validator.server.ts` — validate a draft: required schema.org fields present and well-typed for the entity, title/description within length bounds, canonical is an absolute same-origin URL. Returns `issues[]`. **Invalid JSON-LD is never published or served.**
- `score.server.ts` — compute `health_score` (0..100) and a pass/fail `health_breakdown` from a fixed rubric (title present + length, description present + length, canonical, og image, JSON-LD valid, alt-text coverage, FAQ present, AI crawlers allowed, `llms.txt` present). Each failed check carries a short fix hint.
- `render.server.ts` — given a `seo_page` (or an on-the-fly draft for the demo shop), produce the Remix `meta[]` array plus the JSON-LD `<script type="application/ld+json">` payload for storefront routes.
- `keywords.server.ts` — infer target keyword(s) from a product (category/attributes/title) when no Search Console data exists; once connected, prefer the real winning query from `seo_ranking`.
- `search-console.server.ts` (phase 2) — OAuth connect, site-ownership verification, fetch Search Analytics (queries, positions, impressions, clicks), upsert `seo_ranking`.
- `crawl-detect.server.ts` — classify a request `User-Agent` as a known AI bot and record a daily hit; also used by `robots.txt` policy.

Types shared via `app/lib/seo/types.ts` (`SeoDraft`, `SeoIssue`, `HealthBreakdown`, `RankingRow`).

## Storefront serving (`app/routes/storefront.*`)

- `storefront.products.$handle.tsx`: `meta()` pulls from `render.server` output (title, description, canonical, og:*, twitter). Inject `Product`/`Offer`/`BreadcrumbList` JSON-LD into the rendered output. Image `alt` uses `alt_overrides` when present.
- `storefront._index.tsx`: `Organization` + `WebSite` JSON-LD, meta from settings.
- `storefront.collections.$handle.tsx`: `CollectionPage` JSON-LD, meta.
- New public routes (per-tenant, resolved by `resolveStorefrontShop`):
  - `sitemap.xml` — home + all products + collections for the tenant.
  - `robots.txt` — allow standard crawlers; allow/deny AI crawlers per `seo_settings`; link the sitemap.
  - `llms.txt` — machine-readable store + top-products summary.
- AI-crawl logging: a storefront request hook classifies the UA (`crawl-detect`) and increments `seo_ai_crawl_daily` (fire-and-forget, never blocks the response).
- **Failure isolation**: a missing `seo_page` or any lookup hiccup falls back to generated-from-product defaults; SEO plumbing must never break a storefront render (matches the existing try/catch isolation in `storefront.tsx`).
- **Demo shop**: generate output on the fly from the fixture catalog; no DB writes.

## Dashboard screen (`app/components/dashboard/screens/Search.tsx`)

Route `app/routes/dashboard.search.tsx`: loader behind `requireDashboardSession(request)` returns the overview; action (behind `requireSameOrigin`) handles write / regenerate / publish / connect-GSC / toggle-settings / batch-backfill. Wire into the screen-cache (seed + write-through + `WARM_TARGETS`).

Overview:
- Store-wide **Health** score.
- **Google** card: clicks / impressions / top query from `seo_ranking`. Pre-connect empty state with a "Connect Google" button.
- **AI assistants** card: AI-bot visit counts from `seo_ai_crawl_daily`, with the bot names seen.
- **Pages that need a look**: lowest-health and slipping pages, each with a `[Fix it]` action.

Per-product detail:
- **Google preview** (rendered SERP snippet from the stored meta).
- **AI preview** (how the page reads to an assistant: the `llms.txt` line + a plain summary of the JSON-LD facts).
- **Health breakdown** (pass/fail rows with fix hints).
- `[Let the app write it]` (regenerate via `writer` -> `validator` -> save) and `[Edit myself]` (inline fields with live character counters and a live preview). Publish is gated on validation passing.

Settings:
- Connect Google Search Console; AI crawler allow/deny toggles (citation vs training); auto-write and auto-rewrite-on-slip toggles; Organization info (name/logo) for the `Organization` schema.

## Agent write triggers (hybrid)

- **On product create/update**: hook the new-product-flow save and the product editor save to enqueue `writer -> validator -> seo_page`. Saved as `draft` unless `seo_settings.auto_write` (default on), in which case validated output auto-publishes. Deterministic writer runs inline; Claude enhancement is optional/async.
- **On demand**: `[Let the app write it]` on the Search screen.
- **Batch backfill**: a one-time "optimize my whole catalog" action for existing products.

## Search Console loop (phase 2, in scope)

- **Connect**: Google OAuth with `webmasters.readonly`. Reuse the existing Google OAuth app/credentials (add the scope; tie to the in-flight Google OAuth verification work). Verify site ownership via a meta tag Calderyn injects site-wide (falls back to DNS TXT for custom domains).
- **Cron**: a daily `app/routes/cron.*` route (Bearer `CRON_SECRET`, matching the existing cron pattern) pulls Search Analytics per connected shop and upserts `seo_ranking` idempotently on `(shop_id, query, page_url, captured_date)`.
- **Auto-rewrite**: when a page's best query slips past a position threshold over N days and `auto_rewrite_on_slip` is on, re-run the writer with the real query as the focus keyword, re-validate, publish, and log it to a "recent rewrites" timeline shown on the screen.

## Error handling

- Validator gates publishing and serving; invalid schema never ships.
- External calls (Search Console, Claude) surface errors in the dashboard and never swallow payloads; both fall back to the deterministic writer / cached data.
- Public SEO files (`sitemap`/`robots`/`llms`) are cached and generation is bounded so a large catalog cannot blow up a request.

## Testing

- Unit: writer output shape; validator rejects malformed schema; score rubric; keyword inference; UA classification; per-tenant sitemap/robots/llms generation.
- Integration: PDP emits valid `Product` JSON-LD (assert against schema.org required fields), meta sourced from `seo_page`, canonical correct; demo-shop path renders with generated defaults and no DB writes.
- Multi-tenant isolation: `seo_*` reads scoped by `shop_id`; an RLS self-test in the Step 10 style.
- Dashboard: loader returns the overview; write action persists and rescores; publish blocks on validation failure.
- Search Console (mocked): Search Analytics response upserts `seo_ranking`; slip detection triggers a rewrite.

## Build order (phased)

Phase 1 (on-platform core, ships value with no external dependency):
1. Migration: `seo_page`, `seo_settings`, `seo_ai_crawl_daily` + RLS.
2. `app/lib/seo`: `writer` + `validator` + `score` + `render` + `keywords` + `crawl-detect` + `types`.
3. Storefront serving: PDP/collection/home meta + JSON-LD; `sitemap.xml`, `robots.txt`, `llms.txt`; AI-crawl logging.
4. Dashboard **Search** screen (overview + per-product review/edit + settings) + screen-cache wiring.
5. Agent write triggers (on product save + on-demand + batch backfill).

Phase 2 (rankings loop):
6. `seo_ranking` migration; Google OAuth scope + site verification; connect flow.
7. Daily cron pull -> `seo_ranking`; Google card populated.
8. Auto-rewrite-on-slip + recent-rewrites timeline.

## Out of scope (v1)

- Bing Webmaster Tools and other engines' consoles.
- Backlink / competitor analysis.
- Multi-language / `hreflang` (revisit if/when the storefront is multi-locale).
- General content marketing / blog generation beyond product, collection, and FAQ content.

## Open items to settle during planning

- Exact reuse of the existing Google OAuth app vs added verified scopes (tie to the Google OAuth verification prep already underway).
- Default auto-publish vs draft-for-review (recommend auto-publish under `auto_write`, with a per-shop toggle).
- `llms.txt` serving location (recommend site root `/llms.txt`).

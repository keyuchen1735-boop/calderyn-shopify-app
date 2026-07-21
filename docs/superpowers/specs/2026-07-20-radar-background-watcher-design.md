# Radar: background watcher + morning moves queue (design spec)

Date: 2026-07-20
Status: Approved (design) via delegated review. Ready for implementation planning.
Branch/worktree: `feat/radar` at `../calderyn-radar`.

## Plain-language summary

Radar runs in the background for every shop: overnight it watches storefront traffic,
Google rankings, AI-assistant visibility (AEO), and competitor sites. When something
changes that's worth acting on, it drafts a response ahead of time. Most mornings the
merchant opens the dashboard to a short list of **moves** already drafted and waiting:
an SEO regression to patch, a competitor change to counter, a stale page section to
refresh. Each move shows plain-language evidence and applies with one click. Nothing
touches the live store without that click.

Naming: **"Radar"** is the screen name; drafted items are **"moves"** in all
merchant-facing copy. The internal noun `ploy` may appear in code identifiers only,
never in merchant-visible strings, client bundles, or DOM attributes.

## Decisions locked in the brainstorm (delegated review 2026-07-20)

1. **One big design**, built in phases A-D below.
2. **Draft + one-click apply.** Every move arrives fully evidenced; risky content is
   generated at apply time through existing validated pipelines.
3. **Competitors are auto-discovered** (Claude web_search server tool, seeded from the
   shop's products/category), surfaced as suggestions; nothing is watched until the
   merchant confirms.
4. **Surface:** new Radar dashboard screen + a dismissible Home "moves ready" card.
5. **Architecture:** dedicated `app/lib/radar/` subsystem mirroring Autopilot's shape.
   The approved SEO & AIO spec (`2026-07-06-seo-aio-search-tool-design.md`) is built
   first, in full (including its Search screen), as the rankings/AEO data foundation.
6. **Pricing moves are informational only** (evidence + deep link; no one-click price
   change).
7. **Counter-page route deferred.** Phase D counter moves modify existing pages (home
   hero, PDP copy, collection copy). A future `storefront.pages.$handle` route can ship
   separately (the `PageKey` type already supports `page:${string}`).

## Current state (verified in-repo)

- `storefront_event` records per-shop `page_view` / `cart_add` / `checkout_start` /
  `checkout_complete` with path, session/visitor ids, and coarse geo
  (`app/lib/storefront/events.server.ts`). Bot UAs are excluded.
- Two storefront edit runtimes coexist and both must be respected:
  - Legacy block documents: `page_document` via
    `app/lib/storebuilder/page-document.server.ts` (`saveDraft`/`publishDoc`,
    validator-gated by callers) and `app/lib/storebuilder/studio.server.ts` section ops.
  - Runtime 1 compiled releases: `app/lib/storefront-edit/edit.server.ts`
    (`editStorefrontByPrompt`: intent parse -> quota -> patch -> validate -> save draft)
    and `app/lib/storefront-bundle/release.server.ts`
    (`publishStorefrontRelease` with optimistic version checks, `rollbackStorefrontRelease`).
- AI quota gate exists: `app/lib/ai-quota.server.ts` (`checkAiQuota`; the check records
  a hit, so it is called immediately before actual spend). Radar adds a `"radar"`
  `AiFeature`.
- Shared Anthropic client: `app/lib/assistant/anthropic.server.ts` (`getAnthropic()`,
  env-overridable model pickers; no literal model ids outside that file). No code uses
  the web_search server tool yet; Radar's competitor discovery is its first use.
- Home cards follow the journey-card pattern: own API route
  (loader = data + dismissed flag, action = dismiss intent), client type mirrors the
  server interface, `Card`/`Btn`/`CDIcon` primitives
  (`app/components/dashboard/screens/Dashboard.tsx`, `HomeJourney.tsx`).
- Resumable cron drain pattern to copy: `app/routes/cron.import.tsx`.
- PostgREST clamps responses at 1000 rows; aggregations go through SQL RPCs.
- The SEO & AIO spec is approved but unbuilt; its `seo_ranking` and
  `seo_ai_crawl_daily` tables are Radar's rankings/AEO sources.

## Data model (new tables; Supabase, shop-scoped, RLS per Step-10 pattern)

- `radar_competitor`
  - `id, shop_id, url, name, status ('suggested'|'watching'|'dismissed'),`
  - `discovery_evidence jsonb, created_at, updated_at`
  - Unique `(shop_id, url)`. Max 5 in `watching` per shop (enforced in the action).
- `radar_snapshot`
  - `id, shop_id, competitor_id, url, captured_at, content_hash,`
  - `extracted jsonb` (title, headings, price points, product names; bounded),
  - `diff jsonb` (vs previous snapshot; null when unchanged)
  - Fetches respect robots.txt, honest UA, 5s timeout, ~1 MB response cap,
    max ~10 pages per competitor per night.
- `radar_traffic_daily`
  - `shop_id, day date, views int, sessions int, cart_adds int, checkouts int,`
  - `top_paths jsonb` — unique `(shop_id, day)`; filled by a SQL RPC that aggregates
    `storefront_event` server-side (never row-fetched through PostgREST).
- `radar_ploy` (merchant-facing label: move)
  - `id, shop_id, kind, status ('draft'|'applied'|'dismissed'|'expired'),`
  - `headline text, rationale text, evidence jsonb, payload jsonb,`
  - `dedup_key text, prior_state jsonb, applied_state_hash text,`
  - `created_at, applied_at, resolved_at, expires_at`
  - **Partial unique index** on `(shop_id, kind, dedup_key) WHERE status = 'draft'`
    (a dismissed row must not block the move forever). Cooldown rule in the drafter:
    never re-draft a `dedup_key` within 30 days of a dismissal or 14 days of expiry.
  - Moves expire 14 days after creation (`expires_at`), swept by the drafter cron.

## Modules (`app/lib/radar/`, server-only)

- `types.ts` — `RadarMove`, `MoveKind`, `Evidence`, `CompetitorDiff`, DTO shapes.
- `collect.server.ts` — per-shop collection step: traffic rollup RPC, competitor
  snapshot + diff (hash first; extraction only when the hash changed). Rankings and
  AEO signals are read from the seo subsystem's tables; no duplication.
- `detect.server.ts` — deterministic, pure-function detectors over the collected
  tables. Each detector returns candidate moves with `dedup_key` + evidence. No
  Claude calls here.
- `draft.server.ts` — turns candidates into `radar_ploy` rows. Claude writes only
  merchant-facing content (headline polish, brief, preview copy), quota-gated
  (`"radar"` feature, cap 5 calls/shop/night), deterministic template fallback.
  Applies the dedup/cooldown rules and the expiry sweep.
- `apply.server.ts` — executes a move by kind (see Apply machinery); records
  `prior_state` and `applied_state_hash`; revert support.
- `discovery.server.ts` — weekly competitor auto-discovery via Claude web_search,
  seeded from the shop's top products + category; writes `suggested` rows only.
- `snapshot.server.ts` — polite fetcher + fact extractor (hash-gated Claude use).

## Crons (Bearer `CRON_SECRET`, idempotent, per-shop failure isolation)

- `cron.radar-collect` — nightly. **Resumable batch pattern from day one** (per-shop
  cursor, same shape as `cron.import`) so the run never exceeds serverless timeouts;
  a failed shop logs and never halts the drain.
- `cron.radar-draft` — nightly, after collect: detect -> draft -> expire sweep.
- `cron.radar-discover` — weekly competitor discovery for shops with a published
  storefront and fewer than 5 watched competitors.
- Idempotency: collect upserts on natural keys `(shop_id, day)` /
  `(competitor_id, captured_at::date)`; draft dedups via the partial unique index.

## Detectors -> move kinds

Default thresholds (constants in `detect.server.ts`, tunable): ranking slip = best
query down 3+ positions sustained 3 days; CTR-low = position <= 10 with CTR under half
the position's expected rate; traffic drop = top-10 page down 30%+ vs its trailing
7-day average; conversion gap = 50+ views with cart-add rate under 1%; stale section =
unchanged 6+ weeks with declining views.

Rankings (from `seo_ranking`, phase B onward):
- Position slip past threshold over N days -> `seo_regression_patch`: rewritten
  meta/FAQ via the seo writer with the real query as focus keyword; validator-gated;
  apply publishes to `seo_page`.
- Impressions healthy but CTR low -> meta rewrite move.
- Rising query at position 8-20 -> content-boost move (FAQ/section targeting it).

AEO (from `seo_ai_crawl_daily`):
- AI-crawler hits dropped or zero while crawlers are allowed -> refresh `llms.txt` +
  FAQ JSON-LD move.
- Crawlers hitting pages with missing/invalid JSON-LD -> fix move.

Traffic (from `radar_traffic_daily`):
- Top-page views down vs trailing 7-day baseline -> page refresh move, with ranking
  evidence correlated when available.
- High views + low cart-adds on a product -> PDP section refresh move.
- Section unchanged for N weeks with declining engagement -> stale-section refresh.

Competitors (from `radar_snapshot` diffs):
- New page/product in the merchant's category -> counter move (strengthen own home
  hero / PDP / collection copy; new-page counters deferred with the pages route).
- Price move on a comparable product -> **informational move**: evidence + deep link
  to the merchant's pricing; no auto-apply.
- Positioning/copy change -> refresh own hero/section copy move.

## Apply machinery

Dashboard action behind `requireDashboardSession` + `requireSameOrigin`
(`dashboard.api.radar` route; `dashboardJson`/`jsonError` helpers). By kind:

- SEO moves: update + publish `seo_page` through the seo writer/validator; invalid
  output never publishes. `prior_state` stores the previous meta for one-click revert.
- Section-refresh moves: **apply-time generation.** Overnight the move stores only the
  brief + preview copy; Apply runs the existing edit pipeline for the shop's runtime
  (legacy: studio section ops -> `saveDraft` -> validate -> `publishDoc`; runtime 1:
  `editStorefrontByPrompt` -> `publishStorefrontRelease` with version checks) and the
  merchant sees a few seconds of progress. This avoids draft-slot collisions with
  merchant edits, and Claude generation spend happens only for moves actually applied.
- Informational moves: `Review` deep link; applying just resolves the move.
- Revert: runtime-1 sections use `rollbackStorefrontRelease`; legacy sections store the
  prior doc json in `prior_state` **with a staleness guard** — before reverting, hash
  the live doc and compare to `applied_state_hash`; on mismatch (merchant edited since)
  require an explicit confirm instead of silently clobbering.
- Failures surface the upstream error on the move card and keep it in `draft`.

## Dashboard UI

`app/routes/dashboard.radar.tsx` + `app/components/dashboard/screens/Radar.tsx`
(cd-* primitives, CDIcon, GSAP where motion helps; screen-cache seed + write-through +
`WARM_TARGETS` entry — mandatory).

- **Moves queue** (default tab): cards with headline, plain rationale ("Your 'trail
  boots' page slipped from #4 to #9 on Google this week"), evidence chips,
  before/after preview where applicable, `Apply` / `Dismiss`. Empty state explains
  what Radar watches and links to setup (connect Google, confirm competitors).
- **Signals strip**: four tiles (Traffic, Google, AI assistants, Competitors) with
  last-checked time and a small trend figure each.
- **Competitors tab**: suggested list (Confirm / Dismiss), watching list with a recent
  changes timeline.
- **History tab**: applied/dismissed moves with revert where supported.
- **Home card**: "3 moves ready" mirroring the journey-card pattern (own API route
  `dashboard.api.radar-home`, dismiss intent persisted server-side); hidden at zero.

## Cost controls

- `"radar"` `AiFeature` in `ai-quota.server.ts`; drafting capped at **5 Claude
  calls/shop/night**; `checkAiQuota` called immediately before each spend.
- Snapshot extraction is hash-gated: unchanged pages cost zero Claude.
- Discovery weekly, not nightly; snapshots are plain fetches (no Claude unless the
  hash changed).
- Apply-time generation means unapplied section moves never pay full generation.
- Deterministic templates are the fallback for every Claude call site.

## Error handling

- Collectors: per-shop try/catch inside the drain; upstream payloads logged and
  surfaced on the Signals strip ("Google data is behind"), never swallowed.
- External fetches: 5s timeout, ~1 MB cap, robots.txt respected, honest UA; a
  blocked/failed competitor page marks the snapshot failed and moves on.
- Apply: validator/publish failures return the real error to the card; no partial
  publishes; the move stays draft.
- Storefront serving is untouched by Radar reads/writes except through the existing
  validated pipelines.

## Testing

- Unit: each detector as a pure function over fixture rows (slip, CTR, baseline drop,
  conversion gap, staleness, diff kinds); dedup + cooldown logic; expiry sweep;
  snapshot hashing + extraction bounds; robots/UA/timeout behavior (mocked fetch);
  quota-cap enforcement.
- Integration: collect->draft produces stable moves idempotently across re-runs;
  apply per kind against both runtimes (mocked publish); revert staleness guard
  (clean revert vs confirm-on-mismatch); RLS self-test on all four tables.
- Dashboard: loader DTO shape; apply/dismiss actions; Home card count + dismissal.

## Build order (phases; each phase is a PR passing the full pre-commit gate)

- **Phase A** — SEO & AIO spec phase 1, in full, as approved (tables, `app/lib/seo`
  writer/validator/score/render/keywords/crawl-detect, storefront meta + JSON-LD +
  sitemap/robots/llms, Search screen + cache wiring, write triggers).
- **Phase B** — SEO & AIO phase 2: GSC OAuth connect + site verification, daily
  ranking cron -> `seo_ranking`, Google card, auto-rewrite-on-slip.
- **Phase C** — Radar core: 4 tables + RLS, traffic rollup RPC, rankings/AEO/traffic
  detectors, drafter with dedup/cooldown/expiry, `cron.radar-collect` (resumable) +
  `cron.radar-draft`, apply for seo + section kinds (both runtimes) with revert,
  Radar screen + Home card + cache wiring.
- **Phase D** — Competitors: `cron.radar-discover` (web_search), snapshot fetcher +
  hash-gated extraction + diffs, competitor detectors + counter/informational moves,
  Competitors tab + Signals tile.

## Out of scope (v1)

- New standalone storefront pages (`storefront.pages.$handle`) — future feature.
- One-click price changes from competitor evidence.
- Bing/other consoles; backlink analysis; multi-language.
- Push/email delivery of the morning list (dashboard + Home card only).

## Delegated review log (2026-07-20)

Reviewed and approved-with-changes by a delegated reviewer acting for John. Required
changes incorporated above: (1) partial unique dedup index + dismissal/expiry
cooldowns, (2) legacy revert staleness hash guard, (3) resumable cron checkpointing
from day one, (4) 5-call nightly Claude cap + hash-gated extraction + ~1 MB fetch cap,
(5) "ploy" excluded from all merchant-visible surfaces.

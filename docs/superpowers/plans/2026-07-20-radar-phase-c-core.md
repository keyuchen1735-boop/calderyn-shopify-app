# Radar Phase C: core watcher, drafter, apply + Radar screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Radar runs nightly for every shop: it rolls up storefront traffic, reads the Phase B rankings + AEO tables, detects problems with deterministic detectors, and drafts plain-language **moves** a merchant applies with one click the next morning. Ships: `radar_traffic_daily` + `radar_ploy` (+ a small `radar_state` cursor table) with RLS, a traffic rollup RPC, rankings/AEO/traffic detectors, a drafter with dedup/cooldown/expiry, resumable `cron.radar-collect` + `cron.radar-draft`, apply for SEO and section-refresh move kinds on both storefront runtimes with revert, and the Radar dashboard screen + Home "moves ready" card with screen-cache wiring. Spec: `docs/superpowers/specs/2026-07-20-radar-background-watcher-design.md`, Phase C.

**Architecture:** New server subsystem `app/lib/radar/` (types, detect, collect, store, draft, apply-seo, apply-section, apply). Detectors are pure functions over rows with named threshold constants; no Claude calls in detection. Claude appears in exactly two places, both quota-gated by a new `"radar"` `AiFeature`: overnight copy polish in the drafter (capped 5 calls/shop/night, deterministic template fallback) and apply-time section-copy generation (merchant-initiated; failures surface, never silently template into a live store). Aggregations go through SQL RPCs (PostgREST clamps at 1000 rows). The crons mirror `cron.seo-rankings` (this branch's Phase B): per-shop cursor ordering with nulls first + a 50s time budget, per-shop failure isolation, idempotent upserts on natural keys - that IS the resumable pattern from `cron.import`'s drain, specialized to a nightly per-shop sweep.

**Grounded corrections to the spec's named symbols** (verified in-repo; bind to these, not the spec's names):
- Runtime 1 edits go through `runStoreCommand` (`app/lib/storefront-command/command.server.ts:462`) with `{ kind: "prompt" | "publish" }` commands; there is no `editStorefrontByPrompt`. Revert uses `rollbackStorefrontRelease` (`app/lib/storefront-bundle/release.server.ts:298`).
- Legacy (runtime 0) edits go through `loadPublishedDoc`/`loadDraftDoc`/`saveDraft`/`publishDoc` (`app/lib/storebuilder/page-document.server.ts`) + `validateDocument` (`app/lib/storebuilder/validate.ts`); there is no `regenerateStudioSection`. `saveDraft` sanitizes rawHtml; `publishDoc` requires the caller to validate first.
- Runtime detection: `readStorefrontReleaseState` (`app/lib/storefront-bundle/build.server.ts:53`) - `publishedRuntimeVersion === 1` means runtime 1, otherwise the legacy block-document path.

**Honesty narrowings** (each grounded in what `app/lib/seo` actually serves today):
1. **SEO applies publish product-page overrides only.** The serve path reads `seo_page` overrides solely for products (`app/routes/storefront.products.$handle.tsx:74`); home/collection overrides exist in the table but nothing reads them at serve time. So `seo_regression_patch` / meta-rewrite / content-boost moves on product pages are one-click publishes (`upsertSeoOverride`, validator-gated); the same detections on home/collection pages draft as **review moves** (evidence + deep link, applying marks them done).
2. **Content boost = meta targeting.** There is no merchant FAQ storage; JSON-LD/FAQ are generated at serve time. A rising-query boost rewrites the product's meta title/description to target the query - the plan says exactly that in the move copy.
3. **AEO refresh = ensure the store description.** `llms.txt`, robots and org JSON-LD are served dynamically (`app/lib/seo/site-files.server.ts`, `writer.server.ts`); there is nothing to "regenerate". When AI-crawler hits go quiet while crawlers are allowed, the apply fills a missing `seo_settings.org_description` with the deterministic `buildStoreDescription` composition (the same one Preferences suggests). If the description already exists, the move drafts as a review move pointing at Preferences.
4. **JSON-LD fix moves are review moves.** Invalid product JSON-LD (found by running the real writer + validator over top-viewed products) means real product data is missing (price, availability). Radar must not invent it, so the move deep-links the product editor.
5. **SEO meta applies are fully deterministic** (writer building blocks + validator bounds) - "through existing validated pipelines" per the spec, zero Claude spend.

**Deliberate design choices to justify once:**
- **`radar_state` table** (`shop_id` PK, `last_collected_at`, `last_drafted_at`, `home_card_dismissed_at`): the per-shop cron cursors and the Home-card dismissal live in a Radar-owned table instead of columns on `shops` - `shops` is a core table many features touch, and Phase B set the precedent of feature-owned state (`seo_settings.gsc_last_pulled_at`). Nulls-first ordering on the cursor gives never-processed shops priority, so a budget-limited run never starves the tail.
- **Reverting a move marks it `dismissed`** with `payload.reverted = true` (the check constraint has four statuses; a reverted move is no longer active, and History labels it "Reverted").
- **Applied moves cool down 14 days** on the same dedup key (spec specifies dismissal/expiry cooldowns only; without an apply cooldown the same fixed page would re-draft the next night off lagged data).

**Tech Stack:** Remix 2.16.7 (pinned), TypeScript strict, Supabase (service-role via `getSupabase()`), vitest, `@anthropic-ai/sdk` via `getAnthropic()`, existing `cd-*` dashboard primitives.

## Global Constraints

- All `@remix-run/*` stay pinned exact 2.16.7; no new top-level dependencies.
- `.server.ts` files never imported from client modules; loaders shape DTOs field-by-field, never spread raw rows to the client.
- Every dashboard route: `requireDashboardSession(request)`; writes also `requireSameOrigin(request)` before anything else.
- **Naming:** the internal noun `ploy` appears only in code/table identifiers (`radar_ploy`). It must never appear in merchant-visible strings, client bundles, DOM attributes, VM field names, or Claude-generated copy (the drafter rejects output containing it). Merchant-facing word is **"moves"**. Plain language everywhere: "Google results" not SERP, "AI assistants" not AEO/crawlers, "page views" not sessions/impressions jargon in UI copy.
- No literal Anthropic model ids outside `app/lib/assistant/anthropic.server.ts`; Radar uses a new `radarDraftModel()` picker there.
- `checkAiQuota({ shopId, feature: "radar", trusted })` is called immediately before **each** Claude request (the check records a hit). The drafter additionally hard-caps its own loop at `RADAR_NIGHTLY_CLAUDE_CAP = 5`, so quota-bypassed shops (dev) still cannot overspend.
- Migrations: `supabase/migrations/YYYYMMDDHHMMSS_name.sql`, shop-scoped RLS + self-test do-blocks (copy the style of `20260706194500_seo_page_settings.sql`; deny-all commentary style of `20260707120000_seo_search_console.sql`), applied to prod (`ajgrmnvzxfxxlwrxcgnu`) via the supabase MCP.
- Cron auth: `isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)` from `~/lib/cron-auth.server`, fail-closed; crons registered in `vercel.json` `"crons"`.
- Every aggregate read goes through an RPC; direct PostgREST reads only where the row count is provably bounded (35 traffic days, 28 crawl days x 13 bots, 50 moves).
- Upstream errors (Supabase, store-command pipeline, publish) are surfaced with their payloads - on the move card for applies, in cron logs for collectors - never swallowed.
- Tests: vitest, co-located `__tests__` dirs, ALL imports at top of file (import/first), `vi.hoisted` spies + `vi.mock` blocks after imports (mirror `app/routes/__tests__/dashboard.api.search.test.ts`).
- Pre-commit gate before any commit: `npm run typecheck`, `npm run lint`, `npm run build`, `npx vitest run` for touched suites; full gate in the final task.

---

### Task 1: Migration - Radar tables, RLS, RPCs

**Files:**
- Create: `supabase/migrations/20260720130000_radar_core.sql`

**Interfaces:**
- Produces tables `radar_traffic_daily`, `radar_ploy`, `radar_state` and RPCs:
  - `radar_rollup_traffic(p_shop uuid, p_days int default 10) returns int` - server-side aggregation of `storefront_event` into `radar_traffic_daily`, idempotent upsert on `(shop_id, day)`.
  - `read_radar_ranking_series(p_shop uuid) returns jsonb` - top 50 `(page_url, query)` pairs by 28-day impressions with 14-day daily series (bounded payload for the TS detectors).
  - `radar_shop_queue(p_for text, p_limit int default 500) returns table (shop_id uuid)` - drain queue ordered by the matching `radar_state` cursor, nulls first; only shops with any Radar-relevant signal (recent storefront events, GSC connected, or recent AI-crawler hits).
- Phase D's `radar_competitor` / `radar_snapshot` are deliberately NOT in this migration.

- [ ] **Step 1: Write the migration**

```sql
-- Radar Phase C core (spec 2026-07-20-radar-background-watcher-design.md).
--  1. radar_traffic_daily: per-shop daily rollup of storefront_event, filled by
--     radar_rollup_traffic so the dashboard/detectors never row-fetch events
--     through PostgREST (1000-row clamp).
--  2. radar_ploy: drafted moves (merchant-facing label: "move"; the noun "ploy"
--     exists only in identifiers, never UI strings). Partial unique index keeps
--     one OPEN draft per (shop, kind, dedup_key) while letting dismissed rows
--     age out instead of blocking the move forever.
--  3. radar_state: radar-owned per-shop cron cursors + Home-card dismissal.
--     Server-only (no app_web grant): nothing browser-reachable needs it.
-- All three follow the storefront-facing tenant convention: self-contained RLS
-- via public.current_shop_id(); intentionally NOT added to the frozen
-- app/lib/security/tenant-tables.ts census. Phase D adds radar_competitor /
-- radar_snapshot in its own migration.

create table if not exists public.radar_traffic_daily (
  shop_id    uuid not null references public.shops(id) on delete cascade,
  day        date not null,
  views      integer not null default 0,
  sessions   integer not null default 0,
  cart_adds  integer not null default 0,
  checkouts  integer not null default 0,
  top_paths  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (shop_id, day)
);

alter table public.radar_traffic_daily enable row level security;
drop policy if exists radar_traffic_daily_shop_scope on public.radar_traffic_daily;
create policy radar_traffic_daily_shop_scope on public.radar_traffic_daily
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_traffic_daily from anon, authenticated;
grant select on table public.radar_traffic_daily to app_web;

create table if not exists public.radar_ploy (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  kind               text not null check (kind in (
    'seo_regression_patch','seo_meta_rewrite','seo_content_boost',
    'aeo_refresh','aeo_jsonld_fix','section_refresh')),
  status             text not null default 'draft'
                     check (status in ('draft','applied','dismissed','expired')),
  headline           text not null,
  rationale          text not null,
  evidence           jsonb not null default '{}'::jsonb,
  payload            jsonb not null default '{}'::jsonb,
  dedup_key          text not null,
  prior_state        jsonb,
  applied_state_hash text,
  created_at         timestamptz not null default now(),
  applied_at         timestamptz,
  resolved_at        timestamptz,
  expires_at         timestamptz not null default now() + interval '14 days'
);

-- One OPEN draft per signal; a dismissed/expired row must not block re-drafting
-- forever (the drafter enforces the 30/14-day cooldowns in code).
create unique index if not exists radar_ploy_draft_dedup_idx
  on public.radar_ploy (shop_id, kind, dedup_key) where status = 'draft';
create index if not exists radar_ploy_shop_status_idx
  on public.radar_ploy (shop_id, status, created_at desc);

alter table public.radar_ploy enable row level security;
drop policy if exists radar_ploy_shop_scope on public.radar_ploy;
create policy radar_ploy_shop_scope on public.radar_ploy
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_ploy from anon, authenticated;
grant select on table public.radar_ploy to app_web;

create table if not exists public.radar_state (
  shop_id                uuid primary key references public.shops(id) on delete cascade,
  last_collected_at      timestamptz,
  last_drafted_at        timestamptz,
  home_card_dismissed_at timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.radar_state enable row level security;
drop policy if exists radar_state_shop_scope on public.radar_state;
create policy radar_state_shop_scope on public.radar_state
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_state from anon, authenticated;
-- Intentionally NO app_web grant: cron cursors + card dismissal are read and
-- written only by service-role server code.

-- Server-side traffic rollup. Idempotent upsert on (shop_id, day); re-running a
-- night re-covers the same window, so a killed cron tick loses nothing.
create or replace function public.radar_rollup_traffic(p_shop uuid, p_days int default 10)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  with days as (
    select generate_series(current_date - (p_days - 1), current_date, interval '1 day')::date as day
  ),
  ev as (
    select created_at::date as day, type, session_id, path, product_id
    from public.storefront_event
    where shop_id = p_shop
      and created_at >= (current_date - (p_days - 1))::timestamptz
  ),
  daily as (
    select d.day,
           count(*) filter (where e.type = 'page_view')         as views,
           count(distinct e.session_id)                          as sessions,
           count(*) filter (where e.type = 'cart_add')           as cart_adds,
           count(*) filter (where e.type = 'checkout_complete')  as checkouts
    from days d
    left join ev e on e.day = d.day
    group by d.day
  ),
  ranked_paths as (
    select e.day, e.path,
           count(*) filter (where e.type = 'page_view') as views,
           count(*) filter (where e.type = 'cart_add')  as cart_adds,
           max(e.product_id)                            as product_id,
           row_number() over (
             partition by e.day
             order by count(*) filter (where e.type = 'page_view') desc, e.path
           ) as rn
    from ev e
    group by e.day, e.path
  ),
  paths as (
    select day,
           jsonb_agg(jsonb_build_object(
             'path', path, 'views', views, 'cartAdds', cart_adds,
             'productId', product_id) order by views desc) as top_paths
    from ranked_paths
    where rn <= 20
    group by day
  ),
  up as (
    insert into public.radar_traffic_daily
      (shop_id, day, views, sessions, cart_adds, checkouts, top_paths, updated_at)
    select p_shop, d.day, d.views, d.sessions, d.cart_adds, d.checkouts,
           coalesce(p.top_paths, '[]'::jsonb), now()
    from daily d
    left join paths p on p.day = d.day
    on conflict (shop_id, day) do update
      set views = excluded.views, sessions = excluded.sessions,
          cart_adds = excluded.cart_adds, checkouts = excluded.checkouts,
          top_paths = excluded.top_paths, updated_at = now()
    returning 1
  )
  select count(*)::int from up;
$$;
revoke execute on function public.radar_rollup_traffic(uuid, int) from public, anon, authenticated;

-- Bounded ranking series for the TS detectors: top 50 (page,query) pairs by
-- 28-day impressions, each with its last-14-day daily points. seo_ranking can
-- hold 1000 rows/day, so this must aggregate server-side.
create or replace function public.read_radar_ranking_series(p_shop uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with recent as (
  select * from public.seo_ranking
  where shop_id = p_shop and captured_date >= current_date - 28
),
pairs as (
  select page_url, query, sum(impressions) as imp
  from recent
  group by page_url, query
  order by imp desc
  limit 50
),
series as (
  select r.page_url, r.query,
         jsonb_agg(jsonb_build_object(
           'day', to_char(r.captured_date, 'YYYY-MM-DD'),
           'position', round(r.position::numeric, 1),
           'impressions', r.impressions,
           'clicks', r.clicks,
           'ctr', round(r.ctr::numeric, 4)) order by r.captured_date) as days
  from recent r
  join pairs p on p.page_url = r.page_url and p.query = r.query
  where r.captured_date >= current_date - 14
  group by r.page_url, r.query
)
select coalesce(
  (select jsonb_agg(jsonb_build_object('pageUrl', page_url, 'query', query, 'days', days)) from series),
  '[]'::jsonb);
$$;
revoke execute on function public.read_radar_ranking_series(uuid) from public, anon, authenticated;

-- Drain queue with per-shop fairness: order by the matching radar_state cursor,
-- nulls (never-processed shops) first, so a budget-limited cron run leaves the
-- skipped shops at the FRONT of the next run (same fairness rule as
-- cron.seo-rankings' gsc_last_pulled_at ordering). Only shops with a Radar-
-- relevant signal are drained; a shop with no traffic, no GSC and no AI-crawler
-- hits has nothing to detect and would only burn the time budget.
create or replace function public.radar_shop_queue(p_for text, p_limit int default 500)
returns table (shop_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.shops s
  left join public.radar_state rs on rs.shop_id = s.id
  where exists (select 1 from public.storefront_event e
                where e.shop_id = s.id and e.created_at >= now() - interval '30 days')
     or exists (select 1 from public.seo_settings st
                where st.shop_id = s.id and st.gsc_connected)
     or exists (select 1 from public.seo_ai_crawl_daily c
                where c.shop_id = s.id and c.day >= current_date - 30)
  order by (case when p_for = 'draft' then rs.last_drafted_at else rs.last_collected_at end)
           asc nulls first,
           s.id
  limit p_limit;
$$;
revoke execute on function public.radar_shop_queue(text, int) from public, anon, authenticated;

-- Self-tests: fail the apply if any invariant is missing.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_traffic_daily' and rowsecurity = true) then
    raise exception 'radar_traffic_daily is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_ploy' and rowsecurity = true) then
    raise exception 'radar_ploy is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_state' and rowsecurity = true) then
    raise exception 'radar_state is missing RLS';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'radar_ploy_draft_dedup_idx') then
    raise exception 'radar_ploy_draft_dedup_idx (partial dedup index) was not created';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'radar_state' and grantee = 'app_web'
  ) then
    raise exception 'radar_state must NOT be granted to app_web (server-only cursor table)';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'radar_rollup_traffic'
  ) then
    raise exception 'radar_rollup_traffic was not created';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'radar_shop_queue'
  ) then
    raise exception 'radar_shop_queue was not created';
  end if;
end $$;
```

- [ ] **Step 2: Apply to prod via the supabase MCP**

Use `mcp__supabase__apply_migration` (project `ajgrmnvzxfxxlwrxcgnu`) with the file name and contents. Then verify with `mcp__supabase__execute_sql`:

```sql
select public.radar_rollup_traffic('00000000-0000-0000-0000-000000000000'::uuid, 10);   -- expect 10 (empty days upserted)
select public.read_radar_ranking_series('00000000-0000-0000-0000-000000000000'::uuid);  -- expect []
select * from public.radar_shop_queue('collect', 5);                                    -- expect rows or empty, not an error
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260720130000_radar_core.sql
git commit -m "radar/migrations: traffic rollup + moves tables with RLS and drain-queue RPCs"
```

---

### Task 2: Radar types + rankings detectors (`app/lib/radar/detect.server.ts`)

**Files:**
- Create: `app/lib/radar/types.ts`
- Create: `app/lib/radar/detect.server.ts`
- Test: `app/lib/radar/__tests__/detect.rankings.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 3, 5-7, 9-11):
  - `types.ts`: `RadarMoveKind`, `RadarMoveStatus`, `RadarApplyMode`, `RadarEvidence`, `RadarCandidate`, `RankingDayPoint`, `RankingSeries`, `TrafficDay`, `TrafficPath`, `AiCrawlDay`, `JsonLdCheckedPage`, `RadarCollectInputs`, `RadarMoveRow`
  - `detect.server.ts`: `parseStorefrontPath(pageUrl)`, `detectRankingSlips(series)`, `detectCtrLow(series)`, `detectRisingQueries(series)` + exported threshold constants

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/detect.rankings.test.ts
import { describe, expect, it } from "vitest";
import {
  detectCtrLow,
  detectRankingSlips,
  detectRisingQueries,
  parseStorefrontPath,
  RANK_SLIP_POSITIONS,
  RANK_SLIP_SUSTAIN_DAYS,
} from "../detect.server";
import type { RankingSeries } from "../types";

const PAGE = "https://peak.calderyncompany.com/storefront/products/trail-boots";

function series(
  points: Array<[string, number, number, number, number]>,
  pageUrl = PAGE,
  query = "trail boots",
): RankingSeries {
  return {
    pageUrl,
    query,
    days: points.map(([day, position, impressions, clicks, ctr]) => ({ day, position, impressions, clicks, ctr })),
  };
}

describe("parseStorefrontPath", () => {
  it("classifies home, product, collection and other paths", () => {
    expect(parseStorefrontPath("https://x/storefront")).toEqual({ entityType: "home", handle: null });
    expect(parseStorefrontPath(PAGE)).toEqual({ entityType: "product", handle: "trail-boots" });
    expect(parseStorefrontPath("/storefront/collections/hiking")).toEqual({ entityType: "collection", handle: "hiking" });
    expect(parseStorefrontPath("/storefront/cart")).toEqual({ entityType: "other", handle: null });
  });
});

describe("detectRankingSlips", () => {
  it("drafts a publishable product move when the position slips 3+ for 3 sustained days", () => {
    const s = series([
      ["2026-07-06", 4, 100, 9, 0.09], ["2026-07-07", 4, 100, 9, 0.09],
      ["2026-07-08", 4, 100, 9, 0.09], ["2026-07-09", 5, 100, 8, 0.08],
      ["2026-07-16", 8, 90, 2, 0.02], ["2026-07-17", 9, 90, 2, 0.02], ["2026-07-18", 9, 90, 1, 0.01],
    ]);
    const out = detectRankingSlips([s]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("seo_regression_patch");
    expect(out[0].dedupKey).toBe(`rank-slip:${PAGE}:trail boots`);
    expect(out[0].payload).toMatchObject({
      applyMode: "publish_meta", entityType: "product", handle: "trail-boots", focusQuery: "trail boots",
    });
    expect(out[0].headline).not.toMatch(/ploy/i);
  });
  it("needs the slip sustained, not a single bad day", () => {
    const s = series([
      ["2026-07-14", 4, 100, 9, 0.09], ["2026-07-15", 4, 100, 9, 0.09],
      ["2026-07-16", 4, 100, 9, 0.09], ["2026-07-17", 4, 100, 9, 0.09],
      ["2026-07-18", 9, 90, 1, 0.01],
    ]);
    expect(detectRankingSlips([s])).toHaveLength(0);
  });
  it("drafts a review move (not a publish) for a non-product page", () => {
    const s = series(
      [
        ["2026-07-14", 3, 100, 9, 0.09], ["2026-07-15", 3, 100, 9, 0.09],
        ["2026-07-16", 7, 90, 2, 0.02], ["2026-07-17", 7, 90, 2, 0.02], ["2026-07-18", 8, 90, 1, 0.01],
      ],
      "https://x/storefront", "hiking gear store",
    );
    const out = detectRankingSlips([s]);
    expect(out).toHaveLength(1);
    expect(out[0].payload.applyMode).toBe("review");
  });
  it("threshold constants hold the spec values", () => {
    expect(RANK_SLIP_POSITIONS).toBe(3);
    expect(RANK_SLIP_SUSTAIN_DAYS).toBe(3);
  });
});

describe("detectCtrLow", () => {
  it("flags a top-10 page whose CTR is under half the expected rate", () => {
    // pos 5 expects 7% (EXPECTED_CTR_BY_POSITION[4]); 300 impressions at 2% is under 3.5%.
    const s = series([
      ["2026-07-16", 5, 100, 2, 0.02], ["2026-07-17", 5, 100, 2, 0.02], ["2026-07-18", 5, 100, 2, 0.02],
    ]);
    const out = detectCtrLow([s]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("seo_meta_rewrite");
    expect(out[0].dedupKey).toBe(`ctr-low:${PAGE}:trail boots`);
  });
  it("skips thin impressions and pages outside the top 10", () => {
    const thin = series([["2026-07-18", 5, 40, 0, 0]]);
    const deep = series([["2026-07-16", 14, 200, 1, 0.005], ["2026-07-17", 14, 200, 1, 0.005]]);
    expect(detectCtrLow([thin, deep])).toHaveLength(0);
  });
});

describe("detectRisingQueries", () => {
  it("flags a rising query sitting at position 8-20", () => {
    const s = series([
      ["2026-07-08", 12, 10, 0, 0], ["2026-07-09", 12, 10, 0, 0], ["2026-07-10", 12, 10, 0, 0],
      ["2026-07-14", 12, 20, 1, 0.05], ["2026-07-15", 12, 20, 1, 0.05], ["2026-07-16", 12, 20, 1, 0.05],
      ["2026-07-17", 11, 20, 1, 0.05], ["2026-07-18", 11, 20, 1, 0.05],
    ]);
    const out = detectRisingQueries([s]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("seo_content_boost");
    expect(out[0].dedupKey).toBe("rising:trail boots");
    expect(out[0].payload.applyMode).toBe("publish_meta");
  });
  it("skips queries already ranking well or not growing", () => {
    const good = series([
      ["2026-07-11", 4, 20, 2, 0.1], ["2026-07-14", 4, 40, 4, 0.1],
      ["2026-07-15", 4, 40, 4, 0.1], ["2026-07-16", 4, 40, 4, 0.1],
    ]);
    // Flat needs a full prior week on record, or the growth check has nothing
    // to compare against (a query with no prior data but healthy volume is
    // legitimately "rising").
    const flat = series(
      Array.from({ length: 14 }, (_, i): [string, number, number, number, number] =>
        [`2026-07-${String(5 + i).padStart(2, "0")}`, 12, 40, 1, 0.02]),
    );
    expect(detectRisingQueries([good, flat])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/detect.rankings.test.ts`
Expected: FAIL - `Cannot find module '../detect.server'`.

- [ ] **Step 3: Write types.ts and detect.server.ts**

```ts
// app/lib/radar/types.ts
// Shared shapes for the Radar subsystem. The DB row is radar_ploy; every
// merchant-facing surface calls these "moves" - the internal noun never
// reaches UI strings or client bundles.

export type RadarMoveKind =
  | "seo_regression_patch"
  | "seo_meta_rewrite"
  | "seo_content_boost"
  | "aeo_refresh"
  | "aeo_jsonld_fix"
  | "section_refresh";

export type RadarMoveStatus = "draft" | "applied" | "dismissed" | "expired";

/** How Apply executes: publish_meta = product seo_page override; refresh_org =
 *  fill the store description; refresh_section = apply-time generation through
 *  the storefront pipelines; review = evidence + deep link, applying marks done. */
export type RadarApplyMode = "publish_meta" | "refresh_org" | "refresh_section" | "review";

export interface RadarEvidence {
  /** Short chip strings shown on the move card ("was #4", "now #9"). */
  chips: string[];
  /** Machine-readable facts backing the chips (numbers, urls, queries). */
  facts: Record<string, unknown>;
}

export interface RadarCandidate {
  kind: RadarMoveKind;
  dedupKey: string;
  headline: string;
  rationale: string;
  evidence: RadarEvidence;
  /** Always contains applyMode plus kind-specific fields (handle, focusQuery,
   *  target, brief, ...). Stored as radar_ploy.payload. */
  payload: Record<string, unknown> & { applyMode: RadarApplyMode };
}

export interface RankingDayPoint {
  day: string; // YYYY-MM-DD
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
}

export interface RankingSeries {
  pageUrl: string;
  query: string;
  days: RankingDayPoint[];
}

export interface TrafficPath {
  path: string;
  views: number;
  cartAdds: number;
  productId: string | null;
}

export interface TrafficDay {
  day: string; // YYYY-MM-DD
  views: number;
  sessions: number;
  cartAdds: number;
  checkouts: number;
  topPaths: TrafficPath[];
}

export interface AiCrawlDay {
  botName: string;
  day: string; // YYYY-MM-DD
  hits: number;
}

export interface JsonLdCheckedPage {
  productId: string;
  handle: string;
  title: string;
  issues: string[];
}

/** Everything the drafter's detectors consume, assembled by collect.server.ts. */
export interface RadarCollectInputs {
  traffic: TrafficDay[];
  rankings: RankingSeries[];
  aiCrawl: AiCrawlDay[];
  allowAiCrawlers: boolean;
  hasOrgDescription: boolean;
  /** Last publish of the storefront (either runtime), ISO string; null when unpublished. */
  lastPublishedAt: string | null;
  jsonLdIssues: JsonLdCheckedPage[];
}

/** Camel-case mirror of a radar_ploy row (mapped in store.server.ts). */
export interface RadarMoveRow {
  id: string;
  shopId: string;
  kind: RadarMoveKind;
  status: RadarMoveStatus;
  headline: string;
  rationale: string;
  evidence: RadarEvidence;
  payload: Record<string, unknown>;
  dedupKey: string;
  priorState: Record<string, unknown> | null;
  appliedStateHash: string | null;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
  expiresAt: string;
}
```

```ts
// app/lib/radar/detect.server.ts
// Deterministic Radar detectors: pure functions over collected rows. No DB, no
// Claude, no clock reads except via parameters - every threshold is a named
// exported constant so tests and tuning share one source of truth.
import type { RadarCandidate, RankingSeries } from "./types";

// ── Rankings thresholds (spec defaults) ──────────────────────────────────────
export const RANK_SLIP_POSITIONS = 3;
export const RANK_SLIP_SUSTAIN_DAYS = 3;
export const CTR_MIN_IMPRESSIONS = 100;
export const CTR_LOW_FACTOR = 0.5;
/** Rough expected CTR by Google position 1..10 (industry-typical curve). */
export const EXPECTED_CTR_BY_POSITION = [
  0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02,
] as const;
export const RISING_POS_MIN = 8;
export const RISING_POS_MAX = 20;
export const RISING_GROWTH_FACTOR = 1.5;
export const RISING_MIN_RECENT_IMPRESSIONS = 30;

export interface StorefrontEntityRef {
  entityType: "home" | "product" | "collection" | "other";
  handle: string | null;
}

/** Map a ranking page_url or storefront_event path onto the owned-storefront
 *  entity it serves. Tolerates full URLs and bare paths. */
export function parseStorefrontPath(pageUrl: string): StorefrontEntityRef {
  let path = pageUrl;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    // already a bare path
  }
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const at = parts.indexOf("storefront");
  const rest = at >= 0 ? parts.slice(at + 1) : parts;
  if (rest.length === 0) return { entityType: "home", handle: null };
  if (rest[0] === "products" && rest[1]) return { entityType: "product", handle: rest[1] };
  if (rest[0] === "collections" && rest[1]) return { entityType: "collection", handle: rest[1] };
  return { entityType: "other", handle: null };
}

function pageLabel(ref: StorefrontEntityRef): string {
  if (ref.entityType === "home") return "Your home page";
  if (ref.entityType === "product" && ref.handle) return `Your "${ref.handle.replace(/-/g, " ")}" page`;
  if (ref.entityType === "collection" && ref.handle) return `Your "${ref.handle.replace(/-/g, " ")}" collection`;
  return "One of your pages";
}

function sortedDays<T extends { day: string }>(days: T[]): T[] {
  return [...days].sort((a, b) => a.day.localeCompare(b.day));
}

/** SEO publishes only work for product pages today (the storefront serve path
 *  reads product overrides only) - everything else becomes a review move. */
function seoPayload(
  ref: StorefrontEntityRef,
  pageUrl: string,
  focusQuery: string,
): RadarCandidate["payload"] {
  if (ref.entityType === "product" && ref.handle) {
    return { applyMode: "publish_meta", entityType: "product", handle: ref.handle, focusQuery, pageUrl };
  }
  return { applyMode: "review", pageUrl, focusQuery, deepLink: "/dashboard/store/preferences" };
}

export function detectRankingSlips(series: RankingSeries[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const s of series) {
    const days = sortedDays(s.days);
    if (days.length < RANK_SLIP_SUSTAIN_DAYS + 1) continue;
    const recent = days.slice(-RANK_SLIP_SUSTAIN_DAYS);
    const earlier = days.slice(0, -RANK_SLIP_SUSTAIN_DAYS);
    const bestEarlier = Math.min(...earlier.map((d) => d.position));
    if (!recent.every((d) => d.position >= bestEarlier + RANK_SLIP_POSITIONS)) continue;
    const nowPos = recent[recent.length - 1].position;
    const ref = parseStorefrontPath(s.pageUrl);
    out.push({
      kind: "seo_regression_patch",
      dedupKey: `rank-slip:${s.pageUrl}:${s.query}`,
      headline: `Win back "${s.query}" on Google`,
      rationale:
        `${pageLabel(ref)} was around #${Math.round(bestEarlier)} on Google for "${s.query}" ` +
        `and has sat at #${Math.round(nowPos)} or lower for ${RANK_SLIP_SUSTAIN_DAYS} days.`,
      evidence: {
        chips: [`was #${Math.round(bestEarlier)}`, `now #${Math.round(nowPos)}`, `${RANK_SLIP_SUSTAIN_DAYS} days running`],
        facts: { pageUrl: s.pageUrl, query: s.query, bestEarlier, nowPos },
      },
      payload: seoPayload(ref, s.pageUrl, s.query),
    });
  }
  return out;
}

export function detectCtrLow(series: RankingSeries[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const s of series) {
    const impressions = s.days.reduce((n, d) => n + d.impressions, 0);
    if (impressions < CTR_MIN_IMPRESSIONS) continue;
    const clicks = s.days.reduce((n, d) => n + d.clicks, 0);
    const avgPos = s.days.reduce((n, d) => n + d.position * d.impressions, 0) / impressions;
    if (avgPos > 10) continue;
    const slot = Math.min(Math.max(Math.round(avgPos), 1), 10);
    const expected = EXPECTED_CTR_BY_POSITION[slot - 1];
    const ctr = clicks / impressions;
    if (ctr >= expected * CTR_LOW_FACTOR) continue;
    const ref = parseStorefrontPath(s.pageUrl);
    out.push({
      kind: "seo_meta_rewrite",
      dedupKey: `ctr-low:${s.pageUrl}:${s.query}`,
      headline: `Make "${s.query}" worth the click`,
      rationale:
        `${pageLabel(ref)} shows up around #${slot} on Google for "${s.query}" but only ` +
        `${(ctr * 100).toFixed(1)}% of people click it - about half what that spot usually gets. ` +
        `A clearer title and description can close that gap.`,
      evidence: {
        chips: [`spot #${slot}`, `${(ctr * 100).toFixed(1)}% clicks`, `${impressions} views on Google`],
        facts: { pageUrl: s.pageUrl, query: s.query, avgPos, ctr, expectedCtr: expected, impressions },
      },
      payload: seoPayload(ref, s.pageUrl, s.query),
    });
  }
  return out;
}

export function detectRisingQueries(series: RankingSeries[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const s of series) {
    const days = sortedDays(s.days);
    const last = days.slice(-7);
    const prior = days.slice(-14, -7);
    const lastImp = last.reduce((n, d) => n + d.impressions, 0);
    const priorImp = prior.reduce((n, d) => n + d.impressions, 0);
    if (lastImp < RISING_MIN_RECENT_IMPRESSIONS) continue;
    if (priorImp > 0 && lastImp < priorImp * RISING_GROWTH_FACTOR) continue;
    const avgPos = last.reduce((n, d) => n + d.position * d.impressions, 0) / lastImp;
    if (avgPos < RISING_POS_MIN || avgPos > RISING_POS_MAX) continue;
    const ref = parseStorefrontPath(s.pageUrl);
    out.push({
      kind: "seo_content_boost",
      dedupKey: `rising:${s.query}`,
      headline: `"${s.query}" is picking up - lean in`,
      rationale:
        `More people are searching "${s.query}" and finding you around #${Math.round(avgPos)} on Google. ` +
        `Speaking to that search directly in the page title and description can push it onto page one.`,
      evidence: {
        chips: [`#${Math.round(avgPos)} and rising`, `${lastImp} views this week`, `${priorImp} last week`],
        facts: { pageUrl: s.pageUrl, query: s.query, avgPos, lastImp, priorImp },
      },
      payload: seoPayload(ref, s.pageUrl, s.query),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/detect.rankings.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/types.ts app/lib/radar/detect.server.ts app/lib/radar/__tests__/detect.rankings.test.ts
git commit -m "radar/detect: types + rankings slip/CTR/rising detectors"
```

---

### Task 3: Traffic + AEO detectors + `detectAll` (extend `detect.server.ts`)

**Files:**
- Modify: `app/lib/radar/detect.server.ts`
- Test: `app/lib/radar/__tests__/detect.signals.test.ts`

**Interfaces:**
- Produces (used by Tasks 7, 10): `detectTrafficDrops(days)`, `detectConversionGaps(days)`, `detectStaleHome(days, lastPublishedAt, now?)`, `detectAeoQuiet(crawl, opts, now?)`, `detectJsonLdIssues(pages)`, `detectAll(inputs, now?)` + threshold constants.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/detect.signals.test.ts
import { describe, expect, it } from "vitest";
import {
  detectAeoQuiet,
  detectAll,
  detectConversionGaps,
  detectJsonLdIssues,
  detectStaleHome,
  detectTrafficDrops,
} from "../detect.server";
import type { AiCrawlDay, RadarCollectInputs, TrafficDay } from "../types";

const NOW = new Date("2026-07-19T10:00:00Z");

function day(day: string, paths: Array<[string, number, number, string | null]>): TrafficDay {
  const views = paths.reduce((n, [, v]) => n + v, 0);
  const cartAdds = paths.reduce((n, [, , c]) => n + c, 0);
  return {
    day, views, sessions: views, cartAdds, checkouts: 0,
    topPaths: paths.map(([path, v, c, productId]) => ({ path, views: v, cartAdds: c, productId })),
  };
}

/** 7 baseline days of `views` on one path, then a last day of `lastViews`.
 *  cartAdds per baseline day is configurable so a traffic-drop fixture can
 *  stay clear of the conversion-gap detector (rate >= 1%) when a test wants
 *  exactly one candidate family. */
function dropSeries(
  path: string,
  views: number,
  lastViews: number,
  productId: string | null = null,
  cartAdds = 1,
): TrafficDay[] {
  const days: TrafficDay[] = [];
  for (let i = 0; i < 7; i++) days.push(day(`2026-07-${11 + i}`, [[path, views, cartAdds, productId]]));
  days.push(day("2026-07-18", [[path, lastViews, 0, productId]]));
  return days;
}

describe("detectTrafficDrops", () => {
  it("flags a top page down 30%+ vs its 7-day average", () => {
    const out = detectTrafficDrops(dropSeries("/storefront/products/trail-boots", 100, 60, "p1"));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("section_refresh");
    expect(out[0].dedupKey).toBe("traffic-drop:/storefront/products/trail-boots");
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "pdp", handle: "trail-boots" });
    expect(String(out[0].payload.brief)).toContain("trail boots");
  });
  it("ignores small drops and thin baselines", () => {
    expect(detectTrafficDrops(dropSeries("/storefront", 100, 80))).toHaveLength(0); // 20% drop
    expect(detectTrafficDrops(dropSeries("/storefront", 10, 2))).toHaveLength(0); // avg under floor
  });
});

describe("detectConversionGaps", () => {
  it("flags 50+ views with cart-add rate under 1%", () => {
    const days: TrafficDay[] = [];
    for (let i = 0; i < 7; i++) days.push(day(`2026-07-${12 + i}`, [["/storefront/products/mug", 10, 0, "p9"]]));
    const out = detectConversionGaps(days);
    expect(out).toHaveLength(1);
    expect(out[0].dedupKey).toBe("conv-gap:p9");
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "pdp", productId: "p9", handle: "mug" });
  });
  it("skips products that convert", () => {
    const days: TrafficDay[] = [];
    for (let i = 0; i < 7; i++) days.push(day(`2026-07-${12 + i}`, [["/storefront/products/mug", 10, 1, "p9"]]));
    expect(detectConversionGaps(days)).toHaveLength(0);
  });
});

describe("detectStaleHome", () => {
  const declining = [
    ...[0, 1, 2, 3, 4, 5, 6].map((i) =>
      day(`2026-07-${String(5 + i).padStart(2, "0")}`, [["/storefront", 100, 0, null]])),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => day(`2026-07-${12 + i}`, [["/storefront", 60, 0, null]])),
  ];
  it("flags a home page unchanged 6+ weeks with declining views", () => {
    const out = detectStaleHome(declining, "2026-05-01T00:00:00Z", NOW);
    expect(out).toHaveLength(1);
    expect(out[0].dedupKey).toBe("stale:home");
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "home" });
  });
  it("skips a recently published or unpublished home", () => {
    expect(detectStaleHome(declining, "2026-07-10T00:00:00Z", NOW)).toHaveLength(0);
    expect(detectStaleHome(declining, null, NOW)).toHaveLength(0);
  });
});

describe("detectAeoQuiet", () => {
  const priorHits: AiCrawlDay[] = [
    { botName: "GPTBot", day: "2026-07-01", hits: 4 },
    { botName: "ClaudeBot", day: "2026-07-05", hits: 3 },
  ];
  it("drafts a refresh move when hits go quiet and the description is missing", () => {
    const out = detectAeoQuiet(priorHits, { allowAiCrawlers: true, hasOrgDescription: false }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("aeo_refresh");
    expect(out[0].payload.applyMode).toBe("refresh_org");
  });
  it("drafts a review move when the description already exists", () => {
    const out = detectAeoQuiet(priorHits, { allowAiCrawlers: true, hasOrgDescription: true }, NOW);
    expect(out[0].payload.applyMode).toBe("review");
  });
  it("stays silent when crawlers are blocked, still active, or never came", () => {
    expect(detectAeoQuiet(priorHits, { allowAiCrawlers: false, hasOrgDescription: false }, NOW)).toHaveLength(0);
    const active = [...priorHits, { botName: "GPTBot", day: "2026-07-18", hits: 2 }];
    expect(detectAeoQuiet(active, { allowAiCrawlers: true, hasOrgDescription: false }, NOW)).toHaveLength(0);
    expect(detectAeoQuiet([], { allowAiCrawlers: true, hasOrgDescription: false }, NOW)).toHaveLength(0);
  });
});

describe("detectJsonLdIssues", () => {
  it("wraps validator issues into review moves that deep-link the product", () => {
    const out = detectJsonLdIssues([
      { productId: "p1", handle: "mug", title: "Mug", issues: ["Offer requires price, priceCurrency, availability"] },
      { productId: "p2", handle: "hat", title: "Hat", issues: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("aeo_jsonld_fix");
    expect(out[0].dedupKey).toBe("jsonld:product:p1");
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products/p1" });
  });
});

describe("detectAll", () => {
  it("concatenates every detector family over the collected inputs", () => {
    const inputs: RadarCollectInputs = {
      // cartAdds 2/day keeps the cart-add rate at 1.8%, so ONLY the traffic
      // drop fires from this fixture (not the conversion-gap detector too).
      traffic: dropSeries("/storefront/products/trail-boots", 100, 60, "p1", 2),
      rankings: [],
      aiCrawl: [{ botName: "GPTBot", day: "2026-07-01", hits: 6 }],
      allowAiCrawlers: true,
      hasOrgDescription: false,
      lastPublishedAt: "2026-07-15T00:00:00Z",
      jsonLdIssues: [{ productId: "p1", handle: "trail-boots", title: "Boots", issues: ["missing @type"] }],
    };
    const out = detectAll(inputs, NOW);
    const kinds = out.map((c) => c.kind).sort();
    expect(kinds).toEqual(["aeo_jsonld_fix", "aeo_refresh", "section_refresh"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/detect.signals.test.ts`
Expected: FAIL - the new exports do not exist yet.

- [ ] **Step 3: Append to `detect.server.ts`**

Extend the import at the top of the file:

```ts
import type { AiCrawlDay, JsonLdCheckedPage, RadarCandidate, RadarCollectInputs, RankingSeries, TrafficDay } from "./types";
```

Then append:

```ts
// ── Traffic + AEO thresholds (spec defaults) ─────────────────────────────────
export const TRAFFIC_DROP_PCT = 0.3;
export const TRAFFIC_TOP_PAGES = 10;
/** A page whose 7-day average is below this many daily views is too thin to
 *  call a "drop" without drafting noise. */
export const TRAFFIC_MIN_BASELINE_VIEWS = 30;
export const CONV_GAP_MIN_VIEWS = 50;
export const CONV_GAP_MAX_CART_RATE = 0.01;
export const STALE_SECTION_WEEKS = 6;
/** "Declining" = the last 7 days at or below 85% of the prior 7 days. */
export const STALE_DECLINE_RATIO = 0.85;
export const AEO_QUIET_DAYS = 7;
export const AEO_MIN_PRIOR_HITS = 5;

const DAY_MS = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Apply-time generation brief: this exact text is the prompt the storefront
 *  edit pipeline receives when the merchant clicks Apply. Keep it product-
 *  neutral and structure-preserving. */
function sectionBrief(target: "home" | "pdp", context: string): string {
  const where = target === "home" ? "the home page's hero section" : "this product page's top section";
  return (
    `Refresh ${where}: rewrite the headline and supporting copy so the page feels current and persuasive. ` +
    `${context} Keep the products, prices, layout structure and navigation unchanged.`
  );
}

export function detectTrafficDrops(days: TrafficDay[]): RadarCandidate[] {
  const sorted = sortedDays(days);
  if (sorted.length < 8) return [];
  const last = sorted[sorted.length - 1];
  const baseline = sorted.slice(-8, -1);
  const totals = new Map<string, number>();
  for (const d of baseline) {
    for (const p of d.topPaths) totals.set(p.path, (totals.get(p.path) ?? 0) + p.views);
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TRAFFIC_TOP_PAGES);
  const out: RadarCandidate[] = [];
  for (const [path, total] of top) {
    const avg = total / baseline.length;
    if (avg < TRAFFIC_MIN_BASELINE_VIEWS) continue;
    const lastViews = last.topPaths.find((p) => p.path === path)?.views ?? 0;
    if (lastViews > avg * (1 - TRAFFIC_DROP_PCT)) continue;
    const ref = parseStorefrontPath(path);
    if (ref.entityType !== "home" && ref.entityType !== "product") continue; // cart/search pages are not refreshable sections
    const dropPct = Math.round((1 - lastViews / avg) * 100);
    const target = ref.entityType === "home" ? ("home" as const) : ("pdp" as const);
    const label = pageLabel(ref);
    const productId = last.topPaths.find((p) => p.path === path)?.productId
      ?? baseline.flatMap((d) => d.topPaths).find((p) => p.path === path)?.productId
      ?? null;
    out.push({
      kind: "section_refresh",
      dedupKey: `traffic-drop:${path}`,
      headline: `${label} lost ${dropPct}% of its visits`,
      rationale:
        `${label} averaged ${Math.round(avg)} views a day over the last week but got ${lastViews} yesterday. ` +
        `A refreshed section can re-engage shoppers; nothing changes until you apply it.`,
      evidence: {
        chips: [`${Math.round(avg)}/day average`, `${lastViews} yesterday`, `down ${dropPct}%`],
        facts: { path, avg, lastViews, dropPct },
      },
      payload: {
        applyMode: "refresh_section",
        target,
        path,
        ...(ref.handle ? { handle: ref.handle } : {}),
        ...(productId ? { productId } : {}),
        brief: sectionBrief(
          target,
          `Context: the page at ${path} (about "${(ref.handle ?? "the store").replace(/-/g, " ")}") lost ${dropPct}% of its daily visits this week.`,
        ),
      },
    });
  }
  return out;
}

export function detectConversionGaps(days: TrafficDay[]): RadarCandidate[] {
  const last7 = sortedDays(days).slice(-7);
  const acc = new Map<string, { views: number; cartAdds: number; handle: string | null; path: string }>();
  for (const d of last7) {
    for (const p of d.topPaths) {
      if (!p.productId) continue;
      const cur = acc.get(p.productId) ?? {
        views: 0, cartAdds: 0, handle: parseStorefrontPath(p.path).handle, path: p.path,
      };
      cur.views += p.views;
      cur.cartAdds += p.cartAdds;
      acc.set(p.productId, cur);
    }
  }
  const out: RadarCandidate[] = [];
  for (const [productId, s] of acc) {
    if (s.views < CONV_GAP_MIN_VIEWS) continue;
    if (s.cartAdds / s.views >= CONV_GAP_MAX_CART_RATE) continue;
    const label = s.handle ? `"${s.handle.replace(/-/g, " ")}"` : "This product";
    out.push({
      kind: "section_refresh",
      dedupKey: `conv-gap:${productId}`,
      headline: `${label} gets looks, not carts`,
      rationale:
        `${s.views} people viewed ${label} this week but only ${s.cartAdds} added it to a cart ` +
        `(under 1%). A stronger product-page section can help close the gap.`,
      evidence: {
        chips: [`${s.views} views`, `${s.cartAdds} cart adds`, "under 1%"],
        facts: { productId, views: s.views, cartAdds: s.cartAdds, path: s.path },
      },
      payload: {
        applyMode: "refresh_section",
        target: "pdp",
        productId,
        ...(s.handle ? { handle: s.handle } : {}),
        path: s.path,
        brief: sectionBrief(
          "pdp",
          `Context: ${s.views} shoppers viewed this product this week but under 1% added it to a cart; make the value clearer.`,
        ),
      },
    });
  }
  return out;
}

export function detectStaleHome(
  days: TrafficDay[],
  lastPublishedAt: string | null,
  now: Date = new Date(),
): RadarCandidate[] {
  if (!lastPublishedAt) return [];
  const publishedAt = Date.parse(lastPublishedAt);
  if (!Number.isFinite(publishedAt)) return [];
  const ageWeeks = (now.getTime() - publishedAt) / (7 * DAY_MS);
  if (ageWeeks < STALE_SECTION_WEEKS) return [];
  const sorted = sortedDays(days);
  if (sorted.length < 14) return [];
  const homeViews = (d: TrafficDay): number =>
    d.topPaths.filter((p) => parseStorefrontPath(p.path).entityType === "home").reduce((n, p) => n + p.views, 0);
  const last7 = sorted.slice(-7).reduce((n, d) => n + homeViews(d), 0);
  const prior7 = sorted.slice(-14, -7).reduce((n, d) => n + homeViews(d), 0);
  if (prior7 === 0 || last7 > prior7 * STALE_DECLINE_RATIO) return [];
  const weeks = Math.floor(ageWeeks);
  return [{
    kind: "section_refresh",
    dedupKey: "stale:home",
    headline: "Your home page hasn't changed in a while",
    rationale:
      `Your home page was last updated ${weeks} weeks ago and its views slipped from ${prior7} to ${last7} ` +
      `week over week. A fresh hero section keeps returning shoppers looking.`,
    evidence: {
      chips: [`${weeks} weeks unchanged`, `${prior7} -> ${last7} weekly views`],
      facts: { lastPublishedAt, weeks, prior7, last7 },
    },
    payload: {
      applyMode: "refresh_section",
      target: "home",
      path: "/storefront",
      brief: sectionBrief("home", `Context: the home page has not changed in ${weeks} weeks and weekly views are declining.`),
    },
  }];
}

export function detectAeoQuiet(
  crawl: AiCrawlDay[],
  opts: { allowAiCrawlers: boolean; hasOrgDescription: boolean },
  now: Date = new Date(),
): RadarCandidate[] {
  if (!opts.allowAiCrawlers) return []; // the merchant turned AI access off - respect it
  const quietFrom = isoDay(new Date(now.getTime() - AEO_QUIET_DAYS * DAY_MS));
  const recentHits = crawl.filter((c) => c.day >= quietFrom).reduce((n, c) => n + c.hits, 0);
  const priorHits = crawl.filter((c) => c.day < quietFrom).reduce((n, c) => n + c.hits, 0);
  if (recentHits > 0 || priorHits < AEO_MIN_PRIOR_HITS) return [];
  const applyMode = opts.hasOrgDescription ? ("review" as const) : ("refresh_org" as const);
  return [{
    kind: "aeo_refresh",
    dedupKey: "aeo-quiet",
    headline: "AI assistants stopped reading your store",
    rationale: opts.hasOrgDescription
      ? `AI assistants (like ChatGPT and Claude) read your store ${priorHits} times recently but haven't visited in a week. ` +
        `Your store description is set - review your Preferences to make sure everything is current.`
      : `AI assistants (like ChatGPT and Claude) read your store ${priorHits} times recently but haven't visited in a week. ` +
        `Adding a store description gives them something concrete to quote when shoppers ask.`,
    evidence: {
      chips: [`${priorHits} earlier visits`, `0 this week`],
      facts: { priorHits, recentHits, quietFrom },
    },
    payload: applyMode === "review"
      ? { applyMode, deepLink: "/dashboard/store/preferences" }
      : { applyMode },
  }];
}

export function detectJsonLdIssues(pages: JsonLdCheckedPage[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const p of pages) {
    if (p.issues.length === 0) continue;
    out.push({
      kind: "aeo_jsonld_fix",
      dedupKey: `jsonld:product:${p.productId}`,
      headline: `"${p.title}" is missing details search tools need`,
      rationale:
        `Google and AI assistants read structured product details behind the scenes, and "${p.title}" ` +
        `is missing some (${p.issues.join("; ")}). Filling in the product's real data fixes this - ` +
        `Radar won't invent prices or availability for you.`,
      evidence: { chips: p.issues.slice(0, 3), facts: { productId: p.productId, issues: p.issues } },
      payload: { applyMode: "review", productId: p.productId, handle: p.handle, deepLink: `/dashboard/products/${p.productId}` },
    });
  }
  return out;
}

/** Everything, in a stable order (SEO first - they are the cheapest wins). */
export function detectAll(inputs: RadarCollectInputs, now: Date = new Date()): RadarCandidate[] {
  return [
    ...detectRankingSlips(inputs.rankings),
    ...detectCtrLow(inputs.rankings),
    ...detectRisingQueries(inputs.rankings),
    ...detectAeoQuiet(inputs.aiCrawl, {
      allowAiCrawlers: inputs.allowAiCrawlers,
      hasOrgDescription: inputs.hasOrgDescription,
    }, now),
    ...detectJsonLdIssues(inputs.jsonLdIssues),
    ...detectTrafficDrops(inputs.traffic),
    ...detectConversionGaps(inputs.traffic),
    ...detectStaleHome(inputs.traffic, inputs.lastPublishedAt, now),
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/radar/__tests__/detect.signals.test.ts app/lib/radar/__tests__/detect.rankings.test.ts`
Expected: PASS (both suites - the rankings suite guards against regressions from the edit).

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/detect.server.ts app/lib/radar/__tests__/detect.signals.test.ts
git commit -m "radar/detect: traffic drop, conversion gap, stale home + AEO detectors"
```

---

### Task 4: `"radar"` AiFeature + `radarDraftModel()`

**Files:**
- Modify: `app/lib/ai-quota.server.ts`
- Modify: `app/lib/assistant/anthropic.server.ts`
- Test: `app/lib/__tests__/ai-quota.radar.test.ts`

**Interfaces:**
- Consumes: `rateLimit` from `~/lib/rate-limit.server` (existing).
- Produces (used by Tasks 7, 10): `AiFeature` union gains `"radar"`; `QUOTAS.radar = { cooldownMs: 0, daily: { base: 5, trusted: 5 } }`; `checkAiQuota` skips the cooldown limiter when `cooldownMs === 0`; `radarDraftModel(): string` in `anthropic.server.ts` (env `RADAR_DRAFT_MODEL`, defaults to `DEFAULT_DIGEST_MODEL`).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/__tests__/ai-quota.radar.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rateLimitMock } = vi.hoisted(() => ({ rateLimitMock: vi.fn() }));
vi.mock("../rate-limit.server", () => ({ rateLimit: rateLimitMock }));

import { checkAiQuota } from "../ai-quota.server";
import { DEFAULT_DIGEST_MODEL, radarDraftModel } from "../assistant/anthropic.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  // vitest runs with NODE_ENV=test, so the development bypass stays off; keep
  // the env allowlist empty so the quota path is actually exercised.
  delete process.env.AI_QUOTA_BYPASS_SHOPS;
});

describe("radar AiFeature", () => {
  it("has no cooldown: back-to-back calls only touch the daily bucket", async () => {
    rateLimitMock.mockResolvedValue(true);
    const verdict = await checkAiQuota({ shopId: SHOP, feature: "radar", trusted: true });
    expect(verdict).toEqual({ allowed: true });
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledWith(`ai:day:radar:${SHOP}`, 5, 86_400_000);
    expect(rateLimitMock).not.toHaveBeenCalledWith(expect.stringContaining("ai:cd:radar"), expect.anything(), expect.anything());
  });
  it("caps at 5 per day for both tiers", async () => {
    rateLimitMock.mockResolvedValue(false);
    const base = await checkAiQuota({ shopId: SHOP, feature: "radar", trusted: false });
    expect(base).toMatchObject({ allowed: false, code: "ai_daily_limit" });
    expect(rateLimitMock).toHaveBeenLastCalledWith(`ai:day:radar:${SHOP}`, 5, 86_400_000);
    await checkAiQuota({ shopId: SHOP, feature: "radar", trusted: true });
    expect(rateLimitMock).toHaveBeenLastCalledWith(`ai:day:radar:${SHOP}`, 5, 86_400_000);
  });
  it("leaves features with a cooldown untouched", async () => {
    rateLimitMock.mockResolvedValue(true);
    await checkAiQuota({ shopId: SHOP, feature: "assistant", trusted: false });
    expect(rateLimitMock).toHaveBeenCalledWith(`ai:cd:assistant:${SHOP}`, 1, 4_000);
  });
});

describe("radarDraftModel", () => {
  it("defaults to the digest-class model and honors the env override", () => {
    delete process.env.RADAR_DRAFT_MODEL;
    expect(radarDraftModel()).toBe(DEFAULT_DIGEST_MODEL);
    process.env.RADAR_DRAFT_MODEL = "env-model";
    expect(radarDraftModel()).toBe("env-model");
    delete process.env.RADAR_DRAFT_MODEL;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/ai-quota.radar.test.ts`
Expected: FAIL - `"radar"` is not assignable to `AiFeature` (typecheck) / `radarDraftModel` is not exported.

- [ ] **Step 3: Make the two edits**

In `app/lib/ai-quota.server.ts`:

```ts
export type AiFeature = "designer" | "assistant" | "listing" | "radar";
```

Add to `QUOTAS` (after `listing`):

```ts
  // Radar's overnight drafter: no human in the loop, calls run back-to-back
  // inside one cron tick, so a cooldown would only false-block call 2 of 5.
  // The 5/night spec cap IS the daily bucket; the drafter also hard-caps its
  // own loop so quota-bypassed (dev) shops cannot overspend either.
  radar: { cooldownMs: 0, daily: { base: 5, trusted: 5 } },
```

And make the cooldown limiter conditional inside `checkAiQuota` (replace the unconditional `const cd = await rateLimit(...)` block):

```ts
  if (cfg.cooldownMs > 0) {
    const cd = await rateLimit(`ai:cd:${opts.feature}:${opts.shopId}`, 1, cfg.cooldownMs);
    if (!cd) {
      return {
        allowed: false,
        code: "ai_cooldown",
        message: `Going a little fast — try again in ${Math.ceil(cfg.cooldownMs / 1000)} seconds.`,
      };
    }
  }
```

In `app/lib/assistant/anthropic.server.ts`, append:

```ts
/** Model for Radar's overnight move drafting and apply-time section copy:
 *  short structured rewrites over deterministic templates, so the digest-class
 *  model is the right default. Override with RADAR_DRAFT_MODEL. */
export function radarDraftModel(): string {
  return process.env.RADAR_DRAFT_MODEL || DEFAULT_DIGEST_MODEL;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/__tests__/ai-quota.radar.test.ts && npm run typecheck`
Expected: PASS / exit 0 (the union change must not break existing `AiFeature` call sites - there are none that enumerate it exhaustively).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ai-quota.server.ts app/lib/assistant/anthropic.server.ts app/lib/__tests__/ai-quota.radar.test.ts
git commit -m "ai-quota/anthropic: radar feature (5/night, no cooldown) + radarDraftModel picker"
```

---

### Task 5: Collection step (`app/lib/radar/collect.server.ts`)

**Files:**
- Create: `app/lib/radar/collect.server.ts`
- Test: `app/lib/radar/__tests__/collect.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`, `isUuid`; `getCatalog` (`~/lib/storefront/catalog.server`), `getStoreSettings` (`~/lib/storefront/settings.server`), `getShopStorefrontOrigin` (`~/lib/storefront/shop.server`); `getSeoSettings` (`~/lib/seo/seo-store.server`); `buildProductDraft` (`~/lib/seo/writer.server`), `validateDraft` (`~/lib/seo/validator.server`); `readStorefrontReleaseState` (`~/lib/storefront-bundle/build.server`); `parseStorefrontPath` (Task 2).
- Produces (used by Tasks 7-8):
  - `collectShop(shopId: string): Promise<void>` - runs the rollup RPC + stamps `radar_state.last_collected_at`.
  - `loadRadarInputs(shopId: string): Promise<RadarCollectInputs>` - assembles the detector inputs (bounded reads only).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/collect.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  getProductMock: vi.fn(),
  getStoreSettingsMock: vi.fn(),
  getShopStorefrontOriginMock: vi.fn(),
  getSeoSettingsMock: vi.fn(),
  releaseStateMock: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ rpc: mocks.rpcMock, from: mocks.fromMock }),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ getProduct: mocks.getProductMock }),
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: mocks.getStoreSettingsMock }));
vi.mock("~/lib/storefront/shop.server", () => ({ getShopStorefrontOrigin: mocks.getShopStorefrontOriginMock }));
vi.mock("~/lib/seo/seo-store.server", () => ({ getSeoSettings: mocks.getSeoSettingsMock }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({ readStorefrontReleaseState: mocks.releaseStateMock }));

import { collectShop, loadRadarInputs, JSONLD_CHECK_MAX_PAGES } from "../collect.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

// Chainable query stub: every builder method returns itself; awaiting resolves
// to the queued result for its table.
function tableStub(result: { data: unknown; error: null | { message: string } }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order", "limit"]) {
    q[m] = vi.fn().mockReturnValue(q);
  }
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.upsert = vi.fn().mockResolvedValue({ error: null });
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpcMock.mockResolvedValue({ data: [], error: null });
  mocks.getStoreSettingsMock.mockResolvedValue({ storeName: "Peak", logoUrl: null, voiceTagline: null, palette: { primary: "", background: "", text: "" } });
  mocks.getShopStorefrontOriginMock.mockResolvedValue("https://peak.example");
  mocks.getSeoSettingsMock.mockResolvedValue({ allowAiCrawlers: true, orgDescription: "We sell boots." });
  mocks.releaseStateMock.mockResolvedValue({ draftVersionId: null, publishedVersionId: null, draftRuntimeVersion: null, publishedRuntimeVersion: null });
});

describe("collectShop", () => {
  it("runs the rollup RPC then stamps the cursor", async () => {
    const state = tableStub({ data: null, error: null });
    mocks.fromMock.mockReturnValue(state);
    await collectShop(SHOP);
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_rollup_traffic", { p_shop: SHOP, p_days: 10 });
    expect(mocks.fromMock).toHaveBeenCalledWith("radar_state");
    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: SHOP, last_collected_at: expect.any(String) }),
      { onConflict: "shop_id" },
    );
  });
  it("skips demo (non-uuid) shops and surfaces RPC errors", async () => {
    await collectShop("demo-shop");
    expect(mocks.rpcMock).not.toHaveBeenCalled();
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(collectShop(SHOP)).rejects.toThrow(/boom/);
  });
});

describe("loadRadarInputs", () => {
  it("assembles traffic, rankings, crawl, flags and JSON-LD checks", async () => {
    const traffic = tableStub({
      data: [{
        day: "2026-07-18", views: 100, sessions: 80, cart_adds: 3, checkouts: 1,
        top_paths: [{ path: "/storefront/products/mug", views: 90, cartAdds: 3, productId: "p1" }],
      }],
      error: null,
    });
    const crawl = tableStub({ data: [{ bot_name: "GPTBot", day: "2026-07-10", hits: 4 }], error: null });
    const pageDoc = tableStub({ data: { updated_at: "2026-06-01T00:00:00Z", published_json: { kind: "singleton" } }, error: null });
    mocks.fromMock.mockImplementation((table: string) => {
      if (table === "radar_traffic_daily") return traffic;
      if (table === "seo_ai_crawl_daily") return crawl;
      if (table === "page_document") return pageDoc;
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpcMock.mockResolvedValue({
      data: [{ pageUrl: "https://x/storefront/products/mug", query: "mug", days: [] }],
      error: null,
    });
    // Product with no sellable variants: the real writer emits Product JSON-LD
    // without offers, which passes; force an issue via a missing name instead.
    mocks.getProductMock.mockResolvedValue({
      id: "p1", handle: "mug", title: "", description: "", images: [], variants: [], collections: [],
    });
    const inputs = await loadRadarInputs(SHOP);
    expect(inputs.traffic).toEqual([{
      day: "2026-07-18", views: 100, sessions: 80, cartAdds: 3, checkouts: 1,
      topPaths: [{ path: "/storefront/products/mug", views: 90, cartAdds: 3, productId: "p1" }],
    }]);
    expect(inputs.rankings).toHaveLength(1);
    expect(inputs.aiCrawl).toEqual([{ botName: "GPTBot", day: "2026-07-10", hits: 4 }]);
    expect(inputs.allowAiCrawlers).toBe(true);
    expect(inputs.hasOrgDescription).toBe(true);
    expect(inputs.lastPublishedAt).toBe("2026-06-01T00:00:00Z");
    expect(mocks.getProductMock).toHaveBeenCalledWith(SHOP, "mug");
    expect(inputs.jsonLdIssues[0]).toMatchObject({ productId: "p1", handle: "mug" });
    expect(inputs.jsonLdIssues[0].issues.length).toBeGreaterThan(0);
  });
  it("uses the published bundle version's created_at on runtime 1", async () => {
    const traffic = tableStub({ data: [], error: null });
    const crawl = tableStub({ data: [], error: null });
    const version = tableStub({ data: { created_at: "2026-07-01T00:00:00Z" }, error: null });
    mocks.fromMock.mockImplementation((table: string) => {
      if (table === "radar_traffic_daily") return traffic;
      if (table === "seo_ai_crawl_daily") return crawl;
      if (table === "storefront_bundle_version") return version;
      throw new Error(`unexpected table ${table}`);
    });
    mocks.releaseStateMock.mockResolvedValue({
      draftVersionId: null, publishedVersionId: "22222222-2222-3333-4444-555555555555",
      draftRuntimeVersion: null, publishedRuntimeVersion: 1,
    });
    const inputs = await loadRadarInputs(SHOP);
    expect(inputs.lastPublishedAt).toBe("2026-07-01T00:00:00Z");
    expect(inputs.jsonLdIssues).toEqual([]); // no traffic -> no pages to check
  });
  it("caps the JSON-LD sweep", () => {
    expect(JSONLD_CHECK_MAX_PAGES).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/collect.server.test.ts`
Expected: FAIL - `Cannot find module '../collect.server'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/radar/collect.server.ts
// Per-shop nightly collection: roll storefront_event up into radar_traffic_daily
// (server-side RPC - PostgREST clamps row reads at 1000) and assemble the
// bounded inputs the detectors consume. Rankings/AEO data comes from the seo
// subsystem's tables; nothing is duplicated here.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { buildProductDraft } from "~/lib/seo/writer.server";
import { validateDraft } from "~/lib/seo/validator.server";
import { readStorefrontReleaseState } from "~/lib/storefront-bundle/build.server";
import { parseStorefrontPath } from "./detect.server";
import type { AiCrawlDay, JsonLdCheckedPage, RadarCollectInputs, RankingSeries, TrafficDay, TrafficPath } from "./types";

export const ROLLUP_DAYS = 10;
export const TRAFFIC_WINDOW_DAYS = 35; // bounded: at most 35 rows per shop
export const CRAWL_WINDOW_DAYS = 28; // bounded: <= 28 days x 13 known bots
export const JSONLD_CHECK_MAX_PAGES = 10;

const DAY_MS = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

export async function collectShop(shopId: string): Promise<void> {
  if (!isUuid(shopId)) return; // demo/fixture tenants have no rows
  const sb = getSupabase();
  const { error } = await sb.rpc("radar_rollup_traffic", { p_shop: shopId, p_days: ROLLUP_DAYS });
  if (error) throw new Error(`radar_rollup_traffic: ${error.message}`);
  const stamp = await sb.from("radar_state").upsert(
    { shop_id: shopId, last_collected_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "shop_id" },
  );
  if (stamp.error) throw new Error(`radar_state stamp: ${stamp.error.message}`);
}

function mapTraffic(rows: Array<Record<string, unknown>>): TrafficDay[] {
  return rows.map((r) => ({
    day: String(r.day),
    views: Number(r.views ?? 0),
    sessions: Number(r.sessions ?? 0),
    cartAdds: Number(r.cart_adds ?? 0),
    checkouts: Number(r.checkouts ?? 0),
    topPaths: Array.isArray(r.top_paths)
      ? (r.top_paths as Array<Record<string, unknown>>).map((p): TrafficPath => ({
          path: String(p.path ?? ""),
          views: Number(p.views ?? 0),
          cartAdds: Number(p.cartAdds ?? 0),
          productId: p.productId == null ? null : String(p.productId),
        }))
      : [],
  }));
}

/** Last time either storefront runtime published. Legacy uses the home
 *  page_document's updated_at (drafts also bump it - an acceptable staleness
 *  proxy that only ever UNDER-reports staleness, never over). */
async function lastPublishedAt(shopId: string): Promise<string | null> {
  const release = await readStorefrontReleaseState(shopId);
  const sb = getSupabase();
  if (release.publishedRuntimeVersion === 1 && release.publishedVersionId) {
    const { data, error } = await sb
      .from("storefront_bundle_version")
      .select("created_at")
      .eq("shop_id", shopId)
      .eq("id", release.publishedVersionId)
      .maybeSingle();
    if (error) throw new Error(`bundle version read: ${error.message}`);
    return data ? String(data.created_at) : null;
  }
  const { data, error } = await sb
    .from("page_document")
    .select("updated_at, published_json")
    .eq("shop_id", shopId)
    .eq("page_key", "home")
    .maybeSingle();
  if (error) throw new Error(`page_document read: ${error.message}`);
  return data?.published_json ? String(data.updated_at) : null;
}

/** Run the REAL seo writer + validator over the shop's most-viewed products so
 *  jsonld moves only ever report what the storefront would actually serve. */
async function checkTopProductJsonLd(shopId: string, traffic: TrafficDay[]): Promise<JsonLdCheckedPage[]> {
  const origin = await getShopStorefrontOrigin(shopId);
  if (!origin) return [];
  const views = new Map<string, number>();
  for (const d of traffic.slice(-7)) {
    for (const p of d.topPaths) {
      const ref = parseStorefrontPath(p.path);
      if (ref.entityType === "product" && ref.handle) {
        views.set(ref.handle, (views.get(ref.handle) ?? 0) + p.views);
      }
    }
  }
  const handles = [...views.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, JSONLD_CHECK_MAX_PAGES)
    .map(([handle]) => handle);
  if (handles.length === 0) return [];
  const store = await getStoreSettings(shopId);
  const out: JsonLdCheckedPage[] = [];
  for (const handle of handles) {
    const product = await getCatalog().getProduct(shopId, handle);
    if (!product) continue;
    const draft = buildProductDraft(product, store, origin);
    const issues = validateDraft(draft)
      .filter((i) => i.field === "jsonLd")
      .map((i) => i.message);
    out.push({ productId: product.id, handle, title: product.title || handle, issues });
  }
  return out;
}

export async function loadRadarInputs(shopId: string): Promise<RadarCollectInputs> {
  const sb = getSupabase();
  const [trafficRes, seriesRes, crawlRes, seo] = await Promise.all([
    sb.from("radar_traffic_daily")
      .select("day, views, sessions, cart_adds, checkouts, top_paths")
      .eq("shop_id", shopId)
      .gte("day", isoDaysAgo(TRAFFIC_WINDOW_DAYS))
      .order("day"),
    sb.rpc("read_radar_ranking_series", { p_shop: shopId }),
    sb.from("seo_ai_crawl_daily")
      .select("bot_name, day, hits")
      .eq("shop_id", shopId)
      .gte("day", isoDaysAgo(CRAWL_WINDOW_DAYS)),
    getSeoSettings(shopId),
  ]);
  if (trafficRes.error) throw new Error(`radar_traffic_daily read: ${trafficRes.error.message}`);
  if (seriesRes.error) throw new Error(`read_radar_ranking_series: ${seriesRes.error.message}`);
  if (crawlRes.error) throw new Error(`seo_ai_crawl_daily read: ${crawlRes.error.message}`);

  const traffic = mapTraffic((trafficRes.data ?? []) as Array<Record<string, unknown>>);
  const rankings = (Array.isArray(seriesRes.data) ? seriesRes.data : []) as RankingSeries[];
  const aiCrawl: AiCrawlDay[] = ((crawlRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    botName: String(r.bot_name),
    day: String(r.day),
    hits: Number(r.hits ?? 0),
  }));
  const [publishedAt, jsonLdIssues] = await Promise.all([
    lastPublishedAt(shopId),
    checkTopProductJsonLd(shopId, traffic),
  ]);
  return {
    traffic,
    rankings,
    aiCrawl,
    allowAiCrawlers: seo.allowAiCrawlers,
    hasOrgDescription: Boolean(seo.orgDescription?.trim()),
    lastPublishedAt: publishedAt,
    jsonLdIssues,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/collect.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/collect.server.ts app/lib/radar/__tests__/collect.server.test.ts
git commit -m "radar/collect: traffic rollup call + bounded detector-input assembly"
```

---

### Task 6: Move store + cooldowns + expiry (`app/lib/radar/store.server.ts`)

**Files:**
- Create: `app/lib/radar/store.server.ts`
- Test: `app/lib/radar/__tests__/store.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`, `isUuid`, Task 2 types.
- Produces (used by Tasks 7, 10-12):
  - `insertDraftMove(shopId, c: RadarCandidate): Promise<"inserted" | "duplicate">` - tolerates the partial-unique-index race (`23505`).
  - `listMoves(shopId, statuses: RadarMoveStatus[], limit = 50): Promise<RadarMoveRow[]>`
  - `listRecentMoveRows(shopId, sinceDays = 45): Promise<RadarMoveRow[]>` - cooldown lookback.
  - `getMove(shopId, moveId): Promise<RadarMoveRow | null>`
  - `updateMove(shopId, moveId, patch): Promise<void>`
  - `expireStaleMoves(shopId, now?): Promise<number>`
  - `isCoolingDown(rows, candidate, now?): boolean` (pure)
  - `readRadarState(shopId)`, `stampRadarState(shopId, patch)`
  - Constants `DISMISS_COOLDOWN_DAYS = 30`, `EXPIRE_COOLDOWN_DAYS = 14`, `APPLY_COOLDOWN_DAYS = 14`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/store.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

import {
  expireStaleMoves,
  getMove,
  insertDraftMove,
  isCoolingDown,
  listMoves,
  stampRadarState,
  updateMove,
} from "../store.server";
import type { RadarCandidate, RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-07-20T10:00:00Z");

const CANDIDATE: RadarCandidate = {
  kind: "seo_meta_rewrite",
  dedupKey: "ctr-low:u:q",
  headline: "h",
  rationale: "r",
  evidence: { chips: [], facts: {} },
  payload: { applyMode: "publish_meta" },
};

function row(patch: Partial<RadarMoveRow>): RadarMoveRow {
  return {
    id: "m1", shopId: SHOP, kind: "seo_meta_rewrite", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: {}, dedupKey: "ctr-low:u:q", priorState: null, appliedStateHash: null,
    createdAt: "2026-07-19T00:00:00Z", appliedAt: null, resolvedAt: null,
    expiresAt: "2026-08-02T00:00:00Z", ...patch,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("isCoolingDown", () => {
  it("blocks on an open draft, a 30-day dismissal and a 14-day expiry", () => {
    expect(isCoolingDown([row({ status: "draft" })], CANDIDATE, NOW)).toBe(true);
    expect(isCoolingDown([row({ status: "dismissed", resolvedAt: "2026-07-01T00:00:00Z" })], CANDIDATE, NOW)).toBe(true);
    expect(isCoolingDown([row({ status: "expired", resolvedAt: "2026-07-10T00:00:00Z" })], CANDIDATE, NOW)).toBe(true);
    expect(isCoolingDown([row({ status: "applied", appliedAt: "2026-07-15T00:00:00Z" })], CANDIDATE, NOW)).toBe(true);
  });
  it("lets the cooldowns lapse and ignores other dedup keys", () => {
    expect(isCoolingDown([row({ status: "dismissed", resolvedAt: "2026-06-01T00:00:00Z" })], CANDIDATE, NOW)).toBe(false);
    expect(isCoolingDown([row({ status: "expired", resolvedAt: "2026-07-01T00:00:00Z" })], CANDIDATE, NOW)).toBe(false);
    expect(isCoolingDown([row({ status: "draft", dedupKey: "other" })], CANDIDATE, NOW)).toBe(false);
    expect(isCoolingDown([row({ status: "draft", kind: "seo_content_boost" })], CANDIDATE, NOW)).toBe(false);
  });
});

describe("insertDraftMove", () => {
  it("inserts and reports a duplicate-key race as 'duplicate'", async () => {
    const insert = vi.fn().mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: "23505", message: "dup" } })
      .mockResolvedValueOnce({ error: { code: "XX000", message: "down" } });
    fromMock.mockReturnValue({ insert });
    await expect(insertDraftMove(SHOP, CANDIDATE)).resolves.toBe("inserted");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      shop_id: SHOP, kind: "seo_meta_rewrite", status: "draft",
      dedup_key: "ctr-low:u:q", headline: "h", rationale: "r",
    }));
    await expect(insertDraftMove(SHOP, CANDIDATE)).resolves.toBe("duplicate");
    await expect(insertDraftMove(SHOP, CANDIDATE)).rejects.toThrow(/down/);
  });
});

describe("row reads and transitions", () => {
  it("maps snake_case rows to RadarMoveRow", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{
          id: "m1", shop_id: SHOP, kind: "section_refresh", status: "draft",
          headline: "h", rationale: "r", evidence: { chips: ["a"], facts: {} },
          payload: { applyMode: "refresh_section" }, dedup_key: "stale:home",
          prior_state: null, applied_state_hash: null,
          created_at: "c", applied_at: null, resolved_at: null, expires_at: "e",
        }],
        error: null,
      }),
    };
    fromMock.mockReturnValue(chain);
    const rows = await listMoves(SHOP, ["draft"]);
    expect(rows).toEqual([expect.objectContaining({
      id: "m1", shopId: SHOP, kind: "section_refresh", dedupKey: "stale:home",
      payload: { applyMode: "refresh_section" }, createdAt: "c", expiresAt: "e",
    })]);
    expect(chain.in).toHaveBeenCalledWith("status", ["draft"]);
  });
  it("getMove scopes by shop and id", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const chain = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
    fromMock.mockReturnValue(chain);
    await expect(getMove(SHOP, "m1")).resolves.toBeNull();
    expect(chain.eq).toHaveBeenCalledWith("shop_id", SHOP);
    expect(chain.eq).toHaveBeenCalledWith("id", "m1");
  });
  it("updateMove writes only the mapped columns", async () => {
    const eqId = vi.fn().mockResolvedValue({ error: null });
    const eqShop = vi.fn().mockReturnValue({ eq: eqId });
    const update = vi.fn().mockReturnValue({ eq: eqShop });
    fromMock.mockReturnValue({ update });
    await updateMove(SHOP, "m1", { status: "applied", appliedAt: "t", priorState: { a: 1 }, appliedStateHash: "x" });
    expect(update).toHaveBeenCalledWith({
      status: "applied", applied_at: "t", prior_state: { a: 1 }, applied_state_hash: "x",
    });
  });
  it("expireStaleMoves sweeps open drafts past their expiry", async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: "m1" }, { id: "m2" }], error: null });
    const lt = vi.fn().mockReturnValue({ select });
    const eqStatus = vi.fn().mockReturnValue({ lt });
    const eqShop = vi.fn().mockReturnValue({ eq: eqStatus });
    const update = vi.fn().mockReturnValue({ eq: eqShop });
    fromMock.mockReturnValue({ update });
    await expect(expireStaleMoves(SHOP, NOW)).resolves.toBe(2);
    expect(update).toHaveBeenCalledWith({ status: "expired", resolved_at: NOW.toISOString() });
    expect(lt).toHaveBeenCalledWith("expires_at", NOW.toISOString());
  });
  it("stampRadarState upserts the requested cursor fields", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await stampRadarState(SHOP, { lastDraftedAt: "t1", homeCardDismissedAt: "t2" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: SHOP, last_drafted_at: "t1", home_card_dismissed_at: "t2" }),
      { onConflict: "shop_id" },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/store.server.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/radar/store.server.ts
// Persistence for radar_ploy (merchant label: "move") and radar_state. Service
// role client, shop_id threaded on every query; snake_case never escapes this
// module. The partial unique index (shop_id, kind, dedup_key) WHERE draft is
// the dedup backstop - insertDraftMove treats 23505 as "someone else won".
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import type { RadarCandidate, RadarEvidence, RadarMoveKind, RadarMoveRow, RadarMoveStatus } from "./types";

export const DISMISS_COOLDOWN_DAYS = 30;
export const EXPIRE_COOLDOWN_DAYS = 14;
/** Judgment call (spec is silent): a just-applied fix must not re-draft off
 *  lagged data the very next night. */
export const APPLY_COOLDOWN_DAYS = 14;

const DAY_MS = 86_400_000;
const MOVE_COLUMNS =
  "id, shop_id, kind, status, headline, rationale, evidence, payload, dedup_key, " +
  "prior_state, applied_state_hash, created_at, applied_at, resolved_at, expires_at";

function mapRow(r: Record<string, unknown>): RadarMoveRow {
  return {
    id: String(r.id),
    shopId: String(r.shop_id),
    kind: r.kind as RadarMoveKind,
    status: r.status as RadarMoveStatus,
    headline: String(r.headline),
    rationale: String(r.rationale),
    evidence: (r.evidence ?? { chips: [], facts: {} }) as RadarEvidence,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    dedupKey: String(r.dedup_key),
    priorState: (r.prior_state as Record<string, unknown> | null) ?? null,
    appliedStateHash: (r.applied_state_hash as string | null) ?? null,
    createdAt: String(r.created_at),
    appliedAt: (r.applied_at as string | null) ?? null,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    expiresAt: String(r.expires_at),
  };
}

export async function insertDraftMove(shopId: string, c: RadarCandidate): Promise<"inserted" | "duplicate"> {
  if (!isUuid(shopId)) throw new Error(`insertDraftMove requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("radar_ploy").insert({
    shop_id: shopId,
    kind: c.kind,
    status: "draft",
    headline: c.headline,
    rationale: c.rationale,
    evidence: c.evidence,
    payload: c.payload,
    dedup_key: c.dedupKey,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw new Error(`insertDraftMove: ${error.message}`);
  }
  return "inserted";
}

export async function listMoves(
  shopId: string,
  statuses: RadarMoveStatus[],
  limit = 50,
): Promise<RadarMoveRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .select(MOVE_COLUMNS)
    .eq("shop_id", shopId)
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listMoves: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapRow);
}

/** Recent rows across ALL statuses for the drafter's cooldown checks. */
export async function listRecentMoveRows(shopId: string, sinceDays = 45): Promise<RadarMoveRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .select(MOVE_COLUMNS)
    .eq("shop_id", shopId)
    .gte("created_at", new Date(Date.now() - sinceDays * DAY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`listRecentMoveRows: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapRow);
}

export async function getMove(shopId: string, moveId: string): Promise<RadarMoveRow | null> {
  if (!isUuid(shopId) || !isUuid(moveId)) return null;
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .select(MOVE_COLUMNS)
    .eq("shop_id", shopId)
    .eq("id", moveId)
    .maybeSingle();
  if (error) throw new Error(`getMove: ${error.message}`);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function updateMove(
  shopId: string,
  moveId: string,
  patch: Partial<{
    status: RadarMoveStatus;
    appliedAt: string | null;
    resolvedAt: string | null;
    priorState: Record<string, unknown> | null;
    appliedStateHash: string | null;
    payload: Record<string, unknown>;
  }>,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.appliedAt !== undefined) row.applied_at = patch.appliedAt;
  if (patch.resolvedAt !== undefined) row.resolved_at = patch.resolvedAt;
  if (patch.priorState !== undefined) row.prior_state = patch.priorState;
  if (patch.appliedStateHash !== undefined) row.applied_state_hash = patch.appliedStateHash;
  if (patch.payload !== undefined) row.payload = patch.payload;
  const { error } = await getSupabase()
    .from("radar_ploy")
    .update(row)
    .eq("shop_id", shopId)
    .eq("id", moveId);
  if (error) throw new Error(`updateMove: ${error.message}`);
}

/** Sweep open drafts past expires_at. Returns how many were expired. */
export async function expireStaleMoves(shopId: string, now: Date = new Date()): Promise<number> {
  if (!isUuid(shopId)) return 0;
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .update({ status: "expired", resolved_at: now.toISOString() })
    .eq("shop_id", shopId)
    .eq("status", "draft")
    .lt("expires_at", now.toISOString())
    .select("id");
  if (error) throw new Error(`expireStaleMoves: ${error.message}`);
  return (data ?? []).length;
}

/** Pure cooldown rule: a candidate is blocked while an open draft exists, or
 *  within 30 days of a dismissal / 14 days of an expiry / 14 days of an apply
 *  on the same (kind, dedup_key). */
export function isCoolingDown(
  rows: RadarMoveRow[],
  candidate: Pick<RadarCandidate, "kind" | "dedupKey">,
  now: Date = new Date(),
): boolean {
  const t = now.getTime();
  for (const r of rows) {
    if (r.kind !== candidate.kind || r.dedupKey !== candidate.dedupKey) continue;
    if (r.status === "draft") return true;
    if (r.status === "dismissed" && r.resolvedAt
      && t - Date.parse(r.resolvedAt) < DISMISS_COOLDOWN_DAYS * DAY_MS) return true;
    if (r.status === "expired" && r.resolvedAt
      && t - Date.parse(r.resolvedAt) < EXPIRE_COOLDOWN_DAYS * DAY_MS) return true;
    if (r.status === "applied" && r.appliedAt
      && t - Date.parse(r.appliedAt) < APPLY_COOLDOWN_DAYS * DAY_MS) return true;
  }
  return false;
}

export interface RadarState {
  lastCollectedAt: string | null;
  lastDraftedAt: string | null;
  homeCardDismissedAt: string | null;
}

export async function readRadarState(shopId: string): Promise<RadarState> {
  if (!isUuid(shopId)) return { lastCollectedAt: null, lastDraftedAt: null, homeCardDismissedAt: null };
  const { data, error } = await getSupabase()
    .from("radar_state")
    .select("last_collected_at, last_drafted_at, home_card_dismissed_at")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`readRadarState: ${error.message}`);
  return {
    lastCollectedAt: (data?.last_collected_at as string | null) ?? null,
    lastDraftedAt: (data?.last_drafted_at as string | null) ?? null,
    homeCardDismissedAt: (data?.home_card_dismissed_at as string | null) ?? null,
  };
}

export async function stampRadarState(
  shopId: string,
  patch: Partial<{ lastCollectedAt: string; lastDraftedAt: string; homeCardDismissedAt: string }>,
): Promise<void> {
  if (!isUuid(shopId)) return;
  const row: Record<string, unknown> = { shop_id: shopId, updated_at: new Date().toISOString() };
  if (patch.lastCollectedAt !== undefined) row.last_collected_at = patch.lastCollectedAt;
  if (patch.lastDraftedAt !== undefined) row.last_drafted_at = patch.lastDraftedAt;
  if (patch.homeCardDismissedAt !== undefined) row.home_card_dismissed_at = patch.homeCardDismissedAt;
  const { error } = await getSupabase().from("radar_state").upsert(row, { onConflict: "shop_id" });
  if (error) throw new Error(`stampRadarState: ${error.message}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/store.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/store.server.ts app/lib/radar/__tests__/store.server.test.ts
git commit -m "radar/store: move rows, dedup-safe insert, cooldowns, expiry sweep, state cursors"
```

---

### Task 7: Drafter (`app/lib/radar/draft.server.ts`)

**Files:**
- Create: `app/lib/radar/draft.server.ts`
- Test: `app/lib/radar/__tests__/draft.server.test.ts`

**Interfaces:**
- Consumes: `loadRadarInputs` (Task 5), `detectAll` (Task 3), store module (Task 6), `checkAiQuota` (Task 4), `getAnthropic`/`radarDraftModel` (Task 4).
- Produces (used by Task 8): `draftShopMoves(shopId, now?): Promise<{ expired: number; drafted: number; polished: number; skipped: number }>`; constant `RADAR_NIGHTLY_CLAUDE_CAP = 5`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/draft.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadRadarInputs: vi.fn(),
  detectAll: vi.fn(),
  expireStaleMoves: vi.fn(),
  listRecentMoveRows: vi.fn(),
  insertDraftMove: vi.fn(),
  isCoolingDown: vi.fn(),
  stampRadarState: vi.fn(),
  checkAiQuota: vi.fn(),
  createMock: vi.fn(),
}));
vi.mock("../collect.server", () => ({ loadRadarInputs: mocks.loadRadarInputs }));
vi.mock("../detect.server", () => ({ detectAll: mocks.detectAll }));
vi.mock("../store.server", () => ({
  expireStaleMoves: mocks.expireStaleMoves,
  listRecentMoveRows: mocks.listRecentMoveRows,
  insertDraftMove: mocks.insertDraftMove,
  isCoolingDown: mocks.isCoolingDown,
  stampRadarState: mocks.stampRadarState,
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.checkAiQuota }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: mocks.createMock } }),
  radarDraftModel: () => "test-model",
}));

import { draftShopMoves, RADAR_NIGHTLY_CLAUDE_CAP } from "../draft.server";
import type { RadarCandidate } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";

function candidate(n: number): RadarCandidate {
  return {
    kind: "seo_meta_rewrite",
    dedupKey: `c${n}`,
    headline: `Template headline ${n}`,
    rationale: `Template rationale ${n}`,
    evidence: { chips: [], facts: { n } },
    payload: { applyMode: "publish_meta" },
  };
}

function claudeReply(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadRadarInputs.mockResolvedValue({});
  mocks.expireStaleMoves.mockResolvedValue(0);
  mocks.listRecentMoveRows.mockResolvedValue([]);
  mocks.insertDraftMove.mockResolvedValue("inserted");
  mocks.isCoolingDown.mockReturnValue(false);
  mocks.checkAiQuota.mockResolvedValue({ allowed: true });
  mocks.createMock.mockResolvedValue(claudeReply('{"headline":"Polished","rationale":"Better words."}'));
});

describe("draftShopMoves", () => {
  it("polishes at most 5 candidates, checking quota immediately before each call", async () => {
    mocks.detectAll.mockReturnValue([1, 2, 3, 4, 5, 6, 7].map(candidate));
    const out = await draftShopMoves(SHOP);
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar", trusted: true });
    expect(mocks.createMock).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
    expect(mocks.insertDraftMove).toHaveBeenCalledTimes(7);
    // Polished copy on the first five, template copy on the rest.
    expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({ headline: "Polished" });
    expect(mocks.insertDraftMove.mock.calls[5][1]).toMatchObject({ headline: "Template headline 6" });
    expect(out).toMatchObject({ drafted: 7, polished: 5 });
  });
  it("quota denial stops Claude spend but drafting continues on templates", async () => {
    mocks.detectAll.mockReturnValue([1, 2, 3].map(candidate));
    mocks.checkAiQuota.mockResolvedValue({ allowed: false, code: "ai_daily_limit", message: "cap" });
    const out = await draftShopMoves(SHOP);
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(1);
    expect(mocks.createMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ drafted: 3, polished: 0 });
    expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({ headline: "Template headline 1" });
  });
  it("falls back to the template when Claude fails, returns junk, or says the internal word", async () => {
    mocks.detectAll.mockReturnValue([1, 2, 3].map(candidate));
    mocks.createMock
      .mockRejectedValueOnce(new Error("api down"))
      .mockResolvedValueOnce(claudeReply("not json"))
      .mockResolvedValueOnce(claudeReply('{"headline":"A clever ploy","rationale":"x"}'));
    const out = await draftShopMoves(SHOP);
    expect(out).toMatchObject({ drafted: 3, polished: 0 });
    for (const call of mocks.insertDraftMove.mock.calls) {
      expect(call[1].headline).toMatch(/^Template headline/);
    }
  });
  it("skips cooling-down candidates and counts duplicates as skipped", async () => {
    mocks.detectAll.mockReturnValue([1, 2].map(candidate));
    mocks.isCoolingDown.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mocks.insertDraftMove.mockResolvedValueOnce("duplicate");
    const out = await draftShopMoves(SHOP);
    expect(mocks.insertDraftMove).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ drafted: 0, skipped: 2 });
  });
  it("sweeps expiry first and stamps the draft cursor last", async () => {
    mocks.detectAll.mockReturnValue([]);
    mocks.expireStaleMoves.mockResolvedValue(2);
    const out = await draftShopMoves(SHOP);
    expect(out.expired).toBe(2);
    expect(mocks.stampRadarState).toHaveBeenCalledWith(SHOP, { lastDraftedAt: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/draft.server.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/radar/draft.server.ts
// Overnight drafter: detectors -> cooldown filter -> radar_ploy rows. Claude's
// only job here is polishing the deterministic template copy (headline +
// rationale) for up to RADAR_NIGHTLY_CLAUDE_CAP candidates per shop per night;
// every failure path lands on the template, so a Claude outage costs polish,
// never coverage. checkAiQuota is called immediately before each request (the
// check records a hit) and this loop ALSO hard-caps itself so quota-bypassed
// dev shops cannot overspend.
import { checkAiQuota } from "~/lib/ai-quota.server";
import { getAnthropic, radarDraftModel } from "~/lib/assistant/anthropic.server";
import { loadRadarInputs } from "./collect.server";
import { detectAll } from "./detect.server";
import {
  expireStaleMoves,
  insertDraftMove,
  isCoolingDown,
  listRecentMoveRows,
  stampRadarState,
} from "./store.server";
import type { RadarCandidate } from "./types";

export const RADAR_NIGHTLY_CLAUDE_CAP = 5;
const HEADLINE_MAX = 90;
const RATIONALE_MAX = 240;

const POLISH_SYSTEM =
  "You polish short dashboard copy for an online-store owner. Rewrite the given headline and rationale " +
  "in plain, concrete, encouraging language a non-technical merchant instantly understands. Keep every " +
  "number and quoted search phrase exactly as given. No jargon, no exclamation marks, no emoji. " +
  'Respond with JSON only: {"headline":"...","rationale":"..."}';

type PolishResult = { headline: string; rationale: string } | "quota_exhausted" | null;

async function polish(shopId: string, c: RadarCandidate): Promise<PolishResult> {
  const verdict = await checkAiQuota({ shopId, feature: "radar", trusted: true });
  if (!verdict.allowed) return "quota_exhausted";
  try {
    const res = await getAnthropic().messages.create({
      model: radarDraftModel(),
      max_tokens: 300,
      system: POLISH_SYSTEM,
      messages: [{
        role: "user",
        content: JSON.stringify({ headline: c.headline, rationale: c.rationale, facts: c.evidence.facts }),
      }],
    });
    const text = res.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")?.text ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as { headline?: unknown; rationale?: unknown };
    const headline = typeof parsed.headline === "string" ? parsed.headline.trim() : "";
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    if (!headline || !rationale) return null;
    if (headline.length > HEADLINE_MAX || rationale.length > RATIONALE_MAX) return null;
    // The internal noun must never reach merchant copy, even via the model.
    if (/ploy/i.test(`${headline} ${rationale}`)) return null;
    return { headline, rationale };
  } catch (err) {
    console.error(`[radar] draft polish failed for shop ${shopId}`, err);
    return null;
  }
}

export interface DraftSummary {
  expired: number;
  drafted: number;
  polished: number;
  skipped: number;
}

export async function draftShopMoves(shopId: string, now: Date = new Date()): Promise<DraftSummary> {
  const expired = await expireStaleMoves(shopId, now);
  const inputs = await loadRadarInputs(shopId);
  const candidates = detectAll(inputs, now);
  const recent = await listRecentMoveRows(shopId);

  let drafted = 0;
  let polished = 0;
  let skipped = 0;
  let claudeOpen = true;

  for (const c of candidates) {
    if (isCoolingDown(recent, c, now)) {
      skipped++;
      continue;
    }
    let copy = { headline: c.headline, rationale: c.rationale };
    if (claudeOpen && polished < RADAR_NIGHTLY_CLAUDE_CAP) {
      const p = await polish(shopId, c);
      if (p === "quota_exhausted") claudeOpen = false; // stop spending; templates carry the rest
      else if (p) {
        copy = p;
        polished++;
      }
      // p === null (API/parse failure): keep trying the next candidates - the
      // cap and quota still bound total spend.
    }
    const res = await insertDraftMove(shopId, { ...c, headline: copy.headline, rationale: copy.rationale });
    if (res === "inserted") drafted++;
    else skipped++;
  }

  await stampRadarState(shopId, { lastDraftedAt: now.toISOString() });
  return { expired, drafted, polished, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/draft.server.test.ts`
Expected: PASS. Note the third test: two failures then a "ploy"-containing reply - all three land on templates and `polished` stays 0, while `createMock` was still called 3 times (failures do not close the loop; only quota denial does).

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/draft.server.ts app/lib/radar/__tests__/draft.server.test.ts
git commit -m "radar/draft: nightly drafter with 5-call Claude cap, cooldowns and template fallback"
```

---

### Task 8: Nightly crons (`cron.radar-collect`, `cron.radar-draft`)

**Files:**
- Create: `app/routes/cron.radar-collect.tsx`
- Create: `app/routes/cron.radar-draft.tsx`
- Modify: `vercel.json` (two new `crons` entries)
- Test: `app/routes/__tests__/cron.radar.test.ts`

**Interfaces:**
- Consumes: `isAuthorizedCron`; `radar_shop_queue` RPC (Task 1); `collectShop` (Task 5); `draftShopMoves` (Task 7).
- Produces: `GET /cron/radar-collect` -> `{ collected, failed, skipped }`; `GET /cron/radar-draft` -> `{ drafted, failed, skipped }`. Both: Bearer `CRON_SECRET`, 50s time budget, per-shop try/catch, cursor fairness via the queue RPC (a budget-limited run leaves unprocessed shops at the front of tomorrow's queue - the resumable pattern).

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/cron.radar.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  collectShop: vi.fn(),
  draftShopMoves: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc: mocks.rpcMock }) }));
vi.mock("~/lib/radar/collect.server", () => ({ collectShop: mocks.collectShop }));
vi.mock("~/lib/radar/draft.server", () => ({ draftShopMoves: mocks.draftShopMoves }));

import { loader as collectLoader } from "../cron.radar-collect";
import { loader as draftLoader } from "../cron.radar-draft";

function req(path: string, auth?: string): never {
  return {
    request: new Request(`https://x${path}`, { headers: auth ? { authorization: auth } : {} }),
    params: {},
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "sekrit";
  mocks.rpcMock.mockResolvedValue({ data: [{ shop_id: "s1" }, { shop_id: "s2" }], error: null });
});

describe("cron.radar-collect", () => {
  it("401s without the bearer secret", async () => {
    const res = await collectLoader(req("/cron/radar-collect"));
    expect(res.status).toBe(401);
    expect(mocks.rpcMock).not.toHaveBeenCalled();
  });
  it("drains the collect queue with per-shop isolation", async () => {
    mocks.collectShop.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("shop down"));
    const res = await collectLoader(req("/cron/radar-collect", "Bearer sekrit"));
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_shop_queue", { p_for: "collect", p_limit: 500 });
    const body = await res.json();
    expect(body).toMatchObject({ collected: 1, failed: 1, skipped: false });
    expect(mocks.collectShop).toHaveBeenCalledTimes(2);
  });
  it("500s with the queue error surfaced", async () => {
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "queue broke" } });
    const res = await collectLoader(req("/cron/radar-collect", "Bearer sekrit"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("queue broke");
  });
});

describe("cron.radar-draft", () => {
  it("drains the draft queue and totals the summaries", async () => {
    mocks.draftShopMoves
      .mockResolvedValueOnce({ expired: 1, drafted: 2, polished: 1, skipped: 0 })
      .mockRejectedValueOnce(new Error("nope"));
    const res = await draftLoader(req("/cron/radar-draft", "Bearer sekrit"));
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_shop_queue", { p_for: "draft", p_limit: 500 });
    const body = await res.json();
    expect(body).toMatchObject({ drafted: 2, failed: 1, skipped: false });
  });
  it("401s without the bearer secret", async () => {
    const res = await draftLoader(req("/cron/radar-draft"));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.radar.test.ts`
Expected: FAIL - modules not found.

- [ ] **Step 3: Write both cron routes**

```tsx
// app/routes/cron.radar-collect.tsx
// Nightly Radar collection: per-shop traffic rollup with cursor fairness.
// radar_shop_queue orders by radar_state.last_collected_at (nulls first), and
// collectShop stamps the cursor on success - so a run that dies at the time
// budget resumes exactly where it stopped, and no shop is ever starved (the
// same resumable-drain shape as cron.import / cron.seo-rankings).
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { collectShop } from "~/lib/radar/collect.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase().rpc("radar_shop_queue", { p_for: "collect", p_limit: 500 });
  if (error) return json({ error: `radar_shop_queue: ${error.message}` }, { status: 500 });
  let collected = 0;
  let failed = 0;
  let skipped = false;
  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped = true;
      break;
    }
    try {
      await collectShop(row.shop_id);
      collected++;
    } catch (err) {
      failed++;
      console.error(`[cron.radar-collect] shop ${row.shop_id} failed`, err);
    }
  }
  console.log(`[cron.radar-collect] collected ${collected}, failed ${failed} in ${Date.now() - started}ms`);
  return json({ collected, failed, skipped });
};
```

```tsx
// app/routes/cron.radar-draft.tsx
// Nightly Radar drafting, scheduled after radar-collect (and after the
// seo-rankings pull) so detectors see tonight's data. Same cursor-fairness
// resumable drain; a failed shop logs and never halts the queue.
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { draftShopMoves } from "~/lib/radar/draft.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase().rpc("radar_shop_queue", { p_for: "draft", p_limit: 500 });
  if (error) return json({ error: `radar_shop_queue: ${error.message}` }, { status: 500 });
  let drafted = 0;
  let expired = 0;
  let failed = 0;
  let skipped = false;
  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped = true;
      break;
    }
    try {
      const summary = await draftShopMoves(row.shop_id);
      drafted += summary.drafted;
      expired += summary.expired;
    } catch (err) {
      failed++;
      console.error(`[cron.radar-draft] shop ${row.shop_id} failed`, err);
    }
  }
  console.log(`[cron.radar-draft] drafted ${drafted}, expired ${expired}, failed ${failed} in ${Date.now() - started}ms`);
  return json({ drafted, expired, failed, skipped });
};
```

- [ ] **Step 4: Run tests, then register the crons**

Run: `npx vitest run app/routes/__tests__/cron.radar.test.ts`
Expected: PASS.

Add to the `crons` array in `vercel.json` (keep existing entries untouched; collect at 10:00 UTC and draft at 10:30 UTC so both run after `/cron/seo-rankings` at 09:30 and the morning list is ready for North-American merchants):

```json
{ "path": "/cron/radar-collect", "schedule": "0 10 * * *" },
{ "path": "/cron/radar-draft", "schedule": "30 10 * * *" }
```

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.radar-collect.tsx app/routes/cron.radar-draft.tsx app/routes/__tests__/cron.radar.test.ts vercel.json
git commit -m "cron/radar: resumable nightly collect + draft drains with cursor fairness"
```

---

### Task 9: SEO/AEO apply module (`app/lib/radar/apply-seo.server.ts`)

**Files:**
- Create: `app/lib/radar/apply-seo.server.ts`
- Modify: `app/lib/seo/validator.server.ts` (extract `validateMeta` - shared bounds, no behavior change)
- Test: `app/lib/radar/__tests__/apply-seo.server.test.ts`

**Interfaces:**
- Consumes: `getCatalog`, `getStoreSettings`; `getSeoOverride`/`upsertSeoOverride`/`deleteSeoOverride`/`getSeoSettings`/`upsertSeoSettings` (`~/lib/seo/seo-store.server`); `buildStoreDescription` + `clampTitle`/`clampText`/`plainText` (`~/lib/seo/writer.server`, `~/lib/seo/text`); `validateMeta` (new export).
- Produces (used by Task 10's orchestrator):
  - `class RadarApplyError extends Error { code: string; status: number }`
  - `interface ApplyOutcome { priorState: Record<string, unknown> | null; appliedStateHash: string | null }`
  - `sha256(value: unknown): string`
  - `deterministicMeta(product, focusQuery, store): { title: string; description: string }` (writer-composed, always within validator bounds)
  - `applySeoMeta(shopId, move, actorId): Promise<ApplyOutcome>` / `revertSeoMeta(shopId, move, opts: { confirm: boolean }, actorId): Promise<void>`
  - `applyOrgRefresh(shopId, move): Promise<ApplyOutcome>` / `revertOrgRefresh(shopId, move, opts: { confirm: boolean }): Promise<void>`

- [ ] **Step 1: Extract `validateMeta` in the validator (refactor, existing tests stay green)**

In `app/lib/seo/validator.server.ts`, add above `validateDraft`:

```ts
/** Title/description bounds alone - the shared gate for full drafts AND for
 *  meta-only overrides (Radar's SEO moves), so the two paths cannot drift. */
export function validateMeta(title: string, description: string): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const t = title.trim().length;
  if (t < TITLE_MIN || t > TITLE_MAX) issues.push({ field: "title", message: `title must be ${TITLE_MIN}-${TITLE_MAX} chars (got ${t})` });
  const d = description.trim().length;
  if (d < DESC_MIN || d > DESC_MAX) issues.push({ field: "description", message: `description must be ${DESC_MIN}-${DESC_MAX} chars (got ${d})` });
  return issues;
}
```

And change the first three lines of `validateDraft` to reuse it:

```ts
export function validateDraft(draft: SeoDraft): SeoIssue[] {
  const issues: SeoIssue[] = validateMeta(draft.title, draft.description);
  if (!isAbsoluteHttpUrl(draft.canonical)) issues.push({ field: "canonical", message: "canonical must be an absolute http(s) URL" });
  ...rest unchanged
```

Run: `npx vitest run app/lib/seo/__tests__/validator.server.test.ts`
Expected: PASS (pure refactor).

- [ ] **Step 2: Write the failing test**

```ts
// app/lib/radar/__tests__/apply-seo.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  listCollections: vi.fn(),
  listProducts: vi.fn(),
  getStoreSettings: vi.fn(),
  getSeoOverride: vi.fn(),
  upsertSeoOverride: vi.fn(),
  deleteSeoOverride: vi.fn(),
  getSeoSettings: vi.fn(),
  upsertSeoSettings: vi.fn(),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    getProduct: mocks.getProduct,
    listCollections: mocks.listCollections,
    listProducts: mocks.listProducts,
  }),
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: mocks.getStoreSettings }));
vi.mock("~/lib/seo/seo-store.server", () => ({
  getSeoOverride: mocks.getSeoOverride,
  upsertSeoOverride: mocks.upsertSeoOverride,
  deleteSeoOverride: mocks.deleteSeoOverride,
  getSeoSettings: mocks.getSeoSettings,
  upsertSeoSettings: mocks.upsertSeoSettings,
}));

import { validateMeta } from "~/lib/seo/validator.server";
import {
  applyOrgRefresh,
  applySeoMeta,
  deterministicMeta,
  RadarApplyError,
  revertSeoMeta,
  sha256,
} from "../apply-seo.server";
import type { RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const STORE = {
  shopId: SHOP, storeName: "Peak & Pine", logoUrl: null, voiceTagline: "Gear for the trail.",
  palette: { primary: "", background: "", text: "" }, vibe: "minimal", typeStyle: "classic", density: "standard",
};
const PRODUCT = {
  id: "p1", handle: "trail-boots", title: "Trail Boots",
  description: "<p>Waterproof leather boots built for long days on rough ground.</p>",
  images: [], variants: [], collections: [],
};

function move(patch: Partial<RadarMoveRow>): RadarMoveRow {
  return {
    id: "m1", shopId: SHOP, kind: "seo_regression_patch", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: { applyMode: "publish_meta", entityType: "product", handle: "trail-boots", focusQuery: "trail boots" },
    dedupKey: "d", priorState: null, appliedStateHash: null,
    createdAt: "c", appliedAt: null, resolvedAt: null, expiresAt: "e", ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProduct.mockResolvedValue(PRODUCT);
  mocks.getStoreSettings.mockResolvedValue(STORE);
  mocks.getSeoOverride.mockResolvedValue(null);
  mocks.upsertSeoOverride.mockResolvedValue(undefined);
  mocks.deleteSeoOverride.mockResolvedValue(undefined);
  mocks.getSeoSettings.mockResolvedValue({ orgDescription: null });
  mocks.upsertSeoSettings.mockResolvedValue({});
  mocks.listCollections.mockResolvedValue([{ handle: "boots", title: "Hiking Boots" }]);
  mocks.listProducts.mockResolvedValue([PRODUCT]);
});

describe("deterministicMeta", () => {
  it("always lands inside the validator bounds, even for terse products", () => {
    for (const p of [PRODUCT, { ...PRODUCT, title: "X", description: "" }]) {
      const meta = deterministicMeta(p as never, "trail boots", STORE as never);
      expect(validateMeta(meta.title, meta.description)).toEqual([]);
      expect(meta.title.toLowerCase()).toContain("trail boots");
    }
  });
});

describe("applySeoMeta", () => {
  it("publishes a validator-clean product override and records revert state", async () => {
    const out = await applySeoMeta(SHOP, move({}), "u1");
    expect(mocks.upsertSeoOverride).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      entityType: "product", entityId: "p1", updatedBy: "u1",
      metaTitle: expect.any(String), metaDescription: expect.any(String),
    }));
    expect(out.priorState).toMatchObject({ kind: "seo_meta", entityId: "p1", prior: null });
    expect(out.appliedStateHash).toHaveLength(64);
  });
  it("keeps the previous override for revert", async () => {
    mocks.getSeoOverride.mockResolvedValue({ entityType: "product", entityId: "p1", metaTitle: "Old", metaDescription: "Old desc" });
    const out = await applySeoMeta(SHOP, move({}), null);
    expect(out.priorState).toMatchObject({ prior: { metaTitle: "Old", metaDescription: "Old desc" } });
  });
  it("409s when the product left the catalog", async () => {
    mocks.getProduct.mockResolvedValue(null);
    await expect(applySeoMeta(SHOP, move({}), null)).rejects.toMatchObject({ code: "product_missing", status: 409 });
    expect(mocks.upsertSeoOverride).not.toHaveBeenCalled();
  });
});

describe("revertSeoMeta", () => {
  function applied(prior: { metaTitle: string; metaDescription: string } | null): RadarMoveRow {
    const written = { metaTitle: "New title for trail boots", metaDescription: "New description." };
    return move({
      status: "applied",
      priorState: { kind: "seo_meta", entityId: "p1", prior },
      appliedStateHash: sha256(written),
    });
  }
  it("restores the prior override (or deletes when there was none) after a clean hash check", async () => {
    mocks.getSeoOverride.mockResolvedValue({ entityType: "product", entityId: "p1", metaTitle: "New title for trail boots", metaDescription: "New description." });
    await revertSeoMeta(SHOP, applied(null), { confirm: false }, "u1");
    expect(mocks.deleteSeoOverride).toHaveBeenCalledWith(SHOP, "product", "p1");
    await revertSeoMeta(SHOP, applied({ metaTitle: "Old", metaDescription: "Old desc" }), { confirm: false }, "u1");
    expect(mocks.upsertSeoOverride).toHaveBeenCalledWith(SHOP, expect.objectContaining({ metaTitle: "Old", metaDescription: "Old desc" }));
  });
  it("requires confirm when the live meta changed since apply", async () => {
    mocks.getSeoOverride.mockResolvedValue({ entityType: "product", entityId: "p1", metaTitle: "Merchant edited", metaDescription: "Since then." });
    await expect(revertSeoMeta(SHOP, applied(null), { confirm: false }, null))
      .rejects.toMatchObject({ code: "revert_conflict", status: 409 });
    await revertSeoMeta(SHOP, applied(null), { confirm: true }, null);
    expect(mocks.deleteSeoOverride).toHaveBeenCalled();
  });
});

describe("applyOrgRefresh", () => {
  it("fills the store description deterministically and keeps the prior for revert", async () => {
    const out = await applyOrgRefresh(SHOP, move({ kind: "aeo_refresh", payload: { applyMode: "refresh_org" } }));
    expect(mocks.upsertSeoSettings).toHaveBeenCalledWith(SHOP, { orgDescription: expect.stringContaining("Peak & Pine") });
    expect(out.priorState).toMatchObject({ kind: "org", prior: null });
  });
});

describe("RadarApplyError", () => {
  it("carries code and status", () => {
    const err = new RadarApplyError("x", "y", 409);
    expect(err).toMatchObject({ code: "x", status: 409, message: "y" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/apply-seo.server.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 4: Write the implementation**

```ts
// app/lib/radar/apply-seo.server.ts
// SEO/AEO move applies. Fully deterministic: the meta is composed from the
// product's own words + the focus query through the seo writer's building
// blocks and gated by the shared validator bounds - "through existing
// validated pipelines", zero Claude spend. prior_state + applied_state_hash
// give one-click revert with a staleness guard (a merchant edit after apply
// demands an explicit confirm instead of being silently clobbered).
import { createHash } from "node:crypto";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings, type StoreSettings } from "~/lib/storefront/settings.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import {
  deleteSeoOverride,
  getSeoOverride,
  getSeoSettings,
  upsertSeoOverride,
  upsertSeoSettings,
} from "~/lib/seo/seo-store.server";
import { buildStoreDescription } from "~/lib/seo/writer.server";
import { clampText, clampTitle, plainText } from "~/lib/seo/text";
import { validateMeta } from "~/lib/seo/validator.server";
import type { RadarMoveRow } from "./types";

export class RadarApplyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "RadarApplyError";
  }
}

export interface ApplyOutcome {
  priorState: Record<string, unknown> | null;
  appliedStateHash: string | null;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

const DESC_MAX = 155; // mirrors the writer's product-description clamp
const DESC_MIN_SAFE = 50; // validator floor

/** Deterministic query-focused meta from the product's own words. Guaranteed
 *  inside validator bounds: the title folds in the focus query (writer-style
 *  store-name suffix), the description pads with an honest availability line
 *  when the product copy is thin. */
export function deterministicMeta(
  product: StoreProduct,
  focusQuery: string,
  store: StoreSettings,
): { title: string; description: string } {
  const base = product.title.toLowerCase().includes(focusQuery.toLowerCase())
    ? product.title
    : `${product.title}: ${focusQuery}`;
  let title = clampTitle(base, store.storeName);
  if (title.trim().length < 10) title = clampText(`${base} | ${store.storeName}`, 60);
  const body = plainText(product.description);
  let description = clampText(
    body
      ? `${focusQuery[0].toUpperCase()}${focusQuery.slice(1)}: ${body}`
      : `${base} from ${store.storeName}.`,
    DESC_MAX,
  );
  if (description.trim().length < DESC_MIN_SAFE) {
    description = clampText(
      `${description} See details, prices and current availability, then order online from ${store.storeName}.`,
      DESC_MAX,
    );
  }
  return { title, description };
}

export async function applySeoMeta(
  shopId: string,
  move: RadarMoveRow,
  actorId: string | null,
): Promise<ApplyOutcome> {
  const handle = String(move.payload.handle ?? "");
  const focusQuery = String(move.payload.focusQuery ?? "");
  if (!handle || !focusQuery) {
    throw new RadarApplyError("bad_payload", "This move is missing its target page.", 422);
  }
  const [product, store] = await Promise.all([
    getCatalog().getProduct(shopId, handle),
    getStoreSettings(shopId),
  ]);
  if (!product) {
    throw new RadarApplyError("product_missing", "That product is no longer in your catalog.", 409);
  }
  const prior = await getSeoOverride(shopId, "product", product.id);
  const meta = deterministicMeta(product, focusQuery, store);
  const issues = validateMeta(meta.title, meta.description);
  if (issues.length > 0) {
    // Should be unreachable given deterministicMeta's guarantees; surfacing
    // beats publishing invalid meta (rule: invalid output never publishes).
    throw new RadarApplyError("meta_invalid", issues.map((i) => i.message).join("; "), 422);
  }
  await upsertSeoOverride(shopId, {
    entityType: "product",
    entityId: product.id,
    metaTitle: meta.title,
    metaDescription: meta.description,
    updatedBy: actorId,
  });
  return {
    priorState: {
      kind: "seo_meta",
      entityId: product.id,
      prior: prior ? { metaTitle: prior.metaTitle, metaDescription: prior.metaDescription } : null,
    },
    appliedStateHash: sha256({ metaTitle: meta.title, metaDescription: meta.description }),
  };
}

export async function revertSeoMeta(
  shopId: string,
  move: RadarMoveRow,
  opts: { confirm: boolean },
  actorId: string | null,
): Promise<void> {
  const ps = move.priorState as { entityId?: string; prior?: { metaTitle: string | null; metaDescription: string | null } | null } | null;
  const entityId = ps?.entityId;
  if (!entityId) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  const current = await getSeoOverride(shopId, "product", entityId);
  const currentHash = current
    ? sha256({ metaTitle: current.metaTitle, metaDescription: current.metaDescription })
    : sha256(null);
  if (currentHash !== move.appliedStateHash && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "This page's search text was edited after the move was applied. Reverting will overwrite that edit.",
      409,
    );
  }
  if (ps?.prior) {
    await upsertSeoOverride(shopId, {
      entityType: "product",
      entityId,
      metaTitle: ps.prior.metaTitle,
      metaDescription: ps.prior.metaDescription,
      updatedBy: actorId,
    });
  } else {
    await deleteSeoOverride(shopId, "product", entityId);
  }
}

/** AEO refresh: give AI assistants a store description to quote. Same
 *  deterministic composition Preferences suggests; the serve paths (llms.txt,
 *  org JSON-LD) pick it up on the next request because they render live. */
export async function applyOrgRefresh(shopId: string, _move: RadarMoveRow): Promise<ApplyOutcome> {
  const seo = await getSeoSettings(shopId);
  const [store, collections, products] = await Promise.all([
    getStoreSettings(shopId),
    getCatalog().listCollections(shopId),
    getCatalog().listProducts(shopId),
  ]);
  const subjects = collections.length
    ? collections.map((c) => c.title)
    : products.slice(0, 3).map((p) => p.title);
  const description = buildStoreDescription(store, subjects);
  await upsertSeoSettings(shopId, { orgDescription: description });
  return {
    priorState: { kind: "org", prior: seo.orgDescription ?? null },
    appliedStateHash: sha256(description),
  };
}

export async function revertOrgRefresh(
  shopId: string,
  move: RadarMoveRow,
  opts: { confirm: boolean },
): Promise<void> {
  const ps = move.priorState as { prior?: string | null } | null;
  const seo = await getSeoSettings(shopId);
  if (sha256(seo.orgDescription ?? null) !== move.appliedStateHash && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "Your store description was edited after this move was applied. Reverting will overwrite that edit.",
      409,
    );
  }
  await upsertSeoSettings(shopId, { orgDescription: ps?.prior ?? null });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/lib/radar/__tests__/apply-seo.server.test.ts app/lib/seo/__tests__/validator.server.test.ts`
Expected: PASS (both - the validator refactor stays green).

- [ ] **Step 6: Commit**

```bash
git add app/lib/radar/apply-seo.server.ts app/lib/seo/validator.server.ts app/lib/radar/__tests__/apply-seo.server.test.ts
git commit -m "radar/apply: deterministic validator-gated SEO meta + org-description applies with revert"
```

---

### Task 10: Section apply (both runtimes) + orchestrator (`apply-section.server.ts`, `apply.server.ts`)

**Files:**
- Create: `app/lib/radar/apply-section.server.ts`
- Create: `app/lib/radar/apply.server.ts`
- Test: `app/lib/radar/__tests__/apply-section.server.test.ts`
- Test: `app/lib/radar/__tests__/apply.server.test.ts`

**Interfaces:**
- Consumes: `readStorefrontReleaseState` (`~/lib/storefront-bundle/build.server`); `runStoreCommand`, `StoreCommandError` (`~/lib/storefront-command/command.server`); `rollbackStorefrontRelease` (`~/lib/storefront-bundle/release.server`); `loadPublishedDoc`/`loadDraftDoc`/`saveDraft`/`publishDoc` (`~/lib/storebuilder/page-document.server`); `validateDocument` (`~/lib/storebuilder/validate`); `getCatalog`; `checkAiQuota`, `getAnthropic`, `radarDraftModel`; Task 9's error/outcome/hash + apply/revert functions; store module (Task 6).
- Produces (used by Task 11):
  - `applySectionRefresh(shopId, move, actorId): Promise<ApplyOutcome>` / `revertSectionRefresh(shopId, move, opts, actorId): Promise<void>`
  - `applyMove({ shopId, moveId, actorId }): Promise<RadarMoveRow>`
  - `dismissMove({ shopId, moveId }): Promise<RadarMoveRow>`
  - `revertMove({ shopId, moveId, actorId, confirm }): Promise<RadarMoveRow>`
- **Apply-time generation** per the spec: the move stores only the brief; the real edit runs on Apply through the runtime's existing pipeline. Claude is used only on the legacy path (runtime 1's `runStoreCommand` does its own generation); it is quota-gated (`"radar"`) and a failure surfaces as an error - a deterministic template must never silently write copy into a live store.
- **Draft-collision guard** (both runtimes): if the merchant has unpublished changes, the apply fails with `draft_in_progress` instead of clobbering or publishing them.

- [ ] **Step 1: Write the failing section test**

```ts
// app/lib/radar/__tests__/apply-section.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseState: vi.fn(),
  runStoreCommand: vi.fn(),
  rollback: vi.fn(),
  loadPublishedDoc: vi.fn(),
  loadDraftDoc: vi.fn(),
  saveDraft: vi.fn(),
  publishDoc: vi.fn(),
  validateDocument: vi.fn(),
  listProducts: vi.fn(),
  listCollections: vi.fn(),
  checkAiQuota: vi.fn(),
  createMock: vi.fn(),
}));
vi.mock("~/lib/storefront-bundle/build.server", () => ({ readStorefrontReleaseState: mocks.releaseState }));
vi.mock("~/lib/storefront-command/command.server", () => ({
  runStoreCommand: mocks.runStoreCommand,
  StoreCommandError: class StoreCommandError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("~/lib/storefront-bundle/release.server", () => ({ rollbackStorefrontRelease: mocks.rollback }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({
  loadPublishedDoc: mocks.loadPublishedDoc,
  loadDraftDoc: mocks.loadDraftDoc,
  saveDraft: mocks.saveDraft,
  publishDoc: mocks.publishDoc,
}));
vi.mock("~/lib/storebuilder/validate", () => ({ validateDocument: mocks.validateDocument }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listProducts: mocks.listProducts, listCollections: mocks.listCollections }),
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.checkAiQuota }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: mocks.createMock } }),
  radarDraftModel: () => "test-model",
}));

import { applySectionRefresh, revertSectionRefresh } from "../apply-section.server";
import { sha256 } from "../apply-seo.server";
import type { RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const V_PUB = "aaaaaaaa-1111-2222-3333-444444444444";
const V_NEW = "bbbbbbbb-1111-2222-3333-444444444444";
const V_PUB2 = "cccccccc-1111-2222-3333-444444444444";

const HOME_DOC = {
  kind: "singleton", pageKey: "home",
  blocks: [{ id: "b1", type: "hero", props: { headline: "Old headline", subhead: "Old subhead" }, layout: { x: 0, y: 0, w: 12, h: 4 } }],
};

function move(payload: Record<string, unknown>, patch: Partial<RadarMoveRow> = {}): RadarMoveRow {
  return {
    id: "m1", shopId: SHOP, kind: "section_refresh", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: { applyMode: "refresh_section", target: "home", brief: "Refresh the hero.", ...payload },
    dedupKey: "stale:home", priorState: null, appliedStateHash: null,
    createdAt: "c", appliedAt: null, resolvedAt: null, expiresAt: "e", ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkAiQuota.mockResolvedValue({ allowed: true });
  mocks.createMock.mockResolvedValue({ content: [{ type: "text", text: '{"headline":"Fresh headline","subhead":"Fresh subhead"}' }] });
  mocks.listProducts.mockResolvedValue([]);
  mocks.listCollections.mockResolvedValue([]);
  mocks.validateDocument.mockImplementation((doc: unknown) => ({ doc, dropped: [], missingFunctional: [] }));
});

describe("runtime 1", () => {
  beforeEach(() => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_PUB, publishedVersionId: V_PUB,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    mocks.runStoreCommand
      .mockResolvedValueOnce({ status: "installed", versionId: V_NEW, undo: null })
      .mockResolvedValueOnce({ status: "published", versionId: V_NEW });
  });
  it("runs prompt then publish through runStoreCommand and records version pointers", async () => {
    const out = await applySectionRefresh(SHOP, move({}), "u1");
    expect(mocks.runStoreCommand).toHaveBeenNthCalledWith(1, {
      shopId: SHOP, actorId: "u1",
      command: { kind: "prompt", prompt: "Refresh the hero.", expectedDraftVersionId: V_PUB },
    });
    expect(mocks.runStoreCommand).toHaveBeenNthCalledWith(2, {
      shopId: SHOP, actorId: "u1",
      command: { kind: "publish", expectedDraftVersionId: V_NEW },
    });
    expect(out.priorState).toEqual({ kind: "section", runtime: 1, priorPublishedVersionId: V_PUB, appliedVersionId: V_NEW });
    expect(out.appliedStateHash).toBe(V_NEW);
    expect(mocks.createMock).not.toHaveBeenCalled(); // runtime 1 generates inside its own pipeline
  });
  it("refuses to touch an unpublished merchant draft", async () => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_NEW, publishedVersionId: V_PUB,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    mocks.runStoreCommand.mockReset();
    await expect(applySectionRefresh(SHOP, move({}), null))
      .rejects.toMatchObject({ code: "draft_in_progress", status: 409 });
    expect(mocks.runStoreCommand).not.toHaveBeenCalled();
  });
  it("reverts via rollbackStorefrontRelease with the current published pointer", async () => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_NEW, publishedVersionId: V_NEW,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 1, priorPublishedVersionId: V_PUB, appliedVersionId: V_NEW },
      appliedStateHash: V_NEW,
    });
    await revertSectionRefresh(SHOP, applied, { confirm: false }, "u1");
    expect(mocks.rollback).toHaveBeenCalledWith({
      shopId: SHOP, targetVersionId: V_PUB, expectedPublishedVersionId: V_NEW, actorId: "u1",
    });
  });
  it("requires confirm when the store was published again since apply", async () => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_PUB2, publishedVersionId: V_PUB2,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 1, priorPublishedVersionId: V_PUB, appliedVersionId: V_NEW },
      appliedStateHash: V_NEW,
    });
    await expect(revertSectionRefresh(SHOP, applied, { confirm: false }, null))
      .rejects.toMatchObject({ code: "revert_conflict", status: 409 });
    await revertSectionRefresh(SHOP, applied, { confirm: true }, null);
    expect(mocks.rollback).toHaveBeenCalledWith(expect.objectContaining({ expectedPublishedVersionId: V_PUB2 }));
  });
});

describe("legacy runtime", () => {
  beforeEach(() => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: null, publishedVersionId: null,
      draftRuntimeVersion: null, publishedRuntimeVersion: null,
    });
    mocks.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    mocks.loadDraftDoc.mockResolvedValue(null);
    mocks.saveDraft.mockResolvedValue(undefined);
    mocks.publishDoc.mockResolvedValue(undefined);
  });
  it("rewrites the hero copy via quota-gated Claude, validates, publishes and hashes", async () => {
    const out = await applySectionRefresh(SHOP, move({}), "u1");
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar", trusted: true });
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", expect.objectContaining({
      blocks: [expect.objectContaining({ props: { headline: "Fresh headline", subhead: "Fresh subhead" } })],
    }));
    expect(mocks.publishDoc).toHaveBeenCalledWith(SHOP, "home");
    expect(out.priorState).toMatchObject({ kind: "section", runtime: 0, pageKey: "home", doc: HOME_DOC });
    expect(out.appliedStateHash).toHaveLength(64);
  });
  it("refuses when a legacy draft diverges from published, and when Claude fails", async () => {
    mocks.loadDraftDoc.mockResolvedValue({ ...HOME_DOC, blocks: [] });
    await expect(applySectionRefresh(SHOP, move({}), null))
      .rejects.toMatchObject({ code: "draft_in_progress", status: 409 });
    mocks.loadDraftDoc.mockResolvedValue(null);
    mocks.createMock.mockRejectedValue(new Error("api down"));
    await expect(applySectionRefresh(SHOP, move({}), null))
      .rejects.toMatchObject({ code: "section_copy_failed" });
    expect(mocks.publishDoc).not.toHaveBeenCalled();
  });
  it("reverts by republishing the stored doc after a clean hash check", async () => {
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 0, pageKey: "home", doc: HOME_DOC },
      appliedStateHash: sha256(HOME_DOC),
    });
    mocks.loadPublishedDoc.mockResolvedValue(HOME_DOC); // unchanged since apply
    await revertSectionRefresh(SHOP, applied, { confirm: false }, null);
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", HOME_DOC);
    expect(mocks.publishDoc).toHaveBeenCalledWith(SHOP, "home");
    // Edited since apply -> confirm required.
    mocks.loadPublishedDoc.mockResolvedValue({ ...HOME_DOC, blocks: [] });
    await expect(revertSectionRefresh(SHOP, applied, { confirm: false }, null))
      .rejects.toMatchObject({ code: "revert_conflict", status: 409 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/apply-section.server.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write `apply-section.server.ts`**

```ts
// app/lib/radar/apply-section.server.ts
// Section-refresh applies: APPLY-TIME generation through the shop's real
// storefront pipeline. Runtime 1 = runStoreCommand prompt -> publish (its own
// intent/validate/prove chain, version-checked). Legacy = targeted hero/heading
// copy rewrite -> validateDocument -> saveDraft -> publishDoc. Both refuse to
// clobber an unpublished merchant draft, and both record enough prior state
// for a guarded one-click revert.
import { checkAiQuota } from "~/lib/ai-quota.server";
import { getAnthropic, radarDraftModel } from "~/lib/assistant/anthropic.server";
import { readStorefrontReleaseState } from "~/lib/storefront-bundle/build.server";
import { rollbackStorefrontRelease } from "~/lib/storefront-bundle/release.server";
import { runStoreCommand, StoreCommandError } from "~/lib/storefront-command/command.server";
import { loadDraftDoc, loadPublishedDoc, publishDoc, saveDraft } from "~/lib/storebuilder/page-document.server";
import { validateDocument } from "~/lib/storebuilder/validate";
import type { BlockDocument, PageKey } from "~/lib/storebuilder/types";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { ApplyOutcome, RadarApplyError, sha256 } from "./apply-seo.server";
import type { RadarMoveRow } from "./types";

const SECTION_SYSTEM =
  "You rewrite one storefront section's copy for an online store. Given a brief and the current headline " +
  "and subhead, produce a fresh, concrete, persuasive replacement in the same voice. No emoji, no " +
  'exclamation marks, no invented claims (prices, awards, guarantees). Respond with JSON only: ' +
  '{"headline":"...","subhead":"..."}';

const HEADLINE_MIN = 4;
const HEADLINE_MAX = 80;
const SUBHEAD_MAX = 160;

async function generateSectionCopy(
  shopId: string,
  brief: string,
  current: { headline: string; subhead: string },
): Promise<{ headline: string; subhead: string }> {
  const verdict = await checkAiQuota({ shopId, feature: "radar", trusted: true });
  if (!verdict.allowed) throw new RadarApplyError(verdict.code, verdict.message, 429);
  let text = "";
  try {
    const res = await getAnthropic().messages.create({
      model: radarDraftModel(),
      max_tokens: 300,
      system: SECTION_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ brief, current }) }],
    });
    text = res.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")?.text ?? "";
  } catch (err) {
    // No silent template into a live store: surface, keep the move draft.
    console.error(`[radar] section copy generation failed for shop ${shopId}`, err);
    throw new RadarApplyError(
      "section_copy_failed",
      "The new section text could not be generated. Your store was not changed - try again in a moment.",
      502,
    );
  }
  try {
    const start = text.indexOf("{");
    const parsed = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as { headline?: unknown; subhead?: unknown };
    const headline = typeof parsed.headline === "string" ? parsed.headline.trim() : "";
    const subhead = typeof parsed.subhead === "string" ? parsed.subhead.trim() : "";
    if (headline.length < HEADLINE_MIN || headline.length > HEADLINE_MAX || subhead.length > SUBHEAD_MAX
      || /ploy/i.test(`${headline} ${subhead}`)) {
      throw new Error("out-of-bounds section copy");
    }
    return { headline, subhead };
  } catch {
    throw new RadarApplyError(
      "section_copy_failed",
      "The new section text came back malformed. Your store was not changed - try again in a moment.",
      502,
    );
  }
}

// ── Runtime 1 ────────────────────────────────────────────────────────────────

interface Runtime1Release {
  draftVersionId: string | null;
  publishedVersionId: string | null;
}

async function applyRuntime1(
  shopId: string,
  move: RadarMoveRow,
  actorId: string | null,
  release: Runtime1Release,
): Promise<ApplyOutcome> {
  if (release.draftVersionId && release.draftVersionId !== release.publishedVersionId) {
    throw new RadarApplyError(
      "draft_in_progress",
      "You have unpublished store changes. Publish or undo them first, then apply this move.",
      409,
    );
  }
  const brief = String(move.payload.brief ?? "");
  if (!brief) throw new RadarApplyError("bad_payload", "This move is missing its refresh brief.", 422);
  try {
    const edit = await runStoreCommand({
      shopId,
      actorId,
      command: { kind: "prompt", prompt: brief, expectedDraftVersionId: release.draftVersionId ?? null },
    });
    if (edit.status !== "installed") {
      throw new RadarApplyError("section_apply_failed", "The store change did not produce a draft.", 500);
    }
    const published = await runStoreCommand({
      shopId,
      actorId,
      command: { kind: "publish", expectedDraftVersionId: edit.versionId },
    });
    return {
      priorState: {
        kind: "section",
        runtime: 1,
        priorPublishedVersionId: release.publishedVersionId,
        appliedVersionId: published.versionId,
      },
      // For runtime 1 the published version id IS the state fingerprint.
      appliedStateHash: published.versionId,
    };
  } catch (err) {
    if (err instanceof StoreCommandError) {
      throw new RadarApplyError(err.code, err.message, err.status);
    }
    throw err;
  }
}

// ── Legacy (block documents) ────────────────────────────────────────────────

/** The block whose copy a refresh may touch: the hero, else the first rawHtml
 *  section with a heading. Anything else is not a refreshable section. */
function pickSectionBlock(doc: BlockDocument): { index: number; type: "hero" | "rawHtml" } | null {
  const hero = doc.blocks.findIndex((b) => b.type === "hero");
  if (hero >= 0) return { index: hero, type: "hero" };
  const raw = doc.blocks.findIndex(
    (b) => b.type === "rawHtml" && typeof b.props.html === "string" && /<h[1-4][^>]*>/i.test(b.props.html),
  );
  if (raw >= 0) return { index: raw, type: "rawHtml" };
  return null;
}

async function applyLegacy(shopId: string, move: RadarMoveRow, actorId: string | null): Promise<ApplyOutcome> {
  const target = String(move.payload.target ?? "home");
  const pageKey: PageKey = target === "pdp" ? "pdp" : "home";
  const published = await loadPublishedDoc(shopId, pageKey);
  if (!published) {
    throw new RadarApplyError(
      "page_not_published",
      target === "pdp"
        ? "This store's product pages use the standard layout, which Radar can't refresh yet. Open the store editor to change them."
        : "This page isn't published yet, so there's nothing to refresh.",
      409,
    );
  }
  const draft = await loadDraftDoc(shopId, pageKey);
  if (draft && sha256(draft) !== sha256(published)) {
    throw new RadarApplyError(
      "draft_in_progress",
      "You have unpublished store changes. Publish or undo them first, then apply this move.",
      409,
    );
  }
  const picked = pickSectionBlock(published);
  if (!picked) {
    throw new RadarApplyError("no_refreshable_section", "This page has no section Radar can refresh.", 422);
  }
  const block = published.blocks[picked.index];
  const current = picked.type === "hero"
    ? {
        headline: typeof block.props.headline === "string" ? block.props.headline : "",
        subhead: typeof block.props.subhead === "string" ? block.props.subhead : "",
      }
    : { headline: "", subhead: "" };
  const copy = await generateSectionCopy(shopId, String(move.payload.brief ?? ""), current);

  const next: BlockDocument = JSON.parse(JSON.stringify(published)) as BlockDocument;
  const nextBlock = next.blocks[picked.index];
  if (picked.type === "hero") {
    nextBlock.props = { ...nextBlock.props, headline: copy.headline, subhead: copy.subhead };
  } else {
    const html = String(nextBlock.props.html);
    nextBlock.props = {
      ...nextBlock.props,
      // Replace only the first heading's inner text; saveDraft re-sanitizes.
      html: html.replace(/(<h[1-4][^>]*>)[\s\S]*?(<\/h[1-4]>)/i, `$1${copy.headline}$2`),
    };
  }

  const [products, collections] = await Promise.all([
    getCatalog().listProducts(shopId),
    getCatalog().listCollections(shopId),
  ]);
  const result = validateDocument(next, {
    productIds: new Set(products.map((p) => p.id)),
    collectionHandles: new Set(collections.map((c) => c.handle)),
  });
  if (result.missingFunctional.length > 0) {
    throw new RadarApplyError("section_apply_failed", "The refreshed page failed validation. Your store was not changed.", 422);
  }
  await saveDraft(shopId, pageKey, result.doc);
  await publishDoc(shopId, pageKey);
  return {
    priorState: { kind: "section", runtime: 0, pageKey, doc: published, actorId },
    appliedStateHash: sha256(result.doc),
  };
}

// ── Entry points ────────────────────────────────────────────────────────────

export async function applySectionRefresh(
  shopId: string,
  move: RadarMoveRow,
  actorId: string | null,
): Promise<ApplyOutcome> {
  const release = await readStorefrontReleaseState(shopId);
  if (release.publishedRuntimeVersion === 1) {
    return applyRuntime1(shopId, move, actorId, release);
  }
  return applyLegacy(shopId, move, actorId);
}

export async function revertSectionRefresh(
  shopId: string,
  move: RadarMoveRow,
  opts: { confirm: boolean },
  actorId: string | null,
): Promise<void> {
  const ps = move.priorState as {
    runtime?: number;
    priorPublishedVersionId?: string | null;
    appliedVersionId?: string;
    pageKey?: PageKey;
    doc?: BlockDocument;
  } | null;
  if (!ps) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);

  if (ps.runtime === 1) {
    if (!ps.priorPublishedVersionId) {
      throw new RadarApplyError("no_prior_version", "There was no earlier published store to go back to.", 422);
    }
    const release = await readStorefrontReleaseState(shopId);
    if (release.publishedVersionId !== ps.appliedVersionId && !opts.confirm) {
      throw new RadarApplyError(
        "revert_conflict",
        "Your store was published again after this move was applied. Reverting will replace the newer version.",
        409,
      );
    }
    await rollbackStorefrontRelease({
      shopId,
      targetVersionId: ps.priorPublishedVersionId,
      expectedPublishedVersionId: release.publishedVersionId,
      actorId,
    });
    return;
  }

  const pageKey = ps.pageKey ?? "home";
  const doc = ps.doc;
  if (!doc) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  const current = await loadPublishedDoc(shopId, pageKey);
  // Staleness guard: hash the live doc against what the apply published; a
  // mismatch means the merchant edited since - require an explicit confirm.
  if (sha256(current) !== move.appliedStateHash && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "This page was edited after the move was applied. Reverting will overwrite those edits.",
      409,
    );
  }
  await saveDraft(shopId, pageKey, doc);
  await publishDoc(shopId, pageKey);
}
```

Note: `ApplyOutcome` is imported as a type from `./apply-seo.server` - use `import { RadarApplyError, sha256, type ApplyOutcome } from "./apply-seo.server";` if the verbatim-module-syntax lint asks for it.

- [ ] **Step 4: Write the orchestrator test**

```ts
// app/lib/radar/__tests__/apply.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMove: vi.fn(),
  updateMove: vi.fn(),
  applySeoMeta: vi.fn(),
  revertSeoMeta: vi.fn(),
  applyOrgRefresh: vi.fn(),
  revertOrgRefresh: vi.fn(),
  applySectionRefresh: vi.fn(),
  revertSectionRefresh: vi.fn(),
}));
vi.mock("../store.server", () => ({ getMove: mocks.getMove, updateMove: mocks.updateMove }));
vi.mock("../apply-seo.server", async (importActual) => ({
  ...(await importActual() as Record<string, unknown>),
  applySeoMeta: mocks.applySeoMeta,
  revertSeoMeta: mocks.revertSeoMeta,
  applyOrgRefresh: mocks.applyOrgRefresh,
  revertOrgRefresh: mocks.revertOrgRefresh,
}));
vi.mock("../apply-section.server", () => ({
  applySectionRefresh: mocks.applySectionRefresh,
  revertSectionRefresh: mocks.revertSectionRefresh,
}));

import { applyMove, dismissMove, revertMove } from "../apply.server";
import type { RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const MOVE_ID = "99999999-1111-2222-3333-444444444444";

function row(patch: Partial<RadarMoveRow>): RadarMoveRow {
  return {
    id: MOVE_ID, shopId: SHOP, kind: "seo_meta_rewrite", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: { applyMode: "publish_meta" }, dedupKey: "d",
    priorState: null, appliedStateHash: null,
    createdAt: "c", appliedAt: null, resolvedAt: null, expiresAt: "e", ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMove.mockResolvedValue(undefined);
  mocks.applySeoMeta.mockResolvedValue({ priorState: { kind: "seo_meta" }, appliedStateHash: "hash" });
});

describe("applyMove", () => {
  it("dispatches publish_meta, persists the outcome and returns the applied row", async () => {
    mocks.getMove.mockResolvedValue(row({}));
    const out = await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1" });
    expect(mocks.applySeoMeta).toHaveBeenCalledWith(SHOP, expect.objectContaining({ id: MOVE_ID }), "u1");
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, expect.objectContaining({
      status: "applied", appliedAt: expect.any(String),
      priorState: { kind: "seo_meta" }, appliedStateHash: "hash",
    }));
    expect(out.status).toBe("applied");
  });
  it("review moves apply without touching the store", async () => {
    mocks.getMove.mockResolvedValue(row({ payload: { applyMode: "review", deepLink: "/dashboard/store/preferences" } }));
    await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null });
    expect(mocks.applySeoMeta).not.toHaveBeenCalled();
    expect(mocks.applySectionRefresh).not.toHaveBeenCalled();
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, expect.objectContaining({ status: "applied", priorState: null }));
  });
  it("dispatches refresh_section and refresh_org", async () => {
    mocks.applySectionRefresh.mockResolvedValue({ priorState: { kind: "section" }, appliedStateHash: "v" });
    mocks.getMove.mockResolvedValue(row({ kind: "section_refresh", payload: { applyMode: "refresh_section", brief: "b" } }));
    await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null });
    expect(mocks.applySectionRefresh).toHaveBeenCalled();
    mocks.applyOrgRefresh.mockResolvedValue({ priorState: { kind: "org" }, appliedStateHash: "o" });
    mocks.getMove.mockResolvedValue(row({ kind: "aeo_refresh", payload: { applyMode: "refresh_org" } }));
    await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null });
    expect(mocks.applyOrgRefresh).toHaveBeenCalled();
  });
  it("404s an unknown move and 409s a non-draft move", async () => {
    mocks.getMove.mockResolvedValue(null);
    await expect(applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null }))
      .rejects.toMatchObject({ code: "move_not_found", status: 404 });
    mocks.getMove.mockResolvedValue(row({ status: "applied" }));
    await expect(applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null }))
      .rejects.toMatchObject({ code: "move_not_open", status: 409 });
  });
  it("leaves the move draft when the executor fails", async () => {
    mocks.getMove.mockResolvedValue(row({}));
    mocks.applySeoMeta.mockRejectedValue(new Error("upstream down"));
    await expect(applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null })).rejects.toThrow(/upstream down/);
    expect(mocks.updateMove).not.toHaveBeenCalled();
  });
});

describe("dismissMove", () => {
  it("marks a draft dismissed with a resolution time", async () => {
    mocks.getMove.mockResolvedValue(row({}));
    const out = await dismissMove({ shopId: SHOP, moveId: MOVE_ID });
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, {
      status: "dismissed", resolvedAt: expect.any(String),
    });
    expect(out.status).toBe("dismissed");
  });
});

describe("revertMove", () => {
  it("dispatches by prior-state kind and marks the move reverted", async () => {
    mocks.getMove.mockResolvedValue(row({
      status: "applied",
      priorState: { kind: "section", runtime: 1, priorPublishedVersionId: "v0", appliedVersionId: "v1" },
      appliedStateHash: "v1",
    }));
    await revertMove({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1", confirm: false });
    expect(mocks.revertSectionRefresh).toHaveBeenCalledWith(
      SHOP, expect.anything(), { confirm: false }, "u1",
    );
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, expect.objectContaining({
      status: "dismissed", resolvedAt: expect.any(String),
      payload: expect.objectContaining({ reverted: true }),
    }));
  });
  it("refuses to revert a review move or a non-applied move", async () => {
    mocks.getMove.mockResolvedValue(row({ status: "applied", priorState: null }));
    await expect(revertMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null, confirm: false }))
      .rejects.toMatchObject({ code: "nothing_to_revert" });
    mocks.getMove.mockResolvedValue(row({ status: "draft" }));
    await expect(revertMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null, confirm: false }))
      .rejects.toMatchObject({ code: "move_not_applied", status: 409 });
  });
});
```

- [ ] **Step 5: Write `apply.server.ts`**

```ts
// app/lib/radar/apply.server.ts
// Orchestrator behind the dashboard.api.radar actions: load + guard the move,
// dispatch to the kind-specific executor, persist the outcome. Executor
// failures propagate untouched - the move stays draft and the route surfaces
// the real error on the card (spec: no partial publishes, no swallowing).
import {
  applyOrgRefresh,
  applySeoMeta,
  RadarApplyError,
  revertOrgRefresh,
  revertSeoMeta,
  type ApplyOutcome,
} from "./apply-seo.server";
import { applySectionRefresh, revertSectionRefresh } from "./apply-section.server";
import { getMove, updateMove } from "./store.server";
import type { RadarMoveRow } from "./types";

async function loadOpenMove(shopId: string, moveId: string, wantStatus: "draft" | "applied"): Promise<RadarMoveRow> {
  const move = await getMove(shopId, moveId);
  if (!move) throw new RadarApplyError("move_not_found", "That move no longer exists.", 404);
  if (wantStatus === "draft" && move.status !== "draft") {
    throw new RadarApplyError("move_not_open", "This move was already handled.", 409);
  }
  if (wantStatus === "applied" && move.status !== "applied") {
    throw new RadarApplyError("move_not_applied", "Only an applied move can be reverted.", 409);
  }
  return move;
}

export async function applyMove(input: {
  shopId: string;
  moveId: string;
  actorId: string | null;
}): Promise<RadarMoveRow> {
  const move = await loadOpenMove(input.shopId, input.moveId, "draft");
  const mode = String(move.payload.applyMode ?? "review");
  let outcome: ApplyOutcome;
  if (mode === "publish_meta") outcome = await applySeoMeta(input.shopId, move, input.actorId);
  else if (mode === "refresh_org") outcome = await applyOrgRefresh(input.shopId, move);
  else if (mode === "refresh_section") outcome = await applySectionRefresh(input.shopId, move, input.actorId);
  else outcome = { priorState: null, appliedStateHash: null }; // review: applying = reviewed
  const appliedAt = new Date().toISOString();
  await updateMove(input.shopId, move.id, {
    status: "applied",
    appliedAt,
    priorState: outcome.priorState,
    appliedStateHash: outcome.appliedStateHash,
  });
  return { ...move, status: "applied", appliedAt, priorState: outcome.priorState, appliedStateHash: outcome.appliedStateHash };
}

export async function dismissMove(input: { shopId: string; moveId: string }): Promise<RadarMoveRow> {
  const move = await loadOpenMove(input.shopId, input.moveId, "draft");
  const resolvedAt = new Date().toISOString();
  await updateMove(input.shopId, move.id, { status: "dismissed", resolvedAt });
  return { ...move, status: "dismissed", resolvedAt };
}

export async function revertMove(input: {
  shopId: string;
  moveId: string;
  actorId: string | null;
  confirm: boolean;
}): Promise<RadarMoveRow> {
  const move = await loadOpenMove(input.shopId, input.moveId, "applied");
  const kind = String((move.priorState as { kind?: unknown } | null)?.kind ?? "");
  if (!kind) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  if (kind === "seo_meta") await revertSeoMeta(input.shopId, move, { confirm: input.confirm }, input.actorId);
  else if (kind === "org") await revertOrgRefresh(input.shopId, move, { confirm: input.confirm });
  else if (kind === "section") await revertSectionRefresh(input.shopId, move, { confirm: input.confirm }, input.actorId);
  else throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  const resolvedAt = new Date().toISOString();
  const payload = { ...move.payload, reverted: true };
  await updateMove(input.shopId, move.id, { status: "dismissed", resolvedAt, payload });
  return { ...move, status: "dismissed", resolvedAt, payload };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run app/lib/radar/__tests__/apply-section.server.test.ts app/lib/radar/__tests__/apply.server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/lib/radar/apply-section.server.ts app/lib/radar/apply.server.ts app/lib/radar/__tests__/apply-section.server.test.ts app/lib/radar/__tests__/apply.server.test.ts
git commit -m "radar/apply: section refresh on both storefront runtimes + guarded revert orchestrator"
```

---

### Task 11: Dashboard API (`dashboard.api.radar`) + browser client

**Files:**
- Create: `app/routes/dashboard.api.radar.tsx`
- Create: `app/lib/dashboard/radar-client.ts`
- Test: `app/routes/__tests__/dashboard.api.radar.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession`; `dashboardJson`/`jsonError`/`requireSameOrigin` (`~/lib/dashboard/http.server`); `listMoves`, `readRadarState` (Task 6); `applyMove`/`dismissMove`/`revertMove` + `RadarApplyError` (Task 10); `getSupabase`, `isUuid`.
- Produces:
  - `GET /dashboard/api/radar` -> `RadarOverviewVM` (below). Demo (non-uuid) shops get an empty VM without touching the DB.
  - `POST /dashboard/api/radar` with `{ action: "apply" | "dismiss" | "revert", moveId, confirm? }` -> `{ move: RadarMoveVM }`; `RadarApplyError` maps to `jsonError(err.status, err.code, err.message)`.
  - Client VM mirror in `radar-client.ts` (a `.server` module cannot be imported into the client bundle - same convention as `search-client.ts`):

```ts
// Shapes (client mirror - keep in sync with the route by hand):
export interface RadarMoveVM {
  id: string;
  kind: string; // one of the RadarMoveKind strings; label mapping is client-side
  status: "draft" | "applied" | "dismissed" | "expired";
  headline: string;
  rationale: string;
  chips: string[];
  reviewOnly: boolean;      // applying just marks it done
  deepLink: string | null;  // where "Review" goes for review moves
  canRevert: boolean;
  reverted: boolean;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
}
export interface RadarSignalsVM {
  traffic: { yesterdayViews: number; weeklyAverage: number; lastCheckedAt: string | null };
  google: { connected: boolean; lastCapturedDate: string | null; slippingCount: number };
  aiAssistants: { hitsLast7: number; hitsPrior7: number };
  competitors: { comingSoon: true };
}
export interface RadarOverviewVM {
  moves: RadarMoveVM[];
  history: RadarMoveVM[];
  signals: RadarSignalsVM;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/dashboard.api.radar.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const SHOP = "11111111-2222-3333-4444-555555555555";
const MOVE_ID = "99999999-1111-2222-3333-444444444444";

const mocks = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  listMoves: vi.fn(),
  readRadarState: vi.fn(),
  applyMove: vi.fn(),
  dismissMove: vi.fn(),
  revertMove: vi.fn(),
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: mocks.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: mocks.requireSameOrigin,
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string, m?: string) => new Response(JSON.stringify({ error: e, message: m }), { status: s }),
}));
vi.mock("~/lib/radar/store.server", () => ({ listMoves: mocks.listMoves, readRadarState: mocks.readRadarState }));
vi.mock("~/lib/radar/apply.server", async () => {
  const { RadarApplyError } = await import("../../lib/radar/apply-seo.server");
  return {
    applyMove: mocks.applyMove,
    dismissMove: mocks.dismissMove,
    revertMove: mocks.revertMove,
    RadarApplyError,
  };
});
vi.mock("~/lib/radar/apply-seo.server", async (importActual) => (await importActual()) as Record<string, unknown>);
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
}));

import { loader, action } from "../dashboard.api.radar";
import { RadarApplyError } from "../../lib/radar/apply-seo.server";

function moveRow(patch: Record<string, unknown> = {}) {
  return {
    id: MOVE_ID, shopId: SHOP, kind: "seo_meta_rewrite", status: "draft",
    headline: "Make it worth the click", rationale: "Plain words.",
    evidence: { chips: ["spot #5"], facts: {} },
    payload: { applyMode: "publish_meta", handle: "mug", focusQuery: "mug" },
    dedupKey: "d", priorState: null, appliedStateHash: null,
    createdAt: "2026-07-20T00:00:00Z", appliedAt: null, resolvedAt: null, expiresAt: "e",
    ...patch,
  };
}

function get() {
  return { request: new Request("https://app.x/dashboard/api/radar"), params: {}, context: {} } as never;
}
function post(body: unknown) {
  return {
    request: new Request("https://app.x/dashboard/api/radar", {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    params: {}, context: {},
  } as never;
}

// Chainable stub for the signals reads.
function tableStub(result: { data: unknown; error: null }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order", "limit"]) q[m] = vi.fn().mockReturnValue(q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardSession.mockResolvedValue({ shopId: SHOP, userId: "u1" });
  mocks.listMoves.mockResolvedValue([]);
  mocks.readRadarState.mockResolvedValue({ lastCollectedAt: "2026-07-20T10:00:00Z", lastDraftedAt: null, homeCardDismissedAt: null });
  mocks.fromMock.mockImplementation((table: string) => {
    if (table === "radar_traffic_daily") {
      return tableStub({ data: [{ day: "2026-07-19", views: 40 }, { day: "2026-07-18", views: 60 }], error: null });
    }
    if (table === "seo_settings") return tableStub({ data: { gsc_connected: true }, error: null });
    if (table === "seo_ai_crawl_daily") {
      return tableStub({ data: [{ day: "2026-07-19", hits: 2 }, { day: "2026-07-05", hits: 7 }], error: null });
    }
    throw new Error(`unexpected table ${table}`);
  });
  mocks.rpcMock.mockResolvedValue({ data: { slipping: [{}], lastCapturedDate: "2026-07-18" }, error: null });
});

describe("loader", () => {
  it("shapes the VM field-by-field and never leaks the internal noun", async () => {
    mocks.listMoves
      .mockResolvedValueOnce([moveRow()])
      .mockResolvedValueOnce([moveRow({ status: "dismissed", payload: { applyMode: "publish_meta", reverted: true }, priorState: { kind: "seo_meta" } })]);
    const res = (await loader(get())) as Response;
    const text = await res.text();
    expect(text).not.toMatch(/ploy/i);
    const body = JSON.parse(text);
    expect(body.moves[0]).toMatchObject({
      id: MOVE_ID, kind: "seo_meta_rewrite", headline: "Make it worth the click",
      chips: ["spot #5"], reviewOnly: false, canRevert: false, reverted: false,
    });
    expect(body.moves[0].payload).toBeUndefined();
    expect(body.moves[0].dedupKey).toBeUndefined();
    expect(body.history[0]).toMatchObject({ status: "dismissed", reverted: true });
    expect(body.signals.traffic).toEqual({ yesterdayViews: 40, weeklyAverage: expect.any(Number), lastCheckedAt: "2026-07-20T10:00:00Z" });
    expect(body.signals.google).toEqual({ connected: true, lastCapturedDate: "2026-07-18", slippingCount: 1 });
    expect(body.signals.aiAssistants).toEqual({ hitsLast7: expect.any(Number), hitsPrior7: expect.any(Number) });
    expect(body.signals.competitors).toEqual({ comingSoon: true });
  });
  it("marks review moves and surfaces their deep link", async () => {
    mocks.listMoves
      .mockResolvedValueOnce([moveRow({ payload: { applyMode: "review", deepLink: "/dashboard/products/p1" } })])
      .mockResolvedValueOnce([]);
    const body = await ((await loader(get())) as Response).json();
    expect(body.moves[0]).toMatchObject({ reviewOnly: true, deepLink: "/dashboard/products/p1" });
  });
  it("returns an empty VM for demo shops without touching the DB", async () => {
    mocks.requireDashboardSession.mockResolvedValue({ shopId: "demo-shop", userId: "u1" });
    const body = await ((await loader(get())) as Response).json();
    expect(body.moves).toEqual([]);
    expect(mocks.listMoves).not.toHaveBeenCalled();
    expect(mocks.fromMock).not.toHaveBeenCalled();
  });
  it("keeps the screen alive when a signals read fails", async () => {
    mocks.rpcMock.mockRejectedValue(new Error("summary down"));
    const res = (await loader(get())) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals.google).toEqual({ connected: true, lastCapturedDate: null, slippingCount: 0 });
  });
});

describe("action", () => {
  it("applies after the same-origin gate and returns the move VM", async () => {
    mocks.applyMove.mockResolvedValue(moveRow({ status: "applied", priorState: { kind: "seo_meta" }, appliedAt: "t" }));
    const res = (await action(post({ action: "apply", moveId: MOVE_ID }))) as Response;
    expect(mocks.requireSameOrigin).toHaveBeenCalled();
    expect(mocks.applyMove).toHaveBeenCalledWith({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1" });
    const body = await res.json();
    expect(body.move).toMatchObject({ status: "applied", canRevert: true });
    expect(JSON.stringify(body)).not.toMatch(/ploy/i);
  });
  it("dismisses and reverts (forwarding confirm)", async () => {
    mocks.dismissMove.mockResolvedValue(moveRow({ status: "dismissed" }));
    await action(post({ action: "dismiss", moveId: MOVE_ID }));
    expect(mocks.dismissMove).toHaveBeenCalledWith({ shopId: SHOP, moveId: MOVE_ID });
    mocks.revertMove.mockResolvedValue(moveRow({ status: "dismissed", payload: { applyMode: "publish_meta", reverted: true } }));
    await action(post({ action: "revert", moveId: MOVE_ID, confirm: true }));
    expect(mocks.revertMove).toHaveBeenCalledWith({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1", confirm: true });
  });
  it("maps RadarApplyError onto its status/code and 422s bad input", async () => {
    mocks.applyMove.mockRejectedValue(new RadarApplyError("revert_conflict", "Edited since.", 409));
    const res = (await action(post({ action: "apply", moveId: MOVE_ID }))) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "revert_conflict" });
    const bad = (await action(post({ action: "nope", moveId: MOVE_ID }))) as Response;
    expect(bad.status).toBe(422);
    const noId = (await action(post({ action: "apply" }))) as Response;
    expect(noId.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.radar.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the route**

```tsx
// app/routes/dashboard.api.radar.tsx
// Radar screen data + move actions. Loader shapes RadarOverviewVM field-by-
// field (raw rows never reach the client - and the internal table noun never
// appears in any VM field or string). Browser-safe mirror:
// app/lib/dashboard/radar-client.ts - keep in sync by hand (search-client
// convention).
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listMoves, readRadarState } from "~/lib/radar/store.server";
import { applyMove, dismissMove, revertMove, RadarApplyError } from "~/lib/radar/apply.server";
import type { RadarMoveRow } from "~/lib/radar/types";
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";

interface RadarMoveVM {
  id: string;
  kind: string;
  status: string;
  headline: string;
  rationale: string;
  chips: string[];
  reviewOnly: boolean;
  deepLink: string | null;
  canRevert: boolean;
  reverted: boolean;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
}

function toMoveVM(m: RadarMoveRow): RadarMoveVM {
  const applyMode = String(m.payload.applyMode ?? "review");
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    headline: m.headline,
    rationale: m.rationale,
    chips: Array.isArray(m.evidence?.chips) ? m.evidence.chips.map(String) : [],
    reviewOnly: applyMode === "review",
    deepLink: typeof m.payload.deepLink === "string" ? m.payload.deepLink : null,
    canRevert: m.status === "applied" && m.priorState != null,
    reverted: m.payload.reverted === true,
    createdAt: m.createdAt,
    appliedAt: m.appliedAt,
    resolvedAt: m.resolvedAt,
  };
}

interface RadarSignalsVM {
  traffic: { yesterdayViews: number; weeklyAverage: number; lastCheckedAt: string | null };
  google: { connected: boolean; lastCapturedDate: string | null; slippingCount: number };
  aiAssistants: { hitsLast7: number; hitsPrior7: number };
  competitors: { comingSoon: true };
}

const EMPTY_SIGNALS: RadarSignalsVM = {
  traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
  google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
  aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
  competitors: { comingSoon: true },
};

const DAY_MS = 86_400_000;

// Each tile is best-effort: a failed read logs and zeroes that tile; the
// screen itself never breaks (same posture as the Search screen's Google card).
async function buildSignals(shopId: string): Promise<RadarSignalsVM> {
  const sb = getSupabase();
  const signals: RadarSignalsVM = structuredClone(EMPTY_SIGNALS);
  try {
    const state = await readRadarState(shopId);
    signals.traffic.lastCheckedAt = state.lastCollectedAt;
  } catch (err) {
    console.error("[radar] state read failed", err);
  }
  try {
    const { data, error } = await sb
      .from("radar_traffic_daily")
      .select("day, views")
      .eq("shop_id", shopId)
      .order("day", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ day: string; views: number }>;
    signals.traffic.yesterdayViews = rows[0]?.views ?? 0;
    const rest = rows.slice(1);
    signals.traffic.weeklyAverage = rest.length
      ? Math.round(rest.reduce((n, r) => n + r.views, 0) / rest.length)
      : 0;
  } catch (err) {
    console.error("[radar] traffic signal failed", err);
  }
  try {
    const { data, error } = await sb
      .from("seo_settings")
      .select("gsc_connected")
      .eq("shop_id", shopId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    signals.google.connected = Boolean(data?.gsc_connected);
    if (signals.google.connected) {
      const summary = await sb.rpc("read_seo_rankings_summary", { p_shop: shopId });
      if (summary.error) throw new Error(summary.error.message);
      const s = (summary.data ?? {}) as { slipping?: unknown[]; lastCapturedDate?: string | null };
      signals.google.slippingCount = Array.isArray(s.slipping) ? s.slipping.length : 0;
      signals.google.lastCapturedDate = s.lastCapturedDate ?? null;
    }
  } catch (err) {
    console.error("[radar] google signal failed", err);
  }
  try {
    const since = new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10);
    const cut = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("seo_ai_crawl_daily")
      .select("day, hits")
      .eq("shop_id", shopId)
      .gte("day", since);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ day: string; hits: number }>) {
      if (r.day >= cut) signals.aiAssistants.hitsLast7 += r.hits;
      else signals.aiAssistants.hitsPrior7 += r.hits;
    }
  } catch (err) {
    console.error("[radar] ai-assistant signal failed", err);
  }
  return signals;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    if (!isUuid(session.shopId)) {
      return { moves: [], history: [], signals: structuredClone(EMPTY_SIGNALS) };
    }
    const [moves, history, signals] = await Promise.all([
      listMoves(session.shopId, ["draft"]),
      listMoves(session.shopId, ["applied", "dismissed", "expired"]),
      buildSignals(session.shopId),
    ]);
    return { moves: moves.map(toMoveVM), history: history.map(toMoveVM), signals };
  });
}

interface RadarBody {
  action?: string;
  moveId?: string;
  confirm?: boolean;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const body = (await request.json().catch(() => null)) as RadarBody | null;
  if (!body || typeof body.action !== "string" || typeof body.moveId !== "string") {
    return jsonError(422, "bad_request", "action and moveId are required");
  }
  const { moveId } = body;
  try {
    let move: RadarMoveRow;
    switch (body.action) {
      case "apply":
        move = await applyMove({ shopId: session.shopId, moveId, actorId: session.userId ?? null });
        break;
      case "dismiss":
        move = await dismissMove({ shopId: session.shopId, moveId });
        break;
      case "revert":
        move = await revertMove({
          shopId: session.shopId,
          moveId,
          actorId: session.userId ?? null,
          confirm: body.confirm === true,
        });
        break;
      default:
        return jsonError(422, "bad_request", `unknown action: ${body.action}`);
    }
    return dashboardJson(async () => ({ move: toMoveVM(move) }));
  } catch (err) {
    if (err instanceof RadarApplyError) return jsonError(err.status, err.code, err.message);
    console.error(`[radar] ${body.action} failed for move ${moveId}`, err);
    return jsonError(500, "radar_action_failed", "The move could not be completed. Your store was not changed.");
  }
}
```

- [ ] **Step 4: Write the browser client**

```ts
// app/lib/dashboard/radar-client.ts
// Browser data layer for the Radar screen. VM shapes are hand-kept mirrors of
// dashboard.api.radar's loader/action payloads (a .server module cannot be
// imported into the client bundle) - same convention as search-client.ts.
import { apiGet, apiSend } from "./client";

export interface RadarMoveVM {
  id: string;
  kind: string;
  status: "draft" | "applied" | "dismissed" | "expired";
  headline: string;
  rationale: string;
  chips: string[];
  reviewOnly: boolean;
  deepLink: string | null;
  canRevert: boolean;
  reverted: boolean;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
}

export interface RadarSignalsVM {
  traffic: { yesterdayViews: number; weeklyAverage: number; lastCheckedAt: string | null };
  google: { connected: boolean; lastCapturedDate: string | null; slippingCount: number };
  aiAssistants: { hitsLast7: number; hitsPrior7: number };
  competitors: { comingSoon: true };
}

export interface RadarOverviewVM {
  moves: RadarMoveVM[];
  history: RadarMoveVM[];
  signals: RadarSignalsVM;
}

/** Merchant-facing labels per move kind (plain language, no jargon). */
export const RADAR_KIND_LABELS: Record<string, string> = {
  seo_regression_patch: "Google ranking",
  seo_meta_rewrite: "Google ranking",
  seo_content_boost: "Google ranking",
  aeo_refresh: "AI assistants",
  aeo_jsonld_fix: "AI assistants",
  section_refresh: "Store page",
};

export const fetchRadar = (): Promise<RadarOverviewVM> => apiGet<RadarOverviewVM>("/dashboard/api/radar");

export const applyRadarMove = (moveId: string) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "apply", moveId });

export const dismissRadarMove = (moveId: string) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "dismiss", moveId });

export const revertRadarMove = (moveId: string, confirm = false) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "revert", moveId, confirm });

export interface RadarHomeVM {
  readyCount: number;
  dismissed: boolean;
}

export const fetchRadarHome = (): Promise<RadarHomeVM> => apiGet<RadarHomeVM>("/dashboard/api/radar-home");

export const dismissRadarHomeCard = () =>
  apiSend<{ ok: boolean }>("POST", "/dashboard/api/radar-home", { intent: "dismiss" });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/routes/__tests__/dashboard.api.radar.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.radar.tsx app/lib/dashboard/radar-client.ts app/routes/__tests__/dashboard.api.radar.test.ts
git commit -m "dashboard/radar-api: overview loader + apply/dismiss/revert actions with error mapping"
```

---

### Task 12: Home card (`dashboard.api.radar-home` + Dashboard.tsx)

**Files:**
- Create: `app/routes/dashboard.api.radar-home.tsx`
- Modify: `app/components/dashboard/screens/Dashboard.tsx` (add the "moves ready" card)
- Test: `app/routes/__tests__/dashboard.api.radar-home.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession`, `requireSameOrigin`/`dashboardJson`/`jsonError`/`parseJsonObjectBody`; `listMoves`, `readRadarState`, `stampRadarState` (Task 6); `isUuid`. Client side: `fetchRadarHome`/`dismissRadarHomeCard` (Task 11's client), `SCREEN_CACHE_KEYS.radarHome` (Task 13 adds the key - use the string literal `"radar-home"` via the cache key constant added there; if implementing Tasks out of order, add the key now).
- Produces: `GET /dashboard/api/radar-home` -> `{ readyCount: number; dismissed: boolean }`; `POST { intent: "dismiss" }` -> `{ ok: true }`. Dismissal persists server-side (`radar_state.home_card_dismissed_at`); the card auto-returns when a move NEWER than the dismissal is drafted, and is hidden at zero. Mirrors the journey-card pattern (`dashboard.api.setup-progress._index.tsx`).

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/dashboard.api.radar-home.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const SHOP = "11111111-2222-3333-4444-555555555555";
const mocks = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  listMoves: vi.fn(),
  readRadarState: vi.fn(),
  stampRadarState: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: mocks.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: mocks.requireSameOrigin,
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
  parseJsonObjectBody: async (request: Request) => request.json().catch(() => null),
}));
vi.mock("~/lib/radar/store.server", () => ({
  listMoves: mocks.listMoves,
  readRadarState: mocks.readRadarState,
  stampRadarState: mocks.stampRadarState,
}));

import { loader, action } from "../dashboard.api.radar-home";

function get() {
  return { request: new Request("https://x/dashboard/api/radar-home"), params: {}, context: {} } as never;
}
function post(body: unknown) {
  return {
    request: new Request("https://x/dashboard/api/radar-home", {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    params: {}, context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardSession.mockResolvedValue({ shopId: SHOP, userId: "u1" });
  mocks.stampRadarState.mockResolvedValue(undefined);
});

describe("loader", () => {
  it("counts ready moves; an old dismissal is beaten by a newer move", async () => {
    mocks.listMoves.mockResolvedValue([
      { createdAt: "2026-07-20T09:00:00Z" }, { createdAt: "2026-07-19T09:00:00Z" },
    ]);
    mocks.readRadarState.mockResolvedValue({ homeCardDismissedAt: "2026-07-19T12:00:00Z", lastCollectedAt: null, lastDraftedAt: null });
    const body = await ((await loader(get())) as Response).json();
    expect(body).toEqual({ readyCount: 2, dismissed: false });
  });
  it("stays dismissed while nothing newer arrived", async () => {
    mocks.listMoves.mockResolvedValue([{ createdAt: "2026-07-19T09:00:00Z" }]);
    mocks.readRadarState.mockResolvedValue({ homeCardDismissedAt: "2026-07-19T12:00:00Z", lastCollectedAt: null, lastDraftedAt: null });
    const body = await ((await loader(get())) as Response).json();
    expect(body).toEqual({ readyCount: 1, dismissed: true });
  });
  it("returns zero for demo shops without reads", async () => {
    mocks.requireDashboardSession.mockResolvedValue({ shopId: "demo-shop", userId: "u1" });
    const body = await ((await loader(get())) as Response).json();
    expect(body).toEqual({ readyCount: 0, dismissed: false });
    expect(mocks.listMoves).not.toHaveBeenCalled();
  });
});

describe("action", () => {
  it("persists the dismissal", async () => {
    const res = (await action(post({ intent: "dismiss" }))) as Response;
    expect(mocks.requireSameOrigin).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(mocks.stampRadarState).toHaveBeenCalledWith(SHOP, { homeCardDismissedAt: expect.any(String) });
  });
  it("422s an unknown intent", async () => {
    const res = (await action(post({ intent: "nope" }))) as Response;
    expect(res.status).toBe(422);
    expect(mocks.stampRadarState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.radar-home.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the route**

```tsx
// app/routes/dashboard.api.radar-home.tsx
// Home "moves ready" card data (journey-card pattern: loader = data +
// dismissed flag, action = dismiss intent persisted server-side). The card
// self-revives when a move newer than the dismissal is drafted, and the Home
// screen hides it at readyCount 0.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listMoves, readRadarState, stampRadarState } from "~/lib/radar/store.server";
import { isUuid } from "~/lib/ids";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    if (!isUuid(session.shopId)) return { readyCount: 0, dismissed: false };
    const [moves, state] = await Promise.all([
      listMoves(session.shopId, ["draft"]),
      readRadarState(session.shopId),
    ]);
    const newest = moves[0]?.createdAt ?? null; // listMoves orders created_at desc
    const dismissed = Boolean(
      state.homeCardDismissedAt && (!newest || state.homeCardDismissedAt >= newest),
    );
    return { readyCount: moves.length, dismissed };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const body = await parseJsonObjectBody(request);
  if (!body || body.intent !== "dismiss") return jsonError(422, "invalid_intent");
  return dashboardJson(async () => {
    await stampRadarState(session.shopId, { homeCardDismissedAt: new Date().toISOString() });
    return { ok: true };
  });
}
```

- [ ] **Step 4: Add the card to `Dashboard.tsx`**

Follow the journey-card pattern already in the file (state seeded from the screen cache, mount fetch writes back through, alive guard). Additions, matching the file's existing imports (`client`, `Card`, `Btn`, `CDIcon`, `cachedScreenData`/`cacheScreenData`/`SCREEN_CACHE_KEYS` are already imported there; extend the import lists rather than duplicating them):

```tsx
import { fetchRadarHome, dismissRadarHomeCard, type RadarHomeVM } from "~/lib/dashboard/radar-client";
```

State + fetch (place beside the journey state; `SCREEN_CACHE_KEYS.radarHome` is added in Task 13 - if building this task first, add `radarHome: "radar-home"` to `SCREEN_CACHE_KEYS` now):

```tsx
  // Radar "moves ready" card: hidden at zero and while dismissed; the server
  // revives the dismissal when newer moves arrive.
  const [radarHome, setRadarHome] = useState<RadarHomeVM | null>(() =>
    cachedScreenData<RadarHomeVM>(SCREEN_CACHE_KEYS.radarHome),
  );
  useEffect(() => {
    let alive = true;
    fetchRadarHome()
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.radarHome, p);
        if (alive) setRadarHome(p);
      })
      .catch(() => {
        // Keep whatever the cache decided - an unreadable count must never block Home.
      });
    return () => {
      alive = false;
    };
  }, []);
  const dismissRadarCard = useCallback(() => {
    setRadarHome((cur) => (cur ? { ...cur, dismissed: true } : cur)); // optimistic
    dismissRadarHomeCard().catch(() => {});
  }, []);
```

Markup, rendered directly above the `<HomeJourney ... />` element:

```tsx
      {radarHome && !radarHome.dismissed && radarHome.readyCount > 0 && (
        <Card className="cd-radar-home-card">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <CDIcon name="scan" size={22} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                {radarHome.readyCount === 1
                  ? "1 move ready for you"
                  : `${radarHome.readyCount} moves ready for you`}
              </strong>
              <div className="cd-dim" style={{ fontSize: "var(--fs-13)" }}>
                Radar drafted improvements overnight. Review the evidence and apply each in a click.
              </div>
            </div>
            <Btn onClick={() => app.navigate("radar")}>Open Radar</Btn>
            <button
              type="button"
              className="cd-icon-btn"
              aria-label="Dismiss"
              onClick={dismissRadarCard}
            >
              <CDIcon name="x" size={16} />
            </button>
          </div>
        </Card>
      )}
```

(`app.navigate("radar")` typechecks only after Task 13 adds `"radar"` to the `Screen` union - Tasks 12 and 13 land in the same PR; run the Task 13 gate for the combined typecheck. The `cd-icon-btn`/`cd-dim` classes and `--fs-13` token already exist in `dashboard.css`; verify with a quick grep and substitute the file's nearest existing dismiss-button classname if the exact one differs - copy whatever `HomeJourney.tsx`'s dismiss button uses.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/routes/__tests__/dashboard.api.radar-home.test.ts`
Expected: PASS. (`npm run typecheck` is deferred to Task 13's gate because of the `Screen` union dependency.)

- [ ] **Step 6: Commit (with Task 13)**

Committed together with Task 13 - see its commit step.

---

### Task 13: Radar screen + registration (nav, routes, cache, prefetch)

**Files:**
- Create: `app/components/dashboard/screens/Radar.tsx`
- Modify: `app/components/dashboard/context.ts` (`Screen` union + `"radar"`)
- Modify: `app/components/dashboard/routes.ts` (`seg` + `parsePath`)
- Modify: `app/components/dashboard/DashboardApp.tsx` (import, `NAV_GROUPS`, `SCREENS`)
- Modify: `app/lib/dashboard/screen-cache.ts` (`radar`, `radarHome` keys)
- Modify: `app/lib/dashboard/prefetch.ts` (two `WARM_TARGETS` entries)
- Test: `app/components/dashboard/__tests__/routes-radar.test.ts`

**Registration decisions (from reading the real files):** `routes.ts` has no `/grow` prefix - nav groups are visual only and every Grow screen owns a top-level segment (`/dashboard/autopilot`, `/dashboard/campaigns`). Radar therefore lives at **`/dashboard/radar`** with nav item `{ id: "radar", label: "Radar", icon: "scan" }` in the Grow group after Autopilot (`scan` already maps to the Lucide `Radar` icon in `icons.tsx:115` - no icon registry change needed).

- [ ] **Step 1: Write the failing route test**

```ts
// app/components/dashboard/__tests__/routes-radar.test.ts
import { describe, expect, it } from "vitest";
import { parsePath, pathFor } from "../routes";

describe("Radar route", () => {
  it("round-trips /dashboard/radar", () => {
    const nav = { screen: "radar" as const, param: null, sub: null };
    expect(pathFor(nav)).toBe("/dashboard/radar");
    expect(parsePath("/dashboard/radar")).toEqual(nav);
  });
  it("rejects unknown radar sub-paths", () => {
    expect(parsePath("/dashboard/radar/extra")).toBeNull();
  });
});
```

Run: `npx vitest run app/components/dashboard/__tests__/routes-radar.test.ts`
Expected: FAIL - `"radar"` is not a `Screen` / `parsePath` returns null.

- [ ] **Step 2: Registration edits**

`app/components/dashboard/context.ts` - extend the `Screen` union (after `"autopilot"`):

```ts
  | "autopilot"
  // Radar - overnight watcher: drafted moves the merchant applies each morning.
  | "radar"
```

`app/components/dashboard/routes.ts` - in `seg`:

```ts
    case "radar":
      return "radar";
```

and in `parsePath`'s switch:

```ts
    case "radar":
      return b ? null : { screen: "radar", param: null, sub: null };
```

`app/components/dashboard/DashboardApp.tsx`:

```tsx
import ScreenRadar from "./screens/Radar";
```

In `NAV_GROUPS`, Grow group, after the Autopilot item:

```tsx
      { id: "radar", label: "Radar", icon: "scan" },
```

In the `SCREENS` record:

```tsx
  radar: ScreenRadar,
```

`app/lib/dashboard/screen-cache.ts` - add to `SCREEN_CACHE_KEYS`:

```ts
  radar: "radar",
  radarHome: "radar-home",
```

`app/lib/dashboard/prefetch.ts` - import `fetchRadar`, `fetchRadarHome` from `./radar-client` and add to `WARM_TARGETS` (radar-home next to setup-progress so Home's cards warm first; the screen payload later in the list):

```ts
  [SCREEN_CACHE_KEYS.radarHome, fetchRadarHome],
```
(directly after the `setupProgress` entry), and
```ts
  [SCREEN_CACHE_KEYS.radar, fetchRadar],
```
(directly after the `search` entry).

- [ ] **Step 3: Write the screen**

```tsx
// app/components/dashboard/screens/Radar.tsx
// Radar - the overnight watcher's morning queue. Moves arrive fully evidenced
// and apply with one click; nothing touches the live store without that click.
// Seeds from the screen cache for instant paint, then refetches (mandatory
// screen-cache contract: seed + write-through + WARM_TARGETS entry).
import { useCallback, useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  applyRadarMove,
  dismissRadarMove,
  fetchRadar,
  RADAR_KIND_LABELS,
  revertRadarMove,
  type RadarMoveVM,
  type RadarOverviewVM,
} from "~/lib/dashboard/radar-client";

type Tab = "moves" | "history";

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function SignalTile(props: { icon: string; label: string; value: string; note: string }) {
  return (
    <Card className="cd-radar-tile">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CDIcon name={props.icon} size={16} />
        <span className="cd-dim" style={{ fontSize: "var(--fs-12)" }}>{props.label}</span>
      </div>
      <div style={{ fontSize: "var(--fs-18)", fontWeight: 600, marginTop: 4 }}>{props.value}</div>
      <div className="cd-dim" style={{ fontSize: "var(--fs-12)" }}>{props.note}</div>
    </Card>
  );
}

export default function Radar({ app }: { app: DashboardCtx }) {
  const { toast } = app;
  const [data, setData] = useState<RadarOverviewVM | null>(() =>
    cachedScreenData<RadarOverviewVM>(SCREEN_CACHE_KEYS.radar),
  );
  const [tab, setTab] = useState<Tab>("moves");
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Two-step revert: a conflict (409 revert_conflict) arms the button; the
  // second click sends confirm=true.
  const [armedRevertId, setArmedRevertId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await fetchRadar();
      cacheScreenData(SCREEN_CACHE_KEYS.radar, fresh);
      setData(fresh);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchRadar()
      .then((fresh) => {
        cacheScreenData(SCREEN_CACHE_KEYS.radar, fresh);
        if (alive) {
          setData(fresh);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(
    async (move: RadarMoveVM, fn: () => Promise<unknown>, doneMsg: string) => {
      setBusyId(move.id);
      try {
        await fn();
        toast(doneMsg, "ok");
        await load();
      } catch (err) {
        if (err instanceof DashboardApiError && err.code === "revert_conflict") {
          setArmedRevertId(move.id);
          toast(`${err.message} Click Revert again to continue.`, "warn", "critical");
        } else {
          toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
        }
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );

  const moves = data?.moves ?? [];
  const history = data?.history ?? [];
  const signals = data?.signals ?? null;

  return (
    <div className="cd-screen">
      <div className="cd-screen-head">
        <h1>Radar</h1>
        <p className="cd-dim">
          Radar watches your traffic, Google results and AI assistants overnight and drafts moves you
          can apply in a click. Nothing changes on your store until you say so.
        </p>
      </div>

      {signals && (
        <div className="cd-radar-tiles" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <SignalTile
            icon="chart"
            label="Traffic"
            value={`${signals.traffic.yesterdayViews} views`}
            note={
              signals.traffic.lastCheckedAt
                ? `vs ${signals.traffic.weeklyAverage}/day avg · checked ${whenLabel(signals.traffic.lastCheckedAt)}`
                : "First check runs tonight"
            }
          />
          <SignalTile
            icon="search"
            label="Google"
            value={signals.google.connected ? `${signals.google.slippingCount} pages slipping` : "Not connected"}
            note={
              signals.google.connected
                ? signals.google.lastCapturedDate
                  ? `data through ${signals.google.lastCapturedDate}`
                  : "Waiting for first data"
                : "Connect Google in Store > Preferences"
            }
          />
          <SignalTile
            icon="bot"
            label="AI assistants"
            value={`${signals.aiAssistants.hitsLast7} visits`}
            note={`${signals.aiAssistants.hitsPrior7} the week before`}
          />
          <SignalTile icon="eye" label="Competitors" value="Coming soon" note="Radar will watch confirmed competitors here" />
        </div>
      )}

      <div className="cd-tabs" role="tablist" style={{ marginTop: 16 }}>
        <button type="button" role="tab" aria-selected={tab === "moves"} className={tab === "moves" ? "cd-tab active" : "cd-tab"} onClick={() => setTab("moves")}>
          Moves{moves.length > 0 ? ` (${moves.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "cd-tab active" : "cd-tab"} onClick={() => setTab("history")}>
          History
        </button>
      </div>

      {loadError && !data && (
        <Card>
          <p>Radar couldn't load. </p>
          <Btn onClick={() => void load()}>Retry</Btn>
        </Card>
      )}

      {tab === "moves" && data && moves.length === 0 && (
        <Card>
          <strong>All clear this morning.</strong>
          <p className="cd-dim">
            Radar checks your store every night: page traffic, where you show up on Google, and whether
            AI assistants can read you. When something needs attention, a drafted move appears here.
            Connecting Google in Store &gt; Preferences gives Radar more to work with.
          </p>
        </Card>
      )}

      {tab === "moves" &&
        moves.map((m) => (
          <Card key={m.id} className="cd-radar-move">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="cd-chip">{RADAR_KIND_LABELS[m.kind] ?? "Store"}</span>
              {m.chips.map((c) => (
                <span key={c} className="cd-chip cd-dim">{c}</span>
              ))}
            </div>
            <h3 style={{ margin: "8px 0 4px" }}>{m.headline}</h3>
            <p className="cd-dim">{m.rationale}</p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {m.reviewOnly && m.deepLink ? (
                <>
                  <Btn onClick={() => { window.location.href = m.deepLink as string; }}>Review</Btn>
                  <Btn ghost disabled={busyId === m.id}
                    onClick={() => void run(m, () => applyRadarMove(m.id), "Marked done.")}>
                    Mark done
                  </Btn>
                </>
              ) : (
                <Btn disabled={busyId === m.id}
                  onClick={() => void run(m, () => applyRadarMove(m.id), "Applied. You can revert it from History.")}>
                  {busyId === m.id ? "Applying…" : "Apply"}
                </Btn>
              )}
              <Btn ghost disabled={busyId === m.id}
                onClick={() => void run(m, () => dismissRadarMove(m.id), "Dismissed.")}>
                Dismiss
              </Btn>
            </div>
          </Card>
        ))}

      {tab === "history" && history.length === 0 && (
        <Card>
          <p className="cd-dim">Applied and dismissed moves will show up here.</p>
        </Card>
      )}

      {tab === "history" &&
        history.map((m) => (
          <Card key={m.id} className="cd-radar-move">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="cd-chip">
                {m.reverted ? "Reverted" : m.status === "applied" ? "Applied" : m.status === "expired" ? "Expired" : "Dismissed"}
              </span>
              <span className="cd-dim" style={{ fontSize: "var(--fs-12)" }}>
                {whenLabel(m.appliedAt ?? m.resolvedAt ?? m.createdAt)}
              </span>
            </div>
            <h3 style={{ margin: "8px 0 4px" }}>{m.headline}</h3>
            {m.canRevert && (
              <Btn ghost disabled={busyId === m.id}
                onClick={() =>
                  void run(m, () => revertRadarMove(m.id, armedRevertId === m.id), "Reverted.")
                }>
                {armedRevertId === m.id ? "Revert (overwrites newer edits)" : "Revert"}
              </Btn>
            )}
          </Card>
        ))}
    </div>
  );
}
```

Adjust the `Btn` prop for the secondary style to whatever `ui.tsx` actually exposes (`ghost`, `variant`, or `kind` - read the `Btn` signature in `app/components/dashboard/ui.tsx` and use its real secondary prop; same for `toast`'s exact signature, which `DashboardCtx` types). The `cd-chip`/`cd-tab`/`cd-screen` classes exist in `dashboard.css`; if a name differs, use the closest existing class from another screen rather than adding new CSS.

- [ ] **Step 4: Run tests + the combined gate for Tasks 12-13**

```bash
npx vitest run app/components/dashboard/__tests__/routes-radar.test.ts app/routes/__tests__/dashboard.api.radar-home.test.ts
npm run typecheck && npm run lint && npm run build
```
Expected: all PASS / exit 0 (this also proves `app.navigate("radar")` from Task 12 typechecks and that no `.server` module leaked into the client graph).

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Radar.tsx app/components/dashboard/screens/Dashboard.tsx app/components/dashboard/context.ts app/components/dashboard/routes.ts app/components/dashboard/DashboardApp.tsx app/lib/dashboard/screen-cache.ts app/lib/dashboard/prefetch.ts app/routes/dashboard.api.radar-home.tsx app/routes/__tests__/dashboard.api.radar-home.test.ts app/components/dashboard/__tests__/routes-radar.test.ts
git commit -m "dashboard/radar: Radar screen, nav + route registration, Home moves-ready card, cache wiring"
```

---

### Task 14: Full gate + phase wrap

**Files:** none new.

- [ ] **Step 1: Full eval pipeline**

```bash
npm run typecheck && npm run lint && npm run build && npx vitest run
```
Expected: all exit 0; zero warnings on touched files. The build's `scripts/verify-client-bundle.mjs` scan must pass - if it flags anything from this branch, remove the marker (likely suspects: a stray internal comment in `Radar.tsx` or `radar-client.ts`).

- [ ] **Step 2: Merchant-copy sweep**

```bash
grep -rn "ploy" app/components app/lib/dashboard --include="*.ts" --include="*.tsx"
```
Expected: zero matches (client bundles and merchant-facing modules never carry the internal noun; it may appear only in `app/lib/radar/*.server.ts`, route server files, tests, and SQL).

- [ ] **Step 3: /code-review**

Run the `/code-review` slash command on the working tree. Resolve every blocker; downgrade nits explicitly with a one-line justification each.

- [ ] **Step 4: Deployment checklist (verify, do not push)**

- `vercel.json` carries `/cron/radar-collect` (10:00 UTC) and `/cron/radar-draft` (10:30 UTC) alongside the existing entries.
- Migration `20260720130000_radar_core.sql` is applied on prod (`mcp__supabase__list_migrations` shows it) and the three verification queries from Task 1 Step 2 pass.
- No new env vars are required (`RADAR_DRAFT_MODEL` is optional; `CRON_SECRET` and `ANTHROPIC_API_KEY` already exist).
- Prod autodeploys `origin/main` - do NOT push or merge; that waits for explicit instruction.

- [ ] **Step 5: Commit any gate fixes**

One commit per logical fix, subject prefixed with the module touched (e.g. `radar/detect: fix lint warning in ...`). Never `--no-verify`, never suppress a type error to pass the gate.

## Out of scope for this plan

- **Phase D entirely:** `radar_competitor` / `radar_snapshot` tables, `cron.radar-discover` (Claude web_search competitor discovery), the polite snapshot fetcher + hash-gated extraction + diffs, competitor detectors, counter/informational competitor moves, the Competitors tab, and a live Competitors signal tile (Phase C ships the tile as "coming soon").
- Home/collection SEO overrides at serve time (the storefront reads product overrides only; extending serve-time override coverage is seo-subsystem work, not Radar's).
- Merchant FAQ storage / FAQ JSON-LD authoring (would unlock a richer content-boost apply).
- Pricing moves, one-click price changes, push/email delivery of the morning list, Bing/other consoles, backlink analysis, multi-language (spec v1 exclusions).
- The `storefront.pages.$handle` counter-page route (spec decision 7).
- A11y/motion polish beyond the existing `cd-*` primitives (GSAP flourishes can ride a later design pass; the screen ships functional and consistent first).










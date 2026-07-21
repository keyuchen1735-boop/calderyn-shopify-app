# Radar Phase D: competitors - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Radar learns to watch competitors. Weekly, `cron.radar-discover` uses Claude's web_search server tool (its first use in this repo) to find up to 5 competitor stores per shop, seeded from the shop's name, description and top products - written as **suggestions only**; nothing is watched until the merchant confirms. Nightly, the existing `cron.radar-collect` drain also snapshots each confirmed competitor's site politely (robots.txt respected, honest UA, 5s timeout, ~1MB cap, max 10 pages/competitor, max 5 watched competitors/shop), hashes the normalized text, and stores deterministic extracts + diffs only when a page actually changed. Pure detectors over those diff rows feed the SAME candidate -> draft -> move pipeline from Phase C: counter moves that refresh the merchant's own home hero copy (modify-existing-pages only) and **informational** pricing moves (evidence + deep link, never auto-apply). The Radar screen gains a Competitors tab (suggested -> Confirm/Dismiss, watching list + change timeline) and the Signals competitor tile goes live. Spec: `docs/superpowers/specs/2026-07-20-radar-background-watcher-design.md`, Phase D.

**Architecture:** Phase D extends `app/lib/radar/` with four server modules: `fetch.server.ts` (polite fetcher + robots parser, injectable fetch for tests), `competitor-store.server.ts` (radar_competitor/radar_snapshot persistence, watch-limit enforcement), `snapshot.server.ts` (normalize -> sha256 hash -> deterministic extract -> diff; hash-gated so unchanged pages write zero rows and cost zero Claude), and `discovery.server.ts` (web_search discovery, quota-gated by a new `"radar_discovery"` AiFeature). Competitor detectors live in `detect-competitors.server.ts` as pure functions over `CompetitorDiffInput[]` (same style as `detect.server.ts`); `RadarCollectInputs` gains a `competitorDiffs` field loaded by `loadRadarInputs`, and `detectAll` concatenates the new detectors - so the drafter, dedup/cooldown rules (`isCoolingDown` is kind-agnostic), expiry sweep, quota-gated polish and the dashboard action path all work on competitor moves with zero drafter changes beyond two new kinds in the DB check constraint.

**Grounded facts** (verified in-repo 2026-07-21; bind to these):
- `@anthropic-ai/sdk` is `^0.100.1` (installed 0.100.1). `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` defines `WebSearchTool20250305` with `type: 'web_search_20250305'` (line 1809) and it is a member of `ToolUnion`, so the server tool type-checks on plain `client.messages.create`. The newer `web_search_20260209` variant also exists but requires Opus 4.6+/Sonnet 4.6+ class models; Radar's discovery model defaults to the digest-class model (`DEFAULT_DIGEST_MODEL = "claude-haiku-4-5"` in `app/lib/assistant/anthropic.server.ts`), which supports only the basic variant - **use `web_search_20250305`**. No raw-HTTP fallback needed.
- `getAnthropic()` / model pickers: `app/lib/assistant/anthropic.server.ts` (usage-instrumented `messages.create`; no literal model ids outside that file - Phase D adds a `radarDiscoveryModel()` picker there).
- Quota: `app/lib/ai-quota.server.ts` - `AiFeature` union + `QUOTAS` record; `checkAiQuota({ shopId, feature, trusted })` records a hit at check time.
- Candidate shape: `RadarCandidate` in `app/lib/radar/types.ts` = `{ kind, dedupKey, headline, rationale, evidence: { chips, facts }, payload: Record<string, unknown> & { applyMode } }`. `RadarApplyMode` already includes `"refresh_section"` and `"review"` - competitor moves need no new apply mode, so `apply.server.ts` / `apply-section.server.ts` are untouched.
- Kind check constraint (in `supabase/migrations/20260720130000_radar_core.sql`, inline on the column, auto-named `radar_ploy_kind_check`): `check (kind in ('seo_regression_patch','seo_meta_rewrite','seo_content_boost','aeo_refresh','aeo_jsonld_fix','section_refresh'))`. Phase D's migration drops and re-adds it with `'competitor_counter','competitor_price'` appended.
- Drafter/store: `insertDraftMove(shopId, candidate)` returns `"inserted" | "duplicate"` (23505 -> duplicate); `isCoolingDown(rows, { kind, dedupKey }, now)` matches on `(kind, dedupKey)` only - new kinds get cooldowns for free. `stampRadarState(shopId, patch)` upserts `radar_state`; Phase D extends its patch with `lastDiscoveredAt`.
- Cron drain shape: `cron.radar-collect.tsx` / `cron.radar-draft.tsx` - `isAuthorizedCron` + `getSupabase().rpc("radar_shop_queue", ...)` + 50s `TIME_BUDGET_MS` + `export const config = { maxDuration: 60 }`; per-shop try/catch. The discover cron mirrors this with its own queue RPC.
- Demo gating: non-uuid shopIds are fixture tenants (every radar module guards with `isUuid`); real demo shops are `shops.demo_mode = true`, read via `isShowcaseShop(shopId)` (`app/lib/demo/showcase.server.ts`, process-cached, fails safe to `false`).
- Published-storefront signals for the discovery queue: legacy = `page_document` row with `page_key = 'home'` and `published_json is not null`; runtime 1 = `storefront_release.published_version_id is not null` (`app/lib/storefront-bundle/build.server.ts`).
- Discovery seeds: `getStoreSettings(shopId).storeName` (`app/lib/storefront/settings.server.ts`), `getSeoSettings(shopId).orgDescription` (`app/lib/seo/seo-store.server.ts`), `getCatalog().listProducts(shopId, { limit: 5 })` titles (`app/lib/storefront/catalog.server.ts`), own origin via `getShopStorefrontOrigin(shopId)` (returns `""` when no slug).
- Route/UI conventions: `dashboard.api.radar.tsx` (loader shapes VMs field-by-field; `dashboardJson`/`jsonError`/`requireSameOrigin`; `RadarSignalsVM.competitors` is currently `{ comingSoon: true }`), browser mirror `app/lib/dashboard/radar-client.ts` (hand-kept), screen `app/components/dashboard/screens/Radar.tsx` (`Segmented` tabs `moves | history`, `SignalTile` grid, `Card`/`Btn`/`Placeholder` primitives, `busyId` + `run()` action helper). The Radar screen-cache key already exists (`SCREEN_CACHE_KEYS.radar` + prefetch entry) - Competitors data rides the same `fetchRadar()` payload, so **no new WARM_TARGETS entry is needed**.
- Tests: vitest, co-located `__tests__`, ALL imports at top, `vi.hoisted` mocks declared before `vi.mock` blocks with `// eslint-disable-next-line import/first` on post-mock imports (mirror `app/routes/__tests__/cron.radar.test.ts`).

**Deliberate design choices to justify once:**
- **No Claude in the snapshot pipeline at all.** The spec allows Claude for "positioning-change summaries". Extraction is fully deterministic (title/meta/headings/prices via regex), diffs are deterministic, and the merchant-facing summary of a positioning change is exactly what the Phase C drafter's polish step already produces - quota-gated under `"radar"`, template fallback, ploy-guard. Adding a second Claude call site in the collector would double-spend for copy the drafter rewrites anyway. So: hash-gated means unchanged pages cost zero Claude, and *changed* pages cost zero Claude too until the drafter polishes the resulting candidate. This is the "decide and justify" answer: **no new bucket for snapshots; discovery gets its own `"radar_discovery"` bucket** (weekly cadence but daily cap 2 as belt-and-braces against a looping cron; separate from `"radar"` so a discovery run can never starve the nightly drafter's 5-call polish budget).
- **Snapshots ride `collectShop` (extend, not a parallel cron step).** One cursor (`radar_state.last_collected_at`), one fairness ordering, one failure-isolation boundary, and diffs land before `cron.radar-draft` runs 30 minutes later - a separate cron would need its own cursor and could race the drafter. Budget math: worst case 5 competitors x (1 robots + 1 home + 9 pages) = 55 fetches x 5s timeout each could blow the 50s budget, so `snapshotWatchingCompetitors` takes an explicit `deadline` (the cron's own budget end) plus a per-shop `SNAPSHOT_FETCH_BUDGET = 30` fetch cap; competitors are processed in `updated_at asc` order so coverage rotates across nights instead of starving the tail. A budget-stopped snapshot run is not an error - the next night resumes.
- **Two new kinds, not three.** `competitor_counter` covers both "new page/product in the category" and "positioning/copy change" - the spec's counter for both is the same action (strengthen own home hero / section copy via apply-time generation), so they differ only in evidence, and one open counter per competitor (`dedupKey = comp-counter:{competitorId}`) prevents a noisy competitor from flooding the queue. `competitor_price` is its own kind because its apply semantics are categorically different: **always `applyMode: "review"`** (evidence + deep link to the merchant's own pricing; applying just marks it done). Counters target the home hero only (`target: "home"`) - PDP/collection counters would need per-product attribution from competitor pages, which is guesswork; home-hero refresh is truthful and works on both storefront runtimes (the legacy-PDP downgrade guard in `draft.server.ts` only fires for `target: "pdp"`, so it never touches these).
- **First snapshot of a page is a baseline, not a change.** `diff` stays null; detectors only ever see rows where a *previous* snapshot existed and the hash moved. Confirming a competitor never instantly produces moves from thin air.
- **Robots semantics (conservative):** 2xx -> parse (Disallow lines only; Allow lines ignored, which only ever makes us *more* conservative); 4xx -> allow-all (standard crawler convention: no robots file means no restrictions); 5xx/network/timeout -> treat as disallow-all for the night and move on. Groups: a `User-agent` group matching `calderynradar` wins over `*`.
- **Discovery normalizes suggestions to the site origin** (scheme + host, path `/`), dedupes by host, and drops the merchant's own domain, marketplaces/socials (Amazon, eBay, Etsy, Walmart, AliExpress, Temu, Facebook, Instagram, Pinterest, YouTube, Reddit, Wikipedia) and non-http(s) URLs. Inserts are suggestion-only (`status: 'suggested'`); a unique `(shop_id, url)` index plus 23505-as-duplicate means re-discovery can never resurrect a dismissed competitor or touch a watching one, and discovery skips entirely when the shop already has 5 open suggestions (no backlog spam) or 5 watched competitors (queue RPC filters these too).
- **Watch-limit enforcement is server-side in the action path** (`setCompetitorStatus` counts `watching` rows before flipping to `watching`; >= 5 -> `limit_reached` -> 422 with plain copy). The count-then-update has a benign race (two concurrent confirms could reach 6); acceptable for a single-merchant dashboard action, noted in code.

**Tech Stack:** Remix 2.16.7 (pinned), TypeScript strict, Supabase (service-role via `getSupabase()`), vitest, `@anthropic-ai/sdk` 0.100.1 via `getAnthropic()` + `web_search_20250305` server tool, Node 20 `fetch`/`AbortSignal.timeout`/`node:crypto`, existing `cd-*` dashboard primitives.

## Global Constraints

- All `@remix-run/*` stay pinned exact 2.16.7; no new top-level dependencies (sha256 via `node:crypto`, HTML parsing via bounded regex - no cheerio).
- `.server.ts` files never imported from client modules; loaders shape DTOs field-by-field; the browser mirror `radar-client.ts` is hand-kept in sync.
- Every dashboard write goes `requireSameOrigin(request)` then `requireDashboardSession(request)`; shop identity comes from the session, never the body.
- **Claude web_search is the discovery mechanism and its only call site is `discovery.server.ts`.** Tool declaration is exactly `{ type: "web_search_20250305", name: "web_search", max_uses: 3 }` (verified against the installed SDK - see Grounded facts). `checkAiQuota({ shopId, feature: "radar_discovery", trusted: true })` is called immediately before **each** `messages.create` (including `pause_turn` resumes - each resume is a fresh API call and a fresh quota hit); the `"radar_discovery"` bucket is capped at 2/day as belt-and-braces on a weekly cron. Suggestions land `status: 'suggested'`, NEVER auto-watched. No literal model ids outside `anthropic.server.ts` (`radarDiscoveryModel()` picker, env-overridable via `RADAR_DISCOVERY_MODEL`).
- **Polite snapshot fetching, always:** honest UA `"CalderynRadar/1.0 (+https://calderyncompany.com)"` on every request (robots.txt included), `AbortSignal.timeout(5000)`, ~1MB response cap enforced by content-length check AND a streaming reader loop, robots.txt fetched + parsed per host with the disallow matcher applied to every page URL, max 10 pages/competitor/night, max 5 watched competitors/shop, plus the 30-fetch/shop budget and the cron deadline. Content hash (sha256 of normalized text) gates persistence and extraction downstream - unchanged pages write nothing and cost zero Claude.
- **External fetches never run for demo/fixture shops:** `isUuid` guard (fixture tenants) + `isShowcaseShop` guard (`shops.demo_mode`) in both `snapshotWatchingCompetitors`'s caller and `discoverShopCompetitors`; the discovery queue RPC also filters `demo_mode` at SQL level.
- Detectors are pure functions over diff rows (no DB, no Claude, no clock reads except parameters); evidence is truthful (only facts present in the stored diff); **pricing moves are `applyMode: "review"` ALWAYS** - a test asserts it.
- The nightly snapshot step rides the EXISTING `cron.radar-collect` drain via `collectShop(shopId, deadline)`; discovery is a NEW weekly cron (`vercel.json` entry, `maxDuration: 60`, 50s budget, per-shop failure isolation, cursor fairness via `radar_state.last_discovered_at` nulls-first).
- All merchant copy plain language; the internal noun **"ploy" never merchant-visible** (new UI strings, VM fields, briefs and detector copy are swept by the gate's grep). Competitor names/urls shown in the UI are data from the merchant's own watch list, not endorsements - the tab carries a one-line caption saying suggestions come from web search and listed stores aren't affiliated.
- Upstream errors (fetch failures, Supabase, Anthropic) are logged with payloads and isolated per competitor/page/shop - never swallowed silently, never halting a drain.
- Migrations: `supabase/migrations/YYYYMMDDHHMMSS_name.sql`, shop-scoped RLS + self-test do-blocks (same style as `20260720130000_radar_core.sql`), applied to prod (`ajgrmnvzxfxxlwrxcgnu`) via the supabase MCP.
- Tests: vitest, co-located `__tests__`, ALL imports at top (`import/first`), `vi.hoisted` spies + `vi.mock` after them; tests mock `fetch` (never hit real sites) and mock Anthropic (never spend).
- Pre-commit gate per task: `npx vitest run <touched suites>`; full gate (`npm run typecheck && npm run lint && npm run build && npx vitest run`) in the final task.

---

### Task 1: Migration - competitor tables, kind-constraint update, discovery queue

**Files:**
- Create: `supabase/migrations/20260721120000_radar_competitors.sql`

**Interfaces:**
- Tables `radar_competitor`, `radar_snapshot`; `radar_state.last_discovered_at` column; `radar_ploy_kind_check` re-created with `competitor_counter` / `competitor_price`; RPC `radar_discovery_queue(p_limit int default 200) returns table (shop_id uuid)`.
- Consumed by Tasks 3-9.

- [ ] **Step 1: Write the migration**

```sql
-- Radar Phase D: competitors (spec 2026-07-20-radar-background-watcher-design.md).
--  1. radar_competitor: auto-discovered competitor stores. status 'suggested'
--     until the merchant confirms ('watching') or dismisses; unique (shop_id,
--     url) so re-discovery can never duplicate or resurrect a row. Max 5
--     'watching' per shop is enforced in the dashboard action (code), not DDL.
--  2. radar_snapshot: polite nightly page snapshots for watching competitors.
--     captured_day + unique (competitor_id, url, captured_day) makes the
--     nightly upsert idempotent (a plain date column instead of an expression
--     index because captured_at::date is not immutable). diff is null for
--     baselines and unchanged pages are never inserted at all (hash-gated in
--     code), so this table only grows when a competitor actually changes.
--  3. radar_ploy gains two kinds: competitor_counter (refresh own home hero)
--     and competitor_price (informational review move; never auto-applies).
--  4. radar_state.last_discovered_at: cursor for the weekly discovery drain.
--  5. radar_discovery_queue: shops with a published storefront (either
--     runtime), fewer than 5 watched competitors, and demo_mode off - ordered
--     by the discovery cursor nulls first (same fairness rule as
--     radar_shop_queue).
-- RLS follows the storefront-facing tenant convention via
-- public.current_shop_id(); intentionally NOT added to the frozen
-- app/lib/security/tenant-tables.ts census (same stance as radar_core).

create table if not exists public.radar_competitor (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  url                text not null,
  name               text not null default '',
  status             text not null default 'suggested'
                     check (status in ('suggested','watching','dismissed')),
  discovery_evidence jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists radar_competitor_shop_url_idx
  on public.radar_competitor (shop_id, url);
create index if not exists radar_competitor_shop_status_idx
  on public.radar_competitor (shop_id, status);

alter table public.radar_competitor enable row level security;
drop policy if exists radar_competitor_shop_scope on public.radar_competitor;
create policy radar_competitor_shop_scope on public.radar_competitor
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_competitor from anon, authenticated;
grant select on table public.radar_competitor to app_web;

create table if not exists public.radar_snapshot (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  competitor_id uuid not null references public.radar_competitor(id) on delete cascade,
  url           text not null,
  captured_at   timestamptz not null default now(),
  captured_day  date not null default (now() at time zone 'utc')::date,
  content_hash  text not null,
  extracted     jsonb not null default '{}'::jsonb,
  diff          jsonb
);

create unique index if not exists radar_snapshot_daily_idx
  on public.radar_snapshot (competitor_id, url, captured_day);
create index if not exists radar_snapshot_shop_recent_idx
  on public.radar_snapshot (shop_id, captured_at desc);

alter table public.radar_snapshot enable row level security;
drop policy if exists radar_snapshot_shop_scope on public.radar_snapshot;
create policy radar_snapshot_shop_scope on public.radar_snapshot
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_snapshot from anon, authenticated;
grant select on table public.radar_snapshot to app_web;

alter table public.radar_state
  add column if not exists last_discovered_at timestamptz;

-- Two new competitor kinds. The original constraint was inline on the column
-- (auto-named radar_ploy_kind_check); drop + re-add with the full list.
alter table public.radar_ploy drop constraint if exists radar_ploy_kind_check;
alter table public.radar_ploy add constraint radar_ploy_kind_check check (kind in (
  'seo_regression_patch','seo_meta_rewrite','seo_content_boost',
  'aeo_refresh','aeo_jsonld_fix','section_refresh',
  'competitor_counter','competitor_price'));

-- Weekly discovery drain queue. Only shops that (a) have a published
-- storefront on either runtime, (b) can still watch more competitors, and
-- (c) are not demo shops (external fetches and Claude spend never run for
-- demos). Cursor fairness: last_discovered_at asc nulls first.
create or replace function public.radar_discovery_queue(p_limit int default 200)
returns table (shop_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.shops s
  left join public.radar_state rs on rs.shop_id = s.id
  where coalesce(s.demo_mode, false) = false
    and (
      exists (select 1 from public.page_document pd
              where pd.shop_id = s.id and pd.page_key = 'home'
                and pd.published_json is not null)
      or exists (select 1 from public.storefront_release sr
                 where sr.shop_id = s.id and sr.published_version_id is not null)
    )
    and (select count(*) from public.radar_competitor rc
         where rc.shop_id = s.id and rc.status = 'watching') < 5
  order by rs.last_discovered_at asc nulls first, s.id
  limit p_limit;
$$;
revoke execute on function public.radar_discovery_queue(int) from public, anon, authenticated;

-- Self-tests: fail the apply if any invariant is missing.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_competitor' and rowsecurity = true) then
    raise exception 'radar_competitor is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_snapshot' and rowsecurity = true) then
    raise exception 'radar_snapshot is missing RLS';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'radar_competitor_shop_url_idx') then
    raise exception 'radar_competitor_shop_url_idx was not created';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'radar_snapshot_daily_idx') then
    raise exception 'radar_snapshot_daily_idx (idempotency index) was not created';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'radar_state' and column_name = 'last_discovered_at'
  ) then
    raise exception 'radar_state.last_discovered_at was not added';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'radar_ploy_kind_check'
      and pg_get_constraintdef(oid) like '%competitor_counter%'
      and pg_get_constraintdef(oid) like '%competitor_price%'
  ) then
    raise exception 'radar_ploy_kind_check does not include the competitor kinds';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'radar_discovery_queue'
  ) then
    raise exception 'radar_discovery_queue was not created';
  end if;
end $$;
```

- [ ] **Step 2: Apply to prod via the supabase MCP**

Use `mcp__supabase__apply_migration` (project `ajgrmnvzxfxxlwrxcgnu`) with the file name and contents. Then verify with `mcp__supabase__execute_sql`:

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'radar_ploy_kind_check';
-- expect: ... 'section_refresh', 'competitor_counter', 'competitor_price' ...
select * from public.radar_discovery_queue(5);      -- rows or empty, not an error
select count(*) from public.radar_competitor;       -- 0
select count(*) from public.radar_snapshot;         -- 0
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260721120000_radar_competitors.sql
git commit -m "radar/migrations: competitor + snapshot tables, competitor move kinds, discovery queue"
```

---

### Task 2: Polite fetcher + robots parser (`app/lib/radar/fetch.server.ts`)

**Files:**
- Create: `app/lib/radar/fetch.server.ts`
- Test: `app/lib/radar/__tests__/fetch.server.test.ts`

**Interfaces:**
- Produces (used by Tasks 4, 7): `RADAR_USER_AGENT`, `FETCH_TIMEOUT_MS`, `MAX_RESPONSE_BYTES`, `politeFetch(url, fetchImpl?)`, `parseRobots(text)`, `isPathAllowed(rules, path)`, `loadRobots(origin, fetchImpl?)`, types `PoliteFetchResult`, `RobotsRules`.
- `fetchImpl` defaults to global `fetch`; tests inject a mock and never touch the network.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/fetch.server.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  FETCH_TIMEOUT_MS,
  isPathAllowed,
  loadRobots,
  MAX_RESPONSE_BYTES,
  parseRobots,
  politeFetch,
  RADAR_USER_AGENT,
} from "../fetch.server";

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

describe("politeFetch", () => {
  it("sends the honest UA and a 5s timeout signal", async () => {
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["user-agent"]).toBe(RADAR_USER_AGENT);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return htmlResponse("<html>ok</html>");
    });
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res).toMatchObject({ ok: true, status: 200, text: "<html>ok</html>" });
    expect(RADAR_USER_AGENT).toBe("CalderynRadar/1.0 (+https://calderyncompany.com)");
    expect(FETCH_TIMEOUT_MS).toBe(5000);
  });
  it("rejects oversized responses via content-length without reading the body", async () => {
    const impl = vi.fn(async () =>
      htmlResponse("x", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res.ok).toBe(false);
  });
  it("caps streamed bodies at ~1MB via the reader loop", async () => {
    const big = "a".repeat(MAX_RESPONSE_BYTES + 10);
    const impl = vi.fn(async () => new Response(big, { status: 200 }));
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("large");
  });
  it("returns ok:false with the status for HTTP errors and ok:false for network errors", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const res404 = await politeFetch("https://rival.example/", notFound as unknown as typeof fetch);
    expect(res404).toMatchObject({ ok: false, status: 404 });
    const boom = vi.fn(async () => { throw new Error("socket hang up"); });
    const resErr = await politeFetch("https://rival.example/", boom as unknown as typeof fetch);
    expect(resErr.ok).toBe(false);
    if (!resErr.ok) expect(resErr.error).toContain("socket hang up");
  });
});

describe("parseRobots / isPathAllowed", () => {
  it("applies wildcard disallow rules by prefix", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /cart\nDisallow: /admin/\n");
    expect(isPathAllowed(rules, "/products/boots")).toBe(true);
    expect(isPathAllowed(rules, "/cart")).toBe(false);
    expect(isPathAllowed(rules, "/admin/settings")).toBe(false);
  });
  it("prefers a CalderynRadar-specific group over the wildcard", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: CalderynRadar\nDisallow: /private\n");
    expect(isPathAllowed(rules, "/products/boots")).toBe(true);
    expect(isPathAllowed(rules, "/private/notes")).toBe(false);
  });
  it("treats an empty Disallow as allow-all and ignores comments", () => {
    const rules = parseRobots("# hi\nUser-agent: *\nDisallow:\n");
    expect(isPathAllowed(rules, "/anything")).toBe(true);
  });
});

describe("loadRobots", () => {
  it("parses a 200 robots.txt fetched with the honest UA", async () => {
    const impl = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("https://rival.example/robots.txt");
      return htmlResponse("User-agent: *\nDisallow: /cart\n");
    });
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    expect(isPathAllowed(rules, "/cart")).toBe(false);
    expect(isPathAllowed(rules, "/")).toBe(true);
  });
  it("allows all on 404 (no robots file means no restrictions)", async () => {
    const impl = vi.fn(async () => new Response("nf", { status: 404 }));
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    expect(isPathAllowed(rules, "/anything")).toBe(true);
  });
  it("disallows all for the night on 5xx or network failure (conservative)", async () => {
    const impl = vi.fn(async () => new Response("boom", { status: 503 }));
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    expect(isPathAllowed(rules, "/")).toBe(false);
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const rules2 = await loadRobots("https://rival.example", down as unknown as typeof fetch);
    expect(isPathAllowed(rules2, "/")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/fetch.server.test.ts`
Expected: FAIL - `Cannot find module '../fetch.server'`.

- [ ] **Step 3: Write `fetch.server.ts`**

```ts
// app/lib/radar/fetch.server.ts
// Polite HTTP for competitor snapshots: honest UA, hard 5s timeout, ~1MB cap
// (content-length check AND a streaming reader loop), and a deliberately
// conservative robots.txt matcher (Disallow-only; ignoring Allow lines can
// only make us fetch LESS). fetchImpl is injectable so tests never hit the
// network.

export const RADAR_USER_AGENT = "CalderynRadar/1.0 (+https://calderyncompany.com)";
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 1_000_000;

export type PoliteFetchResult =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; error: string };

export async function politeFetch(url: string, fetchImpl: typeof fetch = fetch): Promise<PoliteFetchResult> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        "user-agent": RADAR_USER_AGENT,
        accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) {
      return { ok: false, status: res.status, error: `response too large (${declared} bytes declared)` };
    }
    const text = await readCapped(res);
    if (text === null) {
      return { ok: false, status: res.status, error: `response too large (exceeded ${MAX_RESPONSE_BYTES} bytes)` };
    }
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read at most MAX_RESPONSE_BYTES; null when the body exceeds the cap. */
async function readCapped(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    return text.length > MAX_RESPONSE_BYTES ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export interface RobotsRules {
  /** Disallow path prefixes that apply to CalderynRadar. */
  disallow: string[];
  /** True when robots.txt could not be read (5xx/network): skip the host tonight. */
  unreachable: boolean;
}

/** Disallow-only parser: a group naming calderynradar wins over the `*` group. */
export function parseRobots(text: string): RobotsRules {
  const groups: Array<{ agents: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let inAgentRun = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "user-agent") {
      if (!current || !inAgentRun) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      inAgentRun = true;
      current.agents.push(value.toLowerCase());
    } else {
      inAgentRun = false;
      if (current && field === "disallow" && value) current.disallow.push(value);
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a.includes("calderynradar")));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = specific.length > 0 ? specific : wildcard;
  return { disallow: chosen.flatMap((g) => g.disallow), unreachable: false };
}

export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  if (rules.unreachable) return false;
  return !rules.disallow.some((prefix) => path.startsWith(prefix));
}

/** 2xx -> parse; 4xx -> allow-all; 5xx/network/timeout -> disallow-all tonight. */
export async function loadRobots(origin: string, fetchImpl: typeof fetch = fetch): Promise<RobotsRules> {
  const res = await politeFetch(`${origin.replace(/\/+$/, "")}/robots.txt`, fetchImpl);
  if (res.ok) return parseRobots(res.text);
  if (res.status !== undefined && res.status >= 400 && res.status < 500) {
    return { disallow: [], unreachable: false };
  }
  return { disallow: [], unreachable: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/fetch.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/fetch.server.ts app/lib/radar/__tests__/fetch.server.test.ts
git commit -m "radar/fetch: polite fetcher with robots.txt matcher, honest UA, timeout and size caps"
```

---

### Task 3: Types + competitor store (`app/lib/radar/competitor-store.server.ts`)

**Files:**
- Modify: `app/lib/radar/types.ts` (competitor types + `RadarCollectInputs.competitorDiffs` + 2 new kinds)
- Modify: `app/lib/radar/store.server.ts` (`lastDiscoveredAt` on `RadarState`/`stampRadarState`)
- Create: `app/lib/radar/competitor-store.server.ts`
- Test: `app/lib/radar/__tests__/competitor-store.test.ts`
- Modify (compile fixes): `app/lib/radar/__tests__/detect.signals.test.ts`, `app/lib/radar/__tests__/collect.server.test.ts`, `app/lib/radar/__tests__/draft.server.test.ts` - any fixture building a `RadarCollectInputs` gains `competitorDiffs: []`.

**Interfaces:**
- `types.ts` additions: `RadarMoveKind` gains `"competitor_counter" | "competitor_price"`; new `RadarCompetitorStatus`, `RadarCompetitorRow`, `CompetitorExtract`, `CompetitorDiff`, `CompetitorDiffInput`; `RadarCollectInputs` gains `competitorDiffs: CompetitorDiffInput[]`.
- `competitor-store.server.ts`: `MAX_WATCHED_COMPETITORS`, `listCompetitors`, `countCompetitors`, `insertSuggestion`, `setCompetitorStatus`, `latestSnapshots`, `insertSnapshot`, `listRecentDiffs`, `listSnapshotTimeline` (+ `SnapshotBaseline`, `SnapshotTimelineRow`).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/competitor-store.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: mocks.from }) }));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import {
  insertSnapshot,
  insertSuggestion,
  latestSnapshots,
  listRecentDiffs,
  MAX_WATCHED_COMPETITORS,
  setCompetitorStatus,
} from "../competitor-store.server";

const SHOP = "11111111-1111-4111-8111-111111111111";
const COMP = "22222222-2222-4222-8222-222222222222";

/** Chainable supabase-query stub: every builder method returns itself and the
 *  chain is thenable, resolving the provided result. */
function chain(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const target: Record<string, unknown> = {};
  const self = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) =>
          resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
      }
      return (..._args: unknown[]) => self;
    },
  });
  return self as never;
}

beforeEach(() => vi.clearAllMocks());

describe("insertSuggestion", () => {
  it("inserts a suggested row and reports 23505 as duplicate", async () => {
    mocks.from.mockReturnValueOnce(chain({}));
    const first = await insertSuggestion(SHOP, {
      url: "https://rival.example/", name: "Rival", evidence: { reason: "similar boots" },
    });
    expect(first).toBe("inserted");
    mocks.from.mockReturnValueOnce(chain({ error: { code: "23505", message: "dup" } }));
    const second = await insertSuggestion(SHOP, {
      url: "https://rival.example/", name: "Rival", evidence: {},
    });
    expect(second).toBe("duplicate");
  });
  it("refuses fixture (non-uuid) shops", async () => {
    await expect(insertSuggestion("demo-shop", { url: "https://x/", name: "", evidence: {} }))
      .rejects.toThrow(/uuid/);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("setCompetitorStatus", () => {
  it("enforces the 5-watched cap before flipping to watching", async () => {
    mocks.from.mockReturnValueOnce(chain({ count: MAX_WATCHED_COMPETITORS })); // count query
    const res = await setCompetitorStatus(SHOP, COMP, "watching");
    expect(res).toBe("limit_reached");
    expect(MAX_WATCHED_COMPETITORS).toBe(5);
  });
  it("updates below the cap and reports not_found for a missing row", async () => {
    mocks.from
      .mockReturnValueOnce(chain({ count: 1 }))              // count
      .mockReturnValueOnce(chain({ data: [{ id: COMP }] })); // update ... select
    expect(await setCompetitorStatus(SHOP, COMP, "watching")).toBe("updated");
    mocks.from.mockReturnValueOnce(chain({ data: [] }));     // dismiss: no count query
    expect(await setCompetitorStatus(SHOP, COMP, "dismissed")).toBe("not_found");
  });
});

describe("snapshots", () => {
  it("latestSnapshots keeps the newest row per url", async () => {
    mocks.from.mockReturnValueOnce(chain({
      data: [
        { url: "https://rival.example/", content_hash: "new", extracted: { title: "B" } },
        { url: "https://rival.example/", content_hash: "old", extracted: { title: "A" } },
      ],
    }));
    const map = await latestSnapshots(SHOP, COMP);
    expect(map.get("https://rival.example/")).toMatchObject({ contentHash: "new" });
  });
  it("insertSnapshot upserts on the (competitor, url, day) natural key", async () => {
    const upsert = vi.fn(() => chain({}));
    mocks.from.mockReturnValueOnce({ upsert } as never);
    await insertSnapshot(SHOP, {
      competitorId: COMP, url: "https://rival.example/", contentHash: "h",
      extracted: { title: "", metaDescription: "", headings: [], prices: [] }, diff: null,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: SHOP, competitor_id: COMP, content_hash: "h" }),
      { onConflict: "competitor_id,url,captured_day" },
    );
  });
  it("listRecentDiffs joins watching competitor names onto diff rows", async () => {
    mocks.from
      .mockReturnValueOnce(chain({ data: [{ id: COMP, name: "Rival", url: "https://rival.example/", status: "watching", shop_id: SHOP, discovery_evidence: {}, created_at: "", updated_at: "" }] }))
      .mockReturnValueOnce(chain({
        data: [{ competitor_id: COMP, url: "https://rival.example/", captured_at: "2026-07-20T02:00:00Z",
          diff: { titleChanged: null, newHeadings: ["Summer sale"], removedHeadings: [], newPrices: [], removedPrices: [] } }],
      }));
    const rows = await listRecentDiffs(SHOP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ competitorId: COMP, competitorName: "Rival" });
    expect(rows[0].diff.newHeadings).toEqual(["Summer sale"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/competitor-store.test.ts`
Expected: FAIL - `Cannot find module '../competitor-store.server'`.

- [ ] **Step 3: Extend `types.ts`**

Add `"competitor_counter" | "competitor_price"` to `RadarMoveKind`, then append:

```ts
// ── Phase D: competitors ─────────────────────────────────────────────────────

export type RadarCompetitorStatus = "suggested" | "watching" | "dismissed";

export interface RadarCompetitorRow {
  id: string;
  shopId: string;
  url: string;
  name: string;
  status: RadarCompetitorStatus;
  discoveryEvidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Deterministic facts pulled from a competitor page (bounded; no Claude). */
export interface CompetitorExtract {
  title: string;
  metaDescription: string;
  headings: string[];
  prices: string[];
}

/** Deterministic delta vs the previous snapshot of the same url. */
export interface CompetitorDiff {
  titleChanged: { from: string; to: string } | null;
  newHeadings: string[];
  removedHeadings: string[];
  newPrices: string[];
  removedPrices: string[];
}

/** One changed page, joined with its competitor, as the detectors consume it. */
export interface CompetitorDiffInput {
  competitorId: string;
  competitorName: string;
  url: string;
  capturedAt: string;
  diff: CompetitorDiff;
}
```

And extend `RadarCollectInputs` (with the doc comment):

```ts
  /** Recent competitor page diffs (watching competitors only; bounded reads). */
  competitorDiffs: CompetitorDiffInput[];
```

In `store.server.ts`, extend `RadarState` with `lastDiscoveredAt: string | null`, `readRadarState`'s select with `last_discovered_at` (mapped the same way), and `stampRadarState`'s patch type + body with `lastDiscoveredAt` -> `last_discovered_at`.

- [ ] **Step 4: Write `competitor-store.server.ts`**

```ts
// app/lib/radar/competitor-store.server.ts
// Persistence for radar_competitor and radar_snapshot. Service-role client,
// shop_id threaded on every query; snake_case never escapes this module.
// The unique (shop_id, url) index is the dedup backstop for discovery
// (23505 -> "duplicate"), and the (competitor_id, url, captured_day) index
// makes nightly snapshot writes idempotent.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import type {
  CompetitorDiff,
  CompetitorDiffInput,
  CompetitorExtract,
  RadarCompetitorRow,
  RadarCompetitorStatus,
} from "./types";

export const MAX_WATCHED_COMPETITORS = 5;

const DAY_MS = 86_400_000;
const COMPETITOR_COLUMNS = "id, shop_id, url, name, status, discovery_evidence, created_at, updated_at";

function mapCompetitor(r: Record<string, unknown>): RadarCompetitorRow {
  return {
    id: String(r.id),
    shopId: String(r.shop_id),
    url: String(r.url),
    name: String(r.name ?? ""),
    status: r.status as RadarCompetitorStatus,
    discoveryEvidence: (r.discovery_evidence ?? {}) as Record<string, unknown>,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listCompetitors(
  shopId: string,
  statuses: RadarCompetitorStatus[],
  limit = 50,
): Promise<RadarCompetitorRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_competitor")
    .select(COMPETITOR_COLUMNS)
    .eq("shop_id", shopId)
    .in("status", statuses)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listCompetitors: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(mapCompetitor);
}

export async function countCompetitors(shopId: string, status: RadarCompetitorStatus): Promise<number> {
  if (!isUuid(shopId)) return 0;
  const { count, error } = await getSupabase()
    .from("radar_competitor")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("status", status);
  if (error) throw new Error(`countCompetitors: ${error.message}`);
  return count ?? 0;
}

export async function insertSuggestion(
  shopId: string,
  s: { url: string; name: string; evidence: Record<string, unknown> },
): Promise<"inserted" | "duplicate"> {
  if (!isUuid(shopId)) throw new Error(`insertSuggestion requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("radar_competitor").insert({
    shop_id: shopId,
    url: s.url,
    name: s.name,
    status: "suggested",
    discovery_evidence: s.evidence,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw new Error(`insertSuggestion: ${error.message}`);
  }
  return "inserted";
}

/** Count-then-update has a benign race (two concurrent confirms could briefly
 *  reach 6 watched) - acceptable for a single-merchant dashboard action. */
export async function setCompetitorStatus(
  shopId: string,
  competitorId: string,
  status: RadarCompetitorStatus,
): Promise<"updated" | "not_found" | "limit_reached"> {
  if (!isUuid(shopId) || !isUuid(competitorId)) return "not_found";
  if (status === "watching") {
    const watching = await countCompetitors(shopId, "watching");
    if (watching >= MAX_WATCHED_COMPETITORS) return "limit_reached";
  }
  const { data, error } = await getSupabase()
    .from("radar_competitor")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", competitorId)
    .select("id");
  if (error) throw new Error(`setCompetitorStatus: ${error.message}`);
  return (data ?? []).length > 0 ? "updated" : "not_found";
}

export interface SnapshotBaseline {
  contentHash: string;
  extracted: CompetitorExtract;
}

/** Newest stored snapshot per url for one competitor (the hash gate's input). */
export async function latestSnapshots(shopId: string, competitorId: string): Promise<Map<string, SnapshotBaseline>> {
  if (!isUuid(shopId) || !isUuid(competitorId)) return new Map();
  const { data, error } = await getSupabase()
    .from("radar_snapshot")
    .select("url, content_hash, extracted")
    .eq("shop_id", shopId)
    .eq("competitor_id", competitorId)
    .order("captured_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`latestSnapshots: ${error.message}`);
  const map = new Map<string, SnapshotBaseline>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const url = String(r.url);
    if (map.has(url)) continue; // newest-first: first row per url wins
    map.set(url, {
      contentHash: String(r.content_hash),
      extracted: (r.extracted ?? { title: "", metaDescription: "", headings: [], prices: [] }) as CompetitorExtract,
    });
  }
  return map;
}

export async function insertSnapshot(
  shopId: string,
  snap: { competitorId: string; url: string; contentHash: string; extracted: CompetitorExtract; diff: CompetitorDiff | null },
): Promise<void> {
  if (!isUuid(shopId)) return;
  const { error } = await getSupabase().from("radar_snapshot").upsert(
    {
      shop_id: shopId,
      competitor_id: snap.competitorId,
      url: snap.url,
      captured_at: new Date().toISOString(),
      content_hash: snap.contentHash,
      extracted: snap.extracted,
      diff: snap.diff,
    },
    { onConflict: "competitor_id,url,captured_day" },
  );
  if (error) throw new Error(`insertSnapshot: ${error.message}`);
}

function mapDiff(r: Record<string, unknown>, names: Map<string, string>): CompetitorDiffInput {
  return {
    competitorId: String(r.competitor_id),
    competitorName: names.get(String(r.competitor_id)) ?? "A competitor",
    url: String(r.url),
    capturedAt: String(r.captured_at),
    diff: r.diff as CompetitorDiff,
  };
}

/** Recent changed-page rows for WATCHING competitors, joined with names in
 *  code (two bounded queries; no PostgREST embedded joins). */
export async function listRecentDiffs(shopId: string, sinceDays = 7, limit = 100): Promise<CompetitorDiffInput[]> {
  if (!isUuid(shopId)) return [];
  const watching = await listCompetitors(shopId, ["watching"], MAX_WATCHED_COMPETITORS);
  if (watching.length === 0) return [];
  const names = new Map(watching.map((c) => [c.id, c.name || new URL(c.url).hostname]));
  const { data, error } = await getSupabase()
    .from("radar_snapshot")
    .select("competitor_id, url, captured_at, diff")
    .eq("shop_id", shopId)
    .in("competitor_id", watching.map((c) => c.id))
    .not("diff", "is", null)
    .gte("captured_at", new Date(Date.now() - sinceDays * DAY_MS).toISOString())
    .order("captured_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentDiffs: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => mapDiff(r, names));
}

export interface SnapshotTimelineRow {
  competitorId: string;
  url: string;
  capturedAt: string;
  diff: CompetitorDiff;
}

/** Change timeline for the Competitors tab (30-day window, bounded). */
export async function listSnapshotTimeline(shopId: string, limit = 50): Promise<SnapshotTimelineRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_snapshot")
    .select("competitor_id, url, captured_at, diff")
    .eq("shop_id", shopId)
    .not("diff", "is", null)
    .gte("captured_at", new Date(Date.now() - 30 * DAY_MS).toISOString())
    .order("captured_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSnapshotTimeline: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    competitorId: String(r.competitor_id),
    url: String(r.url),
    capturedAt: String(r.captured_at),
    diff: r.diff as CompetitorDiff,
  }));
}
```

- [ ] **Step 5: Run tests + fix fixture compiles**

Run: `npx vitest run app/lib/radar/__tests__/competitor-store.test.ts` - expected PASS.
Then `npx vitest run app/lib/radar` and `npm run typecheck`: every existing fixture constructing a `RadarCollectInputs` (in `detect.signals.test.ts`, `collect.server.test.ts`, `draft.server.test.ts`, and the non-uuid early return inside `loadRadarInputs` in `collect.server.ts`) gains `competitorDiffs: []`. (The real `loadRadarInputs` read is wired in Task 5.)
Expected: all radar suites PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/radar/types.ts app/lib/radar/store.server.ts app/lib/radar/collect.server.ts app/lib/radar/competitor-store.server.ts app/lib/radar/__tests__/competitor-store.test.ts app/lib/radar/__tests__/detect.signals.test.ts app/lib/radar/__tests__/collect.server.test.ts app/lib/radar/__tests__/draft.server.test.ts
git commit -m "radar/competitors: competitor + snapshot persistence, types, watch-limit enforcement"
```

---

### Task 4: Snapshot engine - hash, extract, diff, orchestrate (`app/lib/radar/snapshot.server.ts`)

**Files:**
- Create: `app/lib/radar/snapshot.server.ts`
- Test: `app/lib/radar/__tests__/snapshot.server.test.ts`

**Interfaces:**
- Consumes: `fetch.server.ts` (Task 2), `competitor-store.server.ts` (Task 3).
- Produces (used by Task 7): `MAX_PAGES_PER_COMPETITOR`, `SNAPSHOT_FETCH_BUDGET`, `normalizeText(html)`, `contentHash(text)`, `extractFacts(html)`, `discoverPageUrls(homeHtml, origin)`, `diffExtracts(prev, next)`, `snapshotWatchingCompetitors(shopId, opts)`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/snapshot.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCompetitors: vi.fn(),
  latestSnapshots: vi.fn(),
  insertSnapshot: vi.fn(),
  loadRobots: vi.fn(),
  politeFetch: vi.fn(),
}));
vi.mock("../competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCompetitors: mocks.listCompetitors,
  latestSnapshots: mocks.latestSnapshots,
  insertSnapshot: mocks.insertSnapshot,
}));
vi.mock("../fetch.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadRobots: mocks.loadRobots,
  politeFetch: mocks.politeFetch,
}));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import {
  contentHash,
  diffExtracts,
  discoverPageUrls,
  extractFacts,
  MAX_PAGES_PER_COMPETITOR,
  normalizeText,
  snapshotWatchingCompetitors,
} from "../snapshot.server";

const SHOP = "11111111-1111-4111-8111-111111111111";
const COMP = {
  id: "22222222-2222-4222-8222-222222222222",
  shopId: SHOP,
  url: "https://rival.example/",
  name: "Rival",
  status: "watching" as const,
  discoveryEvidence: {},
  createdAt: "",
  updatedAt: "",
};

const HOME = `<html><head><title>Rival Gear</title>
<meta name="description" content="Boots and packs"></head>
<body><script>evil()</script><h1>Built for the trail</h1>
<a href="/products/boots">Boots $129.00</a>
<a href="/collections/packs">Packs</a>
<a href="https://elsewhere.example/x">off-site</a>
<a href="/cart">Cart</a></body></html>`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCompetitors.mockResolvedValue([COMP]);
  mocks.latestSnapshots.mockResolvedValue(new Map());
  mocks.insertSnapshot.mockResolvedValue(undefined);
  mocks.loadRobots.mockResolvedValue({ disallow: [], unreachable: false });
  mocks.politeFetch.mockResolvedValue({ ok: true, status: 200, text: HOME });
});

describe("normalizeText / contentHash", () => {
  it("is stable across whitespace and strips script/style", () => {
    const a = normalizeText("<p>Hello   <b>world</b></p><script>x()</script>");
    const b = normalizeText("<p>Hello world</p>");
    expect(a).toBe(b);
    expect(a).not.toContain("x()");
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractFacts", () => {
  it("pulls title, meta description, headings and prices deterministically", () => {
    const facts = extractFacts(HOME);
    expect(facts.title).toBe("Rival Gear");
    expect(facts.metaDescription).toBe("Boots and packs");
    expect(facts.headings).toContain("Built for the trail");
    expect(facts.prices).toContain("$129.00");
  });
  it("bounds every list", () => {
    const many = `<html><body>${Array.from({ length: 60 }, (_, i) => `<h2>H${i}</h2><span>$${i}.99</span>`).join("")}</body></html>`;
    const facts = extractFacts(many);
    expect(facts.headings.length).toBeLessThanOrEqual(20);
    expect(facts.prices.length).toBeLessThanOrEqual(20);
  });
});

describe("discoverPageUrls", () => {
  it("keeps same-host product/collection links, home first, capped at 10", () => {
    const urls = discoverPageUrls(HOME, "https://rival.example");
    expect(urls[0]).toBe("https://rival.example/");
    expect(urls).toContain("https://rival.example/products/boots");
    expect(urls).toContain("https://rival.example/collections/packs");
    expect(urls.every((u) => u.startsWith("https://rival.example/"))).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(MAX_PAGES_PER_COMPETITOR);
    expect(MAX_PAGES_PER_COMPETITOR).toBe(10);
  });
});

describe("diffExtracts", () => {
  const base = { title: "Rival Gear", metaDescription: "d", headings: ["Built for the trail"], prices: ["$129.00"] };
  it("returns null when nothing changed", () => {
    expect(diffExtracts(base, { ...base })).toBeNull();
  });
  it("reports title, heading and price deltas", () => {
    const next = { title: "Rival Gear - Summer Sale", metaDescription: "d", headings: ["Summer sale"], prices: ["$99.00"] };
    const diff = diffExtracts(base, next);
    expect(diff).toMatchObject({
      titleChanged: { from: "Rival Gear", to: "Rival Gear - Summer Sale" },
      newHeadings: ["Summer sale"],
      removedHeadings: ["Built for the trail"],
      newPrices: ["$99.00"],
      removedPrices: ["$129.00"],
    });
  });
});

describe("snapshotWatchingCompetitors", () => {
  const deadline = () => Date.now() + 60_000;
  it("writes baselines (diff null) for first-seen pages", async () => {
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(out.pagesStored).toBeGreaterThan(0);
    for (const call of mocks.insertSnapshot.mock.calls) {
      expect(call[1].diff).toBeNull();
    }
  });
  it("skips unchanged pages entirely (hash gate) and diffs changed ones", async () => {
    const homeNorm = normalizeText(HOME);
    mocks.latestSnapshots.mockResolvedValue(new Map([
      ["https://rival.example/", { contentHash: contentHash(homeNorm), extracted: extractFacts(HOME) }],
    ]));
    // Non-home pages return changed content
    mocks.politeFetch.mockImplementation(async (url: string) =>
      url === "https://rival.example/" || url.endsWith("robots.txt")
        ? { ok: true, status: 200, text: HOME }
        : { ok: true, status: 200, text: "<html><title>New</title><h1>Fresh</h1></html>" });
    await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    const urls = mocks.insertSnapshot.mock.calls.map((c) => c[1].url);
    expect(urls).not.toContain("https://rival.example/"); // unchanged: zero rows
  });
  it("respects robots disallow for individual paths", async () => {
    mocks.loadRobots.mockResolvedValue({ disallow: ["/products"], unreachable: false });
    await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    const fetched = mocks.politeFetch.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes("/products/"))).toBe(false);
  });
  it("skips the whole host when robots is unreachable and isolates competitor failures", async () => {
    mocks.loadRobots.mockResolvedValue({ disallow: [], unreachable: true });
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(out.pagesFetched).toBe(0);
    mocks.loadRobots.mockRejectedValue(new Error("boom"));
    await expect(snapshotWatchingCompetitors(SHOP, { deadline: deadline() })).resolves.toBeTruthy();
  });
  it("stops at the deadline without throwing", async () => {
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: Date.now() - 1 });
    expect(out.pagesFetched).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/snapshot.server.test.ts`
Expected: FAIL - `Cannot find module '../snapshot.server'`.

- [ ] **Step 3: Write `snapshot.server.ts`**

```ts
// app/lib/radar/snapshot.server.ts
// Nightly competitor snapshots. Deterministic end to end: normalize -> sha256
// -> bounded regex extraction -> diff vs previous snapshot. The hash gate
// means an unchanged page writes NO row and costs zero Claude; a changed page
// still costs zero Claude here (the drafter's quota-gated polish is the only
// model touch competitor moves ever get). Politeness lives in fetch.server.ts;
// this module adds the page/fetch budgets and the cron deadline.
import { createHash } from "node:crypto";
import {
  insertSnapshot,
  latestSnapshots,
  listCompetitors,
  MAX_WATCHED_COMPETITORS,
} from "./competitor-store.server";
import { isPathAllowed, loadRobots, politeFetch } from "./fetch.server";
import type { CompetitorDiff, CompetitorExtract } from "./types";

export const MAX_PAGES_PER_COMPETITOR = 10;
/** Hard cap on outbound requests per shop per night (robots + pages, all
 *  competitors). Keeps a worst-case night inside the cron's 50s budget. */
export const SNAPSHOT_FETCH_BUDGET = 30;

const MAX_TEXT_CHARS = 500_000;
const MAX_LIST = 20;
const MAX_ITEM_CHARS = 160;

export function normalizeText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export function contentHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function stripTags(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
}

export function extractFacts(html: string): CompetitorExtract {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const metaDescription =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]?.trim().slice(0, MAX_ITEM_CHARS)
    ?? "";
  const headings: string[] = [];
  const headingRe = /<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi;
  for (let m = headingRe.exec(html); m && headings.length < MAX_LIST; m = headingRe.exec(html)) {
    const text = stripTags(m[1]);
    if (text) headings.push(text);
  }
  const prices: string[] = [];
  const priceRe = /[$£€]\s?\d[\d,]*(?:\.\d{2})?/g;
  const normalized = normalizeText(html);
  for (let m = priceRe.exec(normalized); m && prices.length < MAX_LIST; m = priceRe.exec(normalized)) {
    const price = m[0].replace(/\s+/g, "");
    if (!prices.includes(price)) prices.push(price);
  }
  return { title, metaDescription, headings, prices };
}

/** Home first, then same-host store-shaped links (products/collections/shop/
 *  pages), capped. Anything else (cart, checkout, off-site) is ignored. */
export function discoverPageUrls(homeHtml: string, origin: string): string[] {
  const base = new URL(origin);
  const home = `${base.origin}/`;
  const interesting = /^\/(products?|collections?|shop|pages?|catalog)\//i;
  const urls: string[] = [home];
  const hrefRe = /href=["']([^"'#]+)["']/gi;
  for (let m = hrefRe.exec(homeHtml); m && urls.length < MAX_PAGES_PER_COMPETITOR; m = hrefRe.exec(homeHtml)) {
    let resolved: URL;
    try {
      resolved = new URL(m[1], base);
    } catch {
      continue;
    }
    if (resolved.host !== base.host) continue;
    if (!interesting.test(resolved.pathname)) continue;
    const clean = `${resolved.origin}${resolved.pathname}`;
    if (!urls.includes(clean)) urls.push(clean);
  }
  return urls;
}

function delta(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  return {
    added: next.filter((x) => !prev.includes(x)),
    removed: prev.filter((x) => !next.includes(x)),
  };
}

/** Null when the extracts are equivalent (belt-and-braces behind the hash gate). */
export function diffExtracts(prev: CompetitorExtract, next: CompetitorExtract): CompetitorDiff | null {
  const headings = delta(prev.headings, next.headings);
  const prices = delta(prev.prices, next.prices);
  const titleChanged = prev.title !== next.title ? { from: prev.title, to: next.title } : null;
  if (!titleChanged && headings.added.length === 0 && headings.removed.length === 0
    && prices.added.length === 0 && prices.removed.length === 0) {
    return null;
  }
  return {
    titleChanged,
    newHeadings: headings.added,
    removedHeadings: headings.removed,
    newPrices: prices.added,
    removedPrices: prices.removed,
  };
}

export interface SnapshotSummary {
  pagesFetched: number;
  pagesStored: number;
  failed: number;
}

/** Snapshot every watching competitor for one shop, inside the caller's
 *  deadline and the per-shop fetch budget. Per-competitor failures log and
 *  move on; a budget stop is not an error (next night resumes - competitors
 *  are processed stalest-first via listCompetitors' updated_at ordering). */
export async function snapshotWatchingCompetitors(
  shopId: string,
  opts: { deadline: number; fetchImpl?: typeof fetch },
): Promise<SnapshotSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const summary: SnapshotSummary = { pagesFetched: 0, pagesStored: 0, failed: 0 };
  const watching = await listCompetitors(shopId, ["watching"], MAX_WATCHED_COMPETITORS);
  let budget = SNAPSHOT_FETCH_BUDGET;

  for (const competitor of watching) {
    if (Date.now() >= opts.deadline || budget <= 0) break;
    try {
      const origin = new URL(competitor.url).origin;
      budget--;
      const robots = await loadRobots(origin, fetchImpl);
      if (robots.unreachable) {
        console.error(`[radar] robots.txt unreachable for ${origin}; skipping host tonight`);
        continue;
      }
      if (Date.now() >= opts.deadline || budget <= 0) break;
      if (!isPathAllowed(robots, "/")) continue;
      budget--;
      const home = await politeFetch(`${origin}/`, fetchImpl);
      summary.pagesFetched++;
      if (!home.ok) {
        summary.failed++;
        console.error(`[radar] snapshot fetch failed for ${origin}/: ${home.error}`);
        continue;
      }
      const pages = discoverPageUrls(home.text, origin);
      const baselines = await latestSnapshots(shopId, competitor.id);

      for (const pageUrl of pages) {
        if (Date.now() >= opts.deadline || budget < 0) break;
        const path = new URL(pageUrl).pathname;
        if (!isPathAllowed(robots, path)) continue;
        let html: string;
        if (pageUrl === `${origin}/`) {
          html = home.text; // already fetched
        } else {
          if (budget <= 0) break;
          budget--;
          const res = await politeFetch(pageUrl, fetchImpl);
          summary.pagesFetched++;
          if (!res.ok) {
            summary.failed++;
            console.error(`[radar] snapshot fetch failed for ${pageUrl}: ${res.error}`);
            continue;
          }
          html = res.text;
        }
        const hash = contentHash(normalizeText(html));
        const prev = baselines.get(pageUrl);
        if (prev && prev.contentHash === hash) continue; // unchanged: zero rows, zero Claude
        const extracted = extractFacts(html);
        const diff = prev ? diffExtracts(prev.extracted, extracted) : null; // first sight = baseline
        await insertSnapshot(shopId, { competitorId: competitor.id, url: pageUrl, contentHash: hash, extracted, diff });
        summary.pagesStored++;
      }
    } catch (err) {
      summary.failed++;
      console.error(`[radar] snapshot failed for competitor ${competitor.id} (${competitor.url})`, err);
    }
  }
  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/snapshot.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/radar/snapshot.server.ts app/lib/radar/__tests__/snapshot.server.test.ts
git commit -m "radar/snapshot: hash-gated competitor page snapshots with deterministic extract + diff"
```

---

### Task 5: Discovery via Claude web_search (`app/lib/radar/discovery.server.ts`)

**Files:**
- Modify: `app/lib/ai-quota.server.ts` (add `"radar_discovery"`)
- Modify: `app/lib/assistant/anthropic.server.ts` (add `radarDiscoveryModel()`)
- Create: `app/lib/radar/discovery.server.ts`
- Test: `app/lib/radar/__tests__/discovery.server.test.ts`

**Interfaces:**
- Produces (used by Task 7's discover cron): `discoverShopCompetitors(shopId)` -> `{ suggested: number } | { skipped: string }`; constants `DISCOVERY_MAX_SEARCHES`, `DISCOVERY_MAX_SUGGESTIONS`.

- [ ] **Step 1: Add the quota bucket and model picker**

In `app/lib/ai-quota.server.ts`, extend the union:

```ts
export type AiFeature = "designer" | "assistant" | "listing" | "radar" | "radar_apply" | "radar_discovery";
```

and add to `QUOTAS` (after `radar_apply`):

```ts
  // Weekly competitor auto-discovery (one web_search-equipped Claude call per
  // shop per run). Cadence is weekly, so the daily cap of 2 is belt-and-braces
  // against a misfiring/looping cron - and a SEPARATE bucket from `radar` so a
  // discovery run can never eat the nightly drafter's 5-call polish budget.
  radar_discovery: { cooldownMs: 0, daily: { base: 2, trusted: 2 } },
```

In `app/lib/assistant/anthropic.server.ts`, after `radarDraftModel()`:

```ts
/** Model for Radar's weekly competitor discovery: a single web_search-equipped
 *  call that must return strict JSON, so the digest-class model is the right
 *  default (and the reason the tool type is the basic web_search_20250305 -
 *  the newer 20260209 variant needs Opus/Sonnet 4.6+). Override with
 *  RADAR_DISCOVERY_MODEL. */
export function radarDiscoveryModel(): string {
  return process.env.RADAR_DISCOVERY_MODEL || DEFAULT_DIGEST_MODEL;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// app/lib/radar/__tests__/discovery.server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  checkAiQuota: vi.fn(),
  isShowcaseShop: vi.fn(),
  countCompetitors: vi.fn(),
  insertSuggestion: vi.fn(),
  stampRadarState: vi.fn(),
  getStoreSettings: vi.fn(),
  getSeoSettings: vi.fn(),
  listProducts: vi.fn(),
  getShopStorefrontOrigin: vi.fn(),
}));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: mocks.messagesCreate } }),
  radarDiscoveryModel: () => "test-model",
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.checkAiQuota }));
vi.mock("~/lib/demo/showcase.server", () => ({ isShowcaseShop: mocks.isShowcaseShop }));
vi.mock("../competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countCompetitors: mocks.countCompetitors,
  insertSuggestion: mocks.insertSuggestion,
}));
vi.mock("../store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampRadarState: mocks.stampRadarState,
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: mocks.getStoreSettings }));
vi.mock("~/lib/seo/seo-store.server", () => ({ getSeoSettings: mocks.getSeoSettings }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => ({ listProducts: mocks.listProducts }) }));
vi.mock("~/lib/storefront/shop.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShopStorefrontOrigin: mocks.getShopStorefrontOrigin,
}));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { DISCOVERY_MAX_SEARCHES, discoverShopCompetitors } from "../discovery.server";

const SHOP = "11111111-1111-4111-8111-111111111111";

function textResponse(text: string, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isShowcaseShop.mockResolvedValue(false);
  mocks.checkAiQuota.mockResolvedValue({ allowed: true });
  mocks.countCompetitors.mockResolvedValue(0);
  mocks.insertSuggestion.mockResolvedValue("inserted");
  mocks.stampRadarState.mockResolvedValue(undefined);
  mocks.getStoreSettings.mockResolvedValue({ storeName: "Peak & Pine", voiceTagline: null });
  mocks.getSeoSettings.mockResolvedValue({ orgDescription: "Outdoor gear for weekend hikers" });
  mocks.listProducts.mockResolvedValue([{ title: "Trail Boots" }, { title: "Summit Pack" }]);
  mocks.getShopStorefrontOrigin.mockResolvedValue("https://peak.calderyncompany.com");
  mocks.messagesCreate.mockResolvedValue(textResponse(JSON.stringify([
    { url: "https://rivalgear.example/collections/all", name: "Rival Gear", reason: "Sells hiking boots and packs" },
    { url: "https://peak.calderyncompany.com/", name: "Self", reason: "own store" },
    { url: "https://www.amazon.com/s?k=boots", name: "Amazon", reason: "marketplace" },
    { url: "not-a-url", name: "junk", reason: "" },
  ])));
});

describe("discoverShopCompetitors", () => {
  it("declares the web_search_20250305 server tool with max_uses and checks quota FIRST", async () => {
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    const req = mocks.messagesCreate.mock.calls[0][0];
    expect(req.model).toBe("test-model");
    expect(req.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: DISCOVERY_MAX_SEARCHES },
    ]);
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar_discovery", trusted: true });
    expect(mocks.checkAiQuota.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.messagesCreate.mock.invocationCallOrder[0]);
  });
  it("normalizes suggestions to the site origin, drops self + marketplaces + junk, writes suggested only", async () => {
    await discoverShopCompetitors(SHOP);
    expect(mocks.insertSuggestion).toHaveBeenCalledTimes(1);
    expect(mocks.insertSuggestion).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      url: "https://rivalgear.example/",
      name: "Rival Gear",
    }));
    expect(mocks.stampRadarState).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      lastDiscoveredAt: expect.any(String),
    }));
  });
  it("never runs for demo/fixture shops or when quota is exhausted", async () => {
    expect(await discoverShopCompetitors("demo-shop")).toEqual({ skipped: "fixture_shop" });
    mocks.isShowcaseShop.mockResolvedValue(true);
    expect(await discoverShopCompetitors(SHOP)).toEqual({ skipped: "demo_shop" });
    mocks.isShowcaseShop.mockResolvedValue(false);
    mocks.checkAiQuota.mockResolvedValue({ allowed: false, code: "ai_daily_limit", message: "cap" });
    expect(await discoverShopCompetitors(SHOP)).toEqual({ skipped: "ai_daily_limit" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it("skips when the suggestion backlog is already full", async () => {
    mocks.countCompetitors.mockImplementation(async (_shop: string, status: string) =>
      status === "suggested" ? 5 : 0);
    expect(await discoverShopCompetitors(SHOP)).toEqual({ skipped: "suggestion_backlog" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it("resumes pause_turn (fresh quota check per request) and survives junk JSON", async () => {
    mocks.messagesCreate
      .mockResolvedValueOnce({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] })
      .mockResolvedValueOnce(textResponse(JSON.stringify([
        { url: "https://rivalgear.example/", name: "Rival Gear", reason: "similar" },
      ])));
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    expect(mocks.messagesCreate).toHaveBeenCalledTimes(2);
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(2);

    mocks.messagesCreate.mockReset();
    mocks.messagesCreate.mockResolvedValue(textResponse("sorry, no JSON here"));
    expect(await discoverShopCompetitors(SHOP)).toEqual({ suggested: 0 });
    expect(mocks.insertSuggestion).toHaveBeenCalledTimes(1); // only the earlier run
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/discovery.server.test.ts`
Expected: FAIL - `Cannot find module '../discovery.server'`.

- [ ] **Step 4: Write `discovery.server.ts`**

```ts
// app/lib/radar/discovery.server.ts
// Weekly competitor auto-discovery - the repo's FIRST use of Claude's
// web_search server tool (basic web_search_20250305; the digest-class default
// model does not support the 20260209 variant). One quota-gated call per shop
// per run (max_uses caps searches inside it); suggestions are written with
// status 'suggested' ONLY - a merchant confirmation is the only path to
// 'watching'. Demo/fixture shops never reach the network or the model.
import type Anthropic from "@anthropic-ai/sdk";
import { checkAiQuota } from "~/lib/ai-quota.server";
import { getAnthropic, radarDiscoveryModel } from "~/lib/assistant/anthropic.server";
import { isShowcaseShop } from "~/lib/demo/showcase.server";
import { isUuid } from "~/lib/ids";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { countCompetitors, insertSuggestion, MAX_WATCHED_COMPETITORS } from "./competitor-store.server";
import { stampRadarState } from "./store.server";

export const DISCOVERY_MAX_SEARCHES = 3;
export const DISCOVERY_MAX_SUGGESTIONS = 5;
const MAX_PAUSE_RESUMES = 2;
const SEED_PRODUCTS = 5;

/** Marketplaces/socials/reference sites are never competitor suggestions. */
const BLOCKED_HOST_FRAGMENTS = [
  "amazon.", "ebay.", "etsy.", "walmart.", "aliexpress.", "temu.",
  "facebook.", "instagram.", "pinterest.", "youtube.", "reddit.", "wikipedia.",
];

const SYSTEM =
  "You research direct competitors for a small online store. Use web search to find up to " +
  `${DISCOVERY_MAX_SUGGESTIONS} independent ONLINE STORES that sell products similar to the store described. ` +
  "Only real, currently operating store websites. Exclude marketplaces (Amazon, eBay, Etsy, Walmart), " +
  "social networks, blogs, directories, review sites, and the store itself. " +
  'Respond with JSON only: [{"url":"https://...","name":"Store name","reason":"one plain sentence on why it competes"}]';

interface RawSuggestion {
  url?: unknown;
  name?: unknown;
  reason?: unknown;
}

function parseSuggestions(text: string): RawSuggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as RawSuggestion[]) : [];
  } catch {
    return [];
  }
}

function normalizeOrigin(raw: unknown, ownHost: string | null): { url: string; host: string } | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.host.toLowerCase();
  if (ownHost && host === ownHost) return null;
  if (BLOCKED_HOST_FRAGMENTS.some((frag) => host.includes(frag))) return null;
  return { url: `${u.protocol}//${u.host}/`, host };
}

export async function discoverShopCompetitors(
  shopId: string,
): Promise<{ suggested: number } | { skipped: string }> {
  if (!isUuid(shopId)) return { skipped: "fixture_shop" };
  if (await isShowcaseShop(shopId)) return { skipped: "demo_shop" };
  const [suggestedCount, watchingCount] = await Promise.all([
    countCompetitors(shopId, "suggested"),
    countCompetitors(shopId, "watching"),
  ]);
  if (suggestedCount >= DISCOVERY_MAX_SUGGESTIONS) return { skipped: "suggestion_backlog" };
  if (watchingCount >= MAX_WATCHED_COMPETITORS) return { skipped: "watch_list_full" };

  const [store, seo, products, origin] = await Promise.all([
    getStoreSettings(shopId),
    getSeoSettings(shopId),
    getCatalog().listProducts(shopId, { limit: SEED_PRODUCTS }),
    getShopStorefrontOrigin(shopId),
  ]);
  const ownHost = origin ? new URL(origin).host.toLowerCase() : null;
  const seeds = {
    storeName: store.storeName,
    description: seo.orgDescription ?? store.voiceTagline ?? "",
    topProducts: products.slice(0, SEED_PRODUCTS).map((p) => p.title),
    ownDomain: ownHost ?? "",
  };

  const tools: Anthropic.ToolUnion[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: DISCOVERY_MAX_SEARCHES },
  ];
  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Find competitors for this store:\n${JSON.stringify(seeds)}` },
  ];

  // Each request (initial + pause_turn resume) is a fresh quota hit - the
  // check records it, so it sits immediately before the spend.
  let res: Anthropic.Message | null = null;
  for (let attempt = 0; attempt <= MAX_PAUSE_RESUMES; attempt++) {
    const verdict = await checkAiQuota({ shopId, feature: "radar_discovery", trusted: true });
    if (!verdict.allowed) return res ? { suggested: 0 } : { skipped: verdict.code };
    res = await getAnthropic().messages.create({
      model: radarDiscoveryModel(),
      max_tokens: 1500,
      system: SYSTEM,
      messages,
      tools,
    });
    if (res.stop_reason !== "pause_turn") break;
    // Server-tool loop paused: append the assistant turn as-is and continue.
    messages = [...messages, { role: "assistant", content: res.content as Anthropic.MessageParam["content"] }];
  }
  if (!res) return { skipped: "no_response" };

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const raw = parseSuggestions(text);
  if (raw.length === 0) {
    console.error(`[radar] discovery returned no parseable suggestions for shop ${shopId}`, { text: text.slice(0, 500) });
  }

  const seenHosts = new Set<string>();
  let suggested = 0;
  for (const s of raw) {
    if (suggested >= DISCOVERY_MAX_SUGGESTIONS) break;
    const normalized = normalizeOrigin(s.url, ownHost);
    if (!normalized || seenHosts.has(normalized.host)) continue;
    seenHosts.add(normalized.host);
    const outcome = await insertSuggestion(shopId, {
      url: normalized.url,
      name: typeof s.name === "string" ? s.name.slice(0, 120) : normalized.host,
      evidence: {
        reason: typeof s.reason === "string" ? s.reason.slice(0, 300) : "",
        seeds,
        discoveredAt: new Date().toISOString(),
      },
    });
    if (outcome === "inserted") suggested++;
  }
  await stampRadarState(shopId, { lastDiscoveredAt: new Date().toISOString() });
  return { suggested };
}
```

TypeScript note: if `content: res.content as Anthropic.MessageParam["content"]` still fails `tsc` on 0.100.1 (response blocks vs param blocks), map the blocks through `Anthropic.ContentBlockParam[]` via a typed helper instead of widening to `any` - never `any`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/radar/__tests__/discovery.server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/ai-quota.server.ts app/lib/assistant/anthropic.server.ts app/lib/radar/discovery.server.ts app/lib/radar/__tests__/discovery.server.test.ts
git commit -m "radar/discovery: web_search competitor auto-discovery, quota-gated, suggestions only"
```

---

### Task 6: Competitor detectors + pipeline wiring (`app/lib/radar/detect-competitors.server.ts`)

**Files:**
- Create: `app/lib/radar/detect-competitors.server.ts`
- Modify: `app/lib/radar/detect.server.ts` (`detectAll` concatenates the new detectors)
- Modify: `app/lib/radar/collect.server.ts` (`loadRadarInputs` loads `competitorDiffs`)
- Test: `app/lib/radar/__tests__/detect.competitors.test.ts`

**Interfaces:**
- Consumes: `CompetitorDiffInput` (Task 3). Pure functions - no DB, no Claude, no clock.
- Produces: `detectCompetitorPriceMoves(diffs)`, `detectCompetitorShifts(diffs)`, `detectCompetitors(diffs)`; wired into `detectAll` so the Phase C drafter (cooldowns, dedup, polish, expiry) handles competitor moves unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/radar/__tests__/detect.competitors.test.ts
import { describe, expect, it } from "vitest";
import {
  detectCompetitorPriceMoves,
  detectCompetitors,
  detectCompetitorShifts,
} from "../detect-competitors.server";
import type { CompetitorDiffInput } from "../types";

const COMP = "22222222-2222-4222-8222-222222222222";

function diffRow(patch: Partial<CompetitorDiffInput["diff"]>, url = "https://rival.example/products/boots"): CompetitorDiffInput {
  return {
    competitorId: COMP,
    competitorName: "Rival Gear",
    url,
    capturedAt: "2026-07-20T02:00:00Z",
    diff: { titleChanged: null, newHeadings: [], removedHeadings: [], newPrices: [], removedPrices: [], ...patch },
  };
}

describe("detectCompetitorPriceMoves", () => {
  it("drafts an informational review move when a price moved (never auto-apply)", () => {
    const out = detectCompetitorPriceMoves([diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("competitor_price");
    expect(out[0].dedupKey).toBe(`comp-price:${COMP}:/products/boots`);
    // Pricing moves are informational ALWAYS - review mode, deep link, no auto-apply.
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products" });
    expect(out[0].evidence.chips).toEqual(
      expect.arrayContaining(["Rival Gear", "was $129.00", "now $99.00"]),
    );
    expect(out[0].evidence.facts).toMatchObject({ url: "https://rival.example/products/boots" });
    expect(`${out[0].headline} ${out[0].rationale}`).not.toMatch(/ploy/i);
  });
  it("stays silent when prices only appeared or only disappeared", () => {
    expect(detectCompetitorPriceMoves([diffRow({ newPrices: ["$99.00"] })])).toHaveLength(0);
    expect(detectCompetitorPriceMoves([diffRow({ removedPrices: ["$99.00"] })])).toHaveLength(0);
  });
});

describe("detectCompetitorShifts", () => {
  it("drafts ONE home-hero counter per competitor for positioning/new-page changes", () => {
    const out = detectCompetitorShifts([
      diffRow({ titleChanged: { from: "Rival Gear", to: "Rival Gear - Summer Sale" } }, "https://rival.example/"),
      diffRow({ newHeadings: ["New: Alpine collection", "Free shipping"] }, "https://rival.example/collections/alpine"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("competitor_counter");
    expect(out[0].dedupKey).toBe(`comp-counter:${COMP}`);
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "home", competitorId: COMP });
    const brief = String(out[0].payload.brief);
    expect(brief).toContain("hero");
    expect(brief).toContain("Do not mention the competitor");
    expect(`${out[0].headline} ${out[0].rationale} ${brief}`).not.toMatch(/ploy/i);
  });
  it("ignores rows with only price noise or a single heading tweak", () => {
    expect(detectCompetitorShifts([diffRow({ newPrices: ["$1.00"], removedPrices: ["$2.00"] })])).toHaveLength(0);
    expect(detectCompetitorShifts([diffRow({ newHeadings: ["Sale"] })])).toHaveLength(0);
  });
});

describe("detectCompetitors", () => {
  it("concatenates both families", () => {
    const out = detectCompetitors([
      diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] }),
      diffRow({ titleChanged: { from: "a", to: "b" }, newHeadings: ["x", "y"] }, "https://rival.example/"),
    ]);
    expect(out.map((c) => c.kind).sort()).toEqual(["competitor_counter", "competitor_price"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/radar/__tests__/detect.competitors.test.ts`
Expected: FAIL - `Cannot find module '../detect-competitors.server'`.

- [ ] **Step 3: Write `detect-competitors.server.ts`**

```ts
// app/lib/radar/detect-competitors.server.ts
// Pure detectors over competitor snapshot diffs (same style as
// detect.server.ts: no DB, no Claude, thresholds as named constants,
// evidence limited to facts actually present in the stored diff).
//
// Two families:
//  - competitor_price: a comparable price MOVED (both a removed and a new
//    price on the same page). Informational ALWAYS - review mode + deep link
//    to the merchant's own pricing; applying just marks it done.
//  - competitor_counter: positioning/copy change or new page/product signals
//    (title change, or 2+ new headings). Counter = refresh the merchant's OWN
//    home hero via apply-time generation; ONE open counter per competitor
//    (dedup on the competitor id) so a busy rival cannot flood the queue.
import type { CompetitorDiffInput, RadarCandidate } from "./types";

/** A "positioning shift" needs a title change or at least this many new headings. */
export const SHIFT_MIN_NEW_HEADINGS = 2;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pageLabel(url: string): string {
  const path = pathOf(url).replace(/\/+$/, "");
  if (!path || path === "") return "their home page";
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return last ? `their "${last.replace(/-/g, " ")}" page` : "their home page";
}

export function detectCompetitorPriceMoves(diffs: CompetitorDiffInput[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const d of diffs) {
    if (d.diff.newPrices.length === 0 || d.diff.removedPrices.length === 0) continue;
    const was = d.diff.removedPrices[0];
    const now = d.diff.newPrices[0];
    out.push({
      kind: "competitor_price",
      dedupKey: `comp-price:${d.competitorId}:${pathOf(d.url)}`,
      headline: `${d.competitorName} changed their prices`,
      rationale:
        `${d.competitorName} changed pricing on ${pageLabel(d.url)} (for example ${was} is now ${now}). ` +
        `Worth a quick look at your own prices - nothing changes unless you decide to.`,
      evidence: {
        chips: [d.competitorName, `was ${was}`, `now ${now}`],
        facts: {
          competitorId: d.competitorId,
          url: d.url,
          newPrices: d.diff.newPrices,
          removedPrices: d.diff.removedPrices,
          capturedAt: d.capturedAt,
        },
      },
      payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId: d.competitorId, url: d.url },
    });
  }
  return out;
}

export function detectCompetitorShifts(diffs: CompetitorDiffInput[]): RadarCandidate[] {
  // Aggregate per competitor: one counter move covering every shifted page.
  const byCompetitor = new Map<string, { name: string; rows: CompetitorDiffInput[] }>();
  for (const d of diffs) {
    const shifted = d.diff.titleChanged !== null || d.diff.newHeadings.length >= SHIFT_MIN_NEW_HEADINGS;
    if (!shifted) continue;
    const entry = byCompetitor.get(d.competitorId) ?? { name: d.competitorName, rows: [] };
    entry.rows.push(d);
    byCompetitor.set(d.competitorId, entry);
  }
  const out: RadarCandidate[] = [];
  for (const [competitorId, { name, rows }] of byCompetitor) {
    const newHeadings = rows.flatMap((r) => r.diff.newHeadings).slice(0, 5);
    const titleChange = rows.map((r) => r.diff.titleChanged).find((t) => t !== null) ?? null;
    const what = titleChange
      ? `changed their headline messaging ("${titleChange.from}" is now "${titleChange.to}")`
      : `added new sections (${newHeadings.map((h) => `"${h}"`).join(", ")})`;
    out.push({
      kind: "competitor_counter",
      dedupKey: `comp-counter:${competitorId}`,
      headline: `${name} refreshed their store - answer with yours`,
      rationale:
        `${name} recently ${what}. A refreshed home hero keeps your own story sharp. ` +
        `Nothing changes on your store until you apply it.`,
      evidence: {
        chips: [name, `${rows.length} page${rows.length === 1 ? "" : "s"} changed`],
        facts: {
          competitorId,
          pages: rows.map((r) => ({ url: r.url, capturedAt: r.capturedAt, diff: r.diff })),
        },
      },
      payload: {
        applyMode: "refresh_section",
        target: "home",
        competitorId,
        brief:
          "Refresh the home page's hero section: rewrite the headline and supporting copy so this store's " +
          "own strengths and current offering are front and center. Context: a competing store recently " +
          `updated its messaging (${what}). Do not mention the competitor by name and do not copy their ` +
          "wording. Keep the products, prices, layout structure and navigation unchanged.",
      },
    });
  }
  return out;
}

export function detectCompetitors(diffs: CompetitorDiffInput[]): RadarCandidate[] {
  return [...detectCompetitorPriceMoves(diffs), ...detectCompetitorShifts(diffs)];
}
```

- [ ] **Step 4: Wire into the existing pipeline**

In `app/lib/radar/detect.server.ts`, add the import and extend `detectAll`'s returned concatenation with the competitor family (no other change):

```ts
import { detectCompetitors } from "./detect-competitors.server";
// ... inside detectAll's returned array, after the existing families:
    ...detectCompetitors(inputs.competitorDiffs),
```

In `app/lib/radar/collect.server.ts`, `loadRadarInputs` loads the diffs alongside the existing parallel reads (import `listRecentDiffs` from `./competitor-store.server`):

```ts
  const [publishedAt, jsonLdIssues, competitorDiffs] = await Promise.all([
    lastPublishedAt(shopId, release),
    checkTopProductJsonLd(shopId, traffic),
    listRecentDiffs(shopId),
  ]);
```

and return `competitorDiffs` in the result object (the non-uuid early return already carries `competitorDiffs: []` from Task 3).

Extend `app/lib/radar/__tests__/detect.signals.test.ts`'s `detectAll` case: with `competitorDiffs` containing one price-move row, the expected kinds array gains `"competitor_price"`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run app/lib/radar/__tests__/detect.competitors.test.ts app/lib/radar/__tests__/detect.signals.test.ts app/lib/radar/__tests__/collect.server.test.ts app/lib/radar/__tests__/draft.server.test.ts`
Expected: PASS (collect tests may need the `listRecentDiffs` mock added - mock `../competitor-store.server` returning `[]`).

- [ ] **Step 6: Commit**

```bash
git add app/lib/radar/detect-competitors.server.ts app/lib/radar/detect.server.ts app/lib/radar/collect.server.ts app/lib/radar/__tests__/detect.competitors.test.ts app/lib/radar/__tests__/detect.signals.test.ts app/lib/radar/__tests__/collect.server.test.ts
git commit -m "radar/detect: competitor price + positioning detectors feeding the existing move pipeline"
```

---

### Task 7: Crons - snapshot step in radar-collect, new weekly radar-discover

**Files:**
- Modify: `app/lib/radar/collect.server.ts` (`collectShop` gains the snapshot step + deadline)
- Modify: `app/routes/cron.radar-collect.tsx` (pass the deadline)
- Create: `app/routes/cron.radar-discover.tsx`
- Modify: `vercel.json` (weekly cron entry)
- Test: `app/routes/__tests__/cron.radar-discover.test.ts`; extend `app/lib/radar/__tests__/collect.server.test.ts`

**Interfaces:**
- `collectShop(shopId: string, deadline?: number)` - deadline defaults to `Date.now() + 30_000` for direct callers; the cron passes its own budget end.
- `GET /cron/radar-discover` (Bearer `CRON_SECRET`) drains `radar_discovery_queue` through `discoverShopCompetitors` with the standard 50s budget.

- [ ] **Step 1: Extend `collectShop`**

In `app/lib/radar/collect.server.ts` (imports: `isShowcaseShop` from `~/lib/demo/showcase.server`, `snapshotWatchingCompetitors` from `./snapshot.server`):

```ts
export async function collectShop(shopId: string, deadline: number = Date.now() + 30_000): Promise<void> {
  if (!isUuid(shopId)) return; // demo/fixture tenants have no rows
  const sb = getSupabase();
  const { error } = await sb.rpc("radar_rollup_traffic", { p_shop: shopId, p_days: ROLLUP_DAYS });
  if (error) throw new Error(`radar_rollup_traffic: ${error.message}`);
  const stamp = await sb.from("radar_state").upsert(
    { shop_id: shopId, last_collected_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "shop_id" },
  );
  if (stamp.error) throw new Error(`radar_state stamp: ${stamp.error.message}`);
  // Competitor snapshots ride the same nightly step. External fetches NEVER
  // run for demo shops; failures are logged with payloads (surfaced in cron
  // logs) but must not fail the shop's collect - the rollup above succeeded.
  if (await isShowcaseShop(shopId)) return;
  try {
    await snapshotWatchingCompetitors(shopId, { deadline });
  } catch (err) {
    console.error(`[radar] competitor snapshots failed for shop ${shopId}`, err);
  }
}
```

In `app/routes/cron.radar-collect.tsx`, the loop body becomes:

```ts
      await collectShop(row.shop_id, started + TIME_BUDGET_MS);
```

Extend `app/lib/radar/__tests__/collect.server.test.ts` (mock `~/lib/demo/showcase.server` -> `isShowcaseShop` and `../snapshot.server` -> `snapshotWatchingCompetitors` via the existing `vi.hoisted` block):
- `collectShop` calls `snapshotWatchingCompetitors` with the passed deadline for a real shop;
- it does NOT call it when `isShowcaseShop` resolves true;
- a rejected `snapshotWatchingCompetitors` does not make `collectShop` throw.

- [ ] **Step 2: Write the failing discover-cron test**

```ts
// app/routes/__tests__/cron.radar-discover.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  discoverShopCompetitors: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc: mocks.rpcMock }) }));
vi.mock("~/lib/radar/discovery.server", () => ({ discoverShopCompetitors: mocks.discoverShopCompetitors }));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { loader } from "../cron.radar-discover";

function req(auth?: string): never {
  return {
    request: new Request("https://x/cron/radar-discover", { headers: auth ? { authorization: auth } : {} }),
    params: {},
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "sekrit";
  mocks.rpcMock.mockResolvedValue({ data: [{ shop_id: "s1" }, { shop_id: "s2" }, { shop_id: "s3" }], error: null });
});

describe("cron.radar-discover", () => {
  it("401s without the bearer secret", async () => {
    const res = await loader(req());
    expect(res.status).toBe(401);
    expect(mocks.rpcMock).not.toHaveBeenCalled();
  });
  it("drains the discovery queue with per-shop isolation and totals", async () => {
    mocks.discoverShopCompetitors
      .mockResolvedValueOnce({ suggested: 2 })
      .mockResolvedValueOnce({ skipped: "demo_shop" })
      .mockRejectedValueOnce(new Error("anthropic down"));
    const res = await loader(req("Bearer sekrit"));
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_discovery_queue", { p_limit: 200 });
    const body = await res.json();
    expect(body).toMatchObject({ suggested: 2, skippedShops: 1, failed: 1, budgetStopped: false });
    expect(mocks.discoverShopCompetitors).toHaveBeenCalledTimes(3);
  });
  it("500s with the queue error surfaced", async () => {
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "queue broke" } });
    const res = await loader(req("Bearer sekrit"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("queue broke");
  });
});
```

Run: `npx vitest run app/routes/__tests__/cron.radar-discover.test.ts`
Expected: FAIL - `Cannot find module '../cron.radar-discover'`.

- [ ] **Step 3: Write `cron.radar-discover.tsx`**

```ts
// Weekly competitor auto-discovery. Same resumable-drain shape as
// cron.radar-collect: radar_discovery_queue orders by
// radar_state.last_discovered_at (nulls first) and discoverShopCompetitors
// stamps the cursor on success, so a budget-stopped run resumes next week
// where it left off and never starves the tail. One quota-gated Claude
// web_search call per shop; a failed shop logs and never halts the queue.
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { discoverShopCompetitors } from "~/lib/radar/discovery.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

// The loop budgets 50s of work; give the function headroom past the default
// so a run that uses its full budget is not killed mid-shop.
export const config = { maxDuration: 60 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase().rpc("radar_discovery_queue", { p_limit: 200 });
  if (error) return json({ error: `radar_discovery_queue: ${error.message}` }, { status: 500 });
  let suggested = 0;
  let skippedShops = 0;
  let failed = 0;
  let budgetStopped = false;
  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      budgetStopped = true;
      break;
    }
    try {
      const out = await discoverShopCompetitors(row.shop_id);
      if ("suggested" in out) suggested += out.suggested;
      else skippedShops++;
    } catch (err) {
      failed++;
      console.error(`[cron.radar-discover] shop ${row.shop_id} failed`, err);
    }
  }
  console.log(`[cron.radar-discover] suggested ${suggested}, skipped ${skippedShops}, failed ${failed} in ${Date.now() - started}ms`);
  return json({ suggested, skippedShops, failed, budgetStopped });
};
```

- [ ] **Step 4: Register the cron**

In `vercel.json`'s `"crons"` array, after the radar entries (Mondays 08:00 UTC - weekly, and clear of the nightly 10:00/10:30 collect/draft pair):

```json
    { "path": "/cron/radar-discover", "schedule": "0 8 * * 1" }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run app/routes/__tests__/cron.radar-discover.test.ts app/routes/__tests__/cron.radar.test.ts app/lib/radar/__tests__/collect.server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/radar/collect.server.ts app/routes/cron.radar-collect.tsx app/routes/cron.radar-discover.tsx app/routes/__tests__/cron.radar-discover.test.ts app/lib/radar/__tests__/collect.server.test.ts vercel.json
git commit -m "radar/crons: nightly competitor snapshots in radar-collect, weekly radar-discover drain"
```

---

### Task 8: API - competitors VM, live tile, confirm/dismiss actions (`app/routes/dashboard.api.radar.tsx`)

**Files:**
- Modify: `app/routes/dashboard.api.radar.tsx`
- Test: `app/routes/__tests__/dashboard.api.radar-competitors.test.ts`

**Interfaces:**
- Loader payload gains `competitors: RadarCompetitorsVM`; `RadarSignalsVM.competitors` becomes `{ watching, suggested, changesLast7, lastChangeAt }` (the `comingSoon` sentinel is deleted).
- Action gains `competitor_confirm` / `competitor_dismiss` (body `{ action, competitorId }`); existing move actions keep requiring `moveId`.

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/dashboard.api.radar-competitors.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  listMoves: vi.fn(),
  readRadarState: vi.fn(),
  listCompetitors: vi.fn(),
  setCompetitorStatus: vi.fn(),
  listSnapshotTimeline: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: mocks.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: mocks.requireSameOrigin,
  dashboardJson: async (fn: () => Promise<unknown>) =>
    new Response(JSON.stringify(await fn()), { status: 200, headers: { "content-type": "application/json" } }),
  jsonError: (status: number, code: string, message?: string) =>
    new Response(JSON.stringify({ error: code, message }), { status }),
}));
vi.mock("~/lib/radar/store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMoves: mocks.listMoves,
  readRadarState: mocks.readRadarState,
}));
vi.mock("~/lib/radar/apply.server", () => ({
  applyMove: vi.fn(),
  dismissMove: vi.fn(),
  revertMove: vi.fn(),
  RadarApplyError: class RadarApplyError extends Error {},
}));
vi.mock("~/lib/radar/competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCompetitors: mocks.listCompetitors,
  setCompetitorStatus: mocks.setCompetitorStatus,
  listSnapshotTimeline: mocks.listSnapshotTimeline,
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { action, loader } from "../dashboard.api.radar";

const SHOP = "11111111-1111-4111-8111-111111111111";
const COMP = "22222222-2222-4222-8222-222222222222";

function chain(result: { data?: unknown; error?: unknown }) {
  const self: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve({ data: result.data ?? null, error: result.error ?? null });
      }
      return () => self;
    },
  }) as never;
  return self;
}

function competitor(status: "suggested" | "watching") {
  return {
    id: COMP, shopId: SHOP, url: "https://rivalgear.example/", name: "Rival Gear", status,
    discoveryEvidence: { reason: "Sells hiking boots and packs" },
    createdAt: "2026-07-14T08:00:00Z", updatedAt: "2026-07-14T08:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardSession.mockResolvedValue({ shopId: SHOP, userId: "u1" });
  mocks.listMoves.mockResolvedValue([]);
  mocks.readRadarState.mockResolvedValue({ lastCollectedAt: null, lastDraftedAt: null, homeCardDismissedAt: null, lastDiscoveredAt: null });
  mocks.listCompetitors.mockImplementation(async (_shop: string, statuses: string[]) =>
    statuses.includes("suggested") ? [competitor("suggested")]
      : statuses.includes("watching") ? [competitor("watching")] : []);
  mocks.listSnapshotTimeline.mockResolvedValue([{
    competitorId: COMP, url: "https://rivalgear.example/", capturedAt: new Date().toISOString(),
    diff: { titleChanged: { from: "a", to: "b" }, newHeadings: ["Sale"], removedHeadings: [], newPrices: ["$9.00"], removedPrices: ["$12.00"] },
  }]);
  mocks.from.mockReturnValue(chain({ data: [] }));
  mocks.rpc.mockResolvedValue({ data: [], error: null });
});

function loaderArgs(): never {
  return { request: new Request("https://x/dashboard/api/radar"), params: {}, context: {} } as never;
}
function actionArgs(body: Record<string, unknown>): never {
  return {
    request: new Request("https://x/dashboard/api/radar", { method: "POST", body: JSON.stringify(body) }),
    params: {}, context: {},
  } as never;
}

describe("loader competitors block", () => {
  it("ships suggested + watching VMs and a LIVE competitors tile", async () => {
    const res = await loader(loaderArgs());
    const body = await res.json();
    expect(body.competitors.suggested[0]).toMatchObject({
      id: COMP, name: "Rival Gear", host: "rivalgear.example", reason: "Sells hiking boots and packs",
    });
    expect(body.competitors.watching[0].changes[0].chips).toEqual(
      expect.arrayContaining(["new headline", "prices changed"]),
    );
    expect(body.competitors.watchLimit).toBe(5);
    expect(body.signals.competitors).toMatchObject({ watching: 1, suggested: 1, changesLast7: 1 });
    expect(body.signals.competitors.comingSoon).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/ploy/i);
  });
});

describe("competitor actions", () => {
  it("confirm flips a suggestion to watching", async () => {
    mocks.setCompetitorStatus.mockResolvedValue("updated");
    const res = await action(actionArgs({ action: "competitor_confirm", competitorId: COMP }));
    expect(res.status).toBe(200);
    expect(mocks.requireSameOrigin).toHaveBeenCalled();
    expect(mocks.setCompetitorStatus).toHaveBeenCalledWith(SHOP, COMP, "watching");
  });
  it("surfaces the 5-competitor watch limit as a 422 with plain copy", async () => {
    mocks.setCompetitorStatus.mockResolvedValue("limit_reached");
    const res = await action(actionArgs({ action: "competitor_confirm", competitorId: COMP }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("watch_limit");
  });
  it("dismiss works for suggested and watching rows; missing rows 404", async () => {
    mocks.setCompetitorStatus.mockResolvedValue("updated");
    const ok = await action(actionArgs({ action: "competitor_dismiss", competitorId: COMP }));
    expect(ok.status).toBe(200);
    expect(mocks.setCompetitorStatus).toHaveBeenCalledWith(SHOP, COMP, "dismissed");
    mocks.setCompetitorStatus.mockResolvedValue("not_found");
    const nf = await action(actionArgs({ action: "competitor_dismiss", competitorId: COMP }));
    expect(nf.status).toBe(404);
  });
  it("rejects competitor actions without a competitorId", async () => {
    const res = await action(actionArgs({ action: "competitor_confirm" }));
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.radar-competitors.test.ts`
Expected: FAIL - loader has no `competitors` field / action rejects the new intents.

- [ ] **Step 3: Extend the route**

In `app/routes/dashboard.api.radar.tsx`:

Add imports:

```ts
import {
  listCompetitors,
  listSnapshotTimeline,
  MAX_WATCHED_COMPETITORS,
  setCompetitorStatus,
  type SnapshotTimelineRow,
} from "~/lib/radar/competitor-store.server";
import type { CompetitorDiff, RadarCompetitorRow } from "~/lib/radar/types";
```

Add the VMs + helpers (near the existing VM block):

```ts
interface RadarCompetitorChangeVM {
  day: string; // YYYY-MM-DD
  url: string;
  chips: string[];
}

interface RadarCompetitorVM {
  id: string;
  name: string;
  host: string;
  url: string;
  status: string;
  reason: string;
  addedAt: string;
  changes: RadarCompetitorChangeVM[];
}

interface RadarCompetitorsVM {
  suggested: RadarCompetitorVM[];
  watching: RadarCompetitorVM[];
  watchLimit: number;
}

/** Plain-language chips for one page diff (data shown is from the stored diff only). */
function diffChips(diff: CompetitorDiff): string[] {
  const chips: string[] = [];
  if (diff.titleChanged) chips.push("new headline");
  if (diff.newHeadings.length > 0) {
    chips.push(`${diff.newHeadings.length} new section${diff.newHeadings.length === 1 ? "" : "s"}`);
  }
  if (diff.newPrices.length > 0 || diff.removedPrices.length > 0) chips.push("prices changed");
  return chips;
}

function toCompetitorVM(c: RadarCompetitorRow, timeline: SnapshotTimelineRow[]): RadarCompetitorVM {
  let host = c.url;
  try {
    host = new URL(c.url).hostname;
  } catch {
    // keep the raw value
  }
  return {
    id: c.id,
    name: c.name || host,
    host,
    url: c.url,
    status: c.status,
    reason: typeof c.discoveryEvidence.reason === "string" ? c.discoveryEvidence.reason : "",
    addedAt: c.createdAt,
    changes: timeline
      .filter((t) => t.competitorId === c.id)
      .slice(0, 10)
      .map((t) => ({ day: t.capturedAt.slice(0, 10), url: t.url, chips: diffChips(t.diff) })),
  };
}

async function buildCompetitors(shopId: string): Promise<{ vm: RadarCompetitorsVM; timeline: SnapshotTimelineRow[] }> {
  const [suggested, watching, timeline] = await Promise.all([
    listCompetitors(shopId, ["suggested"]),
    listCompetitors(shopId, ["watching"]),
    listSnapshotTimeline(shopId),
  ]);
  return {
    vm: {
      suggested: suggested.map((c) => toCompetitorVM(c, [])),
      watching: watching.map((c) => toCompetitorVM(c, timeline)),
      watchLimit: MAX_WATCHED_COMPETITORS,
    },
    timeline,
  };
}
```

Replace the tile type + empty value in `RadarSignalsVM` / `EMPTY_SIGNALS`:

```ts
  competitors: { watching: number; suggested: number; changesLast7: number; lastChangeAt: string | null };
// ...
  competitors: { watching: 0, suggested: 0, changesLast7: 0, lastChangeAt: null },
```

`buildSignals` gains a `competitors` argument instead of computing its own reads (the loader already builds them): change its signature to `buildSignals(shopId, comp: { vm: RadarCompetitorsVM; timeline: SnapshotTimelineRow[] })` and set, inside its own try/catch:

```ts
  try {
    const weekAgo = Date.now() - 7 * DAY_MS;
    signals.competitors.watching = comp.vm.watching.length;
    signals.competitors.suggested = comp.vm.suggested.length;
    signals.competitors.changesLast7 = comp.timeline.filter((t) => Date.parse(t.capturedAt) >= weekAgo).length;
    signals.competitors.lastChangeAt = comp.timeline[0]?.capturedAt ?? null;
  } catch (err) {
    console.error("[radar] competitor signal failed", err);
  }
```

Loader body becomes:

```ts
    const competitorsData = await buildCompetitors(session.shopId).catch((err) => {
      console.error("[radar] competitors read failed", err);
      return { vm: { suggested: [], watching: [], watchLimit: MAX_WATCHED_COMPETITORS }, timeline: [] };
    });
    const [moves, history, signals] = await Promise.all([
      listMoves(session.shopId, ["draft"]),
      listMoves(session.shopId, ["applied", "dismissed", "expired"]),
      buildSignals(session.shopId, competitorsData),
    ]);
    return { moves: moves.map(toMoveVM), history: history.map(toMoveVM), signals, competitors: competitorsData.vm };
```

(and the non-uuid early return gains `competitors: { suggested: [], watching: [], watchLimit: MAX_WATCHED_COMPETITORS }`).

Action: extend `RadarBody` with `competitorId?: string`, and branch BEFORE the move-id validation:

```ts
  if (body?.action === "competitor_confirm" || body?.action === "competitor_dismiss") {
    if (typeof body.competitorId !== "string") {
      return jsonError(422, "bad_request", "competitorId is required");
    }
    const status = body.action === "competitor_confirm" ? ("watching" as const) : ("dismissed" as const);
    try {
      const outcome = await setCompetitorStatus(session.shopId, body.competitorId, status);
      if (outcome === "limit_reached") {
        return jsonError(422, "watch_limit",
          `You can watch up to ${MAX_WATCHED_COMPETITORS} competitors. Dismiss one first to add another.`);
      }
      if (outcome === "not_found") return jsonError(404, "competitor_not_found", "That competitor no longer exists.");
      return dashboardJson(async () => ({ competitors: (await buildCompetitors(session.shopId)).vm }));
    } catch (err) {
      console.error(`[radar] ${body.action} failed for competitor ${body.competitorId}`, err);
      return jsonError(500, "radar_action_failed", "That didn't go through. Your list was not changed.");
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/routes/__tests__/dashboard.api.radar-competitors.test.ts app/routes/__tests__/dashboard.api.radar.test.ts`
Expected: PASS. If the existing `dashboard.api.radar.test.ts` asserts the old `{ comingSoon: true }` tile or the exact loader payload shape, update those assertions to the live tile + `competitors` field (they are testing the VM contract, which this task deliberately changes; note the downgrade in the commit message).

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.radar.tsx app/routes/__tests__/dashboard.api.radar-competitors.test.ts app/routes/__tests__/dashboard.api.radar.test.ts
git commit -m "dashboard/radar-api: competitors VM + confirm/dismiss actions, live competitor tile"
```

---

### Task 9: UI - client mirror, Competitors tab, live tile

**Files:**
- Modify: `app/lib/dashboard/radar-client.ts`
- Modify: `app/components/dashboard/screens/Radar.tsx`

**Interfaces:**
- Client mirrors of the Task 8 VMs + `confirmRadarCompetitor` / `dismissRadarCompetitor`; `RADAR_KIND_LABELS` gains the two competitor kinds. Competitors data rides the existing `fetchRadar()` payload and the existing `SCREEN_CACHE_KEYS.radar` seed/write-through - no new WARM_TARGETS entry.

- [ ] **Step 1: Extend `radar-client.ts`**

Replace the `competitors` line of `RadarSignalsVM` and append the new mirrors (hand-kept, matching Task 8's server shapes exactly):

```ts
export interface RadarSignalsVM {
  traffic: { yesterdayViews: number; weeklyAverage: number; lastCheckedAt: string | null };
  google: { connected: boolean; lastCapturedDate: string | null; slippingCount: number };
  aiAssistants: { hitsLast7: number; hitsPrior7: number };
  competitors: { watching: number; suggested: number; changesLast7: number; lastChangeAt: string | null };
}

export interface RadarCompetitorChangeVM {
  day: string;
  url: string;
  chips: string[];
}

export interface RadarCompetitorVM {
  id: string;
  name: string;
  host: string;
  url: string;
  status: "suggested" | "watching" | "dismissed";
  reason: string;
  addedAt: string;
  changes: RadarCompetitorChangeVM[];
}

export interface RadarCompetitorsVM {
  suggested: RadarCompetitorVM[];
  watching: RadarCompetitorVM[];
  watchLimit: number;
}

export interface RadarOverviewVM {
  moves: RadarMoveVM[];
  history: RadarMoveVM[];
  signals: RadarSignalsVM;
  competitors: RadarCompetitorsVM;
}
```

Extend the labels (plain language):

```ts
export const RADAR_KIND_LABELS: Record<string, string> = {
  seo_regression_patch: "Google ranking",
  seo_meta_rewrite: "Google ranking",
  seo_content_boost: "Google ranking",
  aeo_refresh: "AI assistants",
  aeo_jsonld_fix: "AI assistants",
  section_refresh: "Store page",
  competitor_counter: "Competitor",
  competitor_price: "Competitor pricing",
};
```

Add the action helpers:

```ts
export const confirmRadarCompetitor = (competitorId: string) =>
  apiSend<{ competitors: RadarCompetitorsVM }>("POST", "/dashboard/api/radar", {
    action: "competitor_confirm",
    competitorId,
  });

export const dismissRadarCompetitor = (competitorId: string) =>
  apiSend<{ competitors: RadarCompetitorsVM }>("POST", "/dashboard/api/radar", {
    action: "competitor_dismiss",
    competitorId,
  });
```

- [ ] **Step 2: Extend `Radar.tsx`**

1. `type Tab = "moves" | "history" | "competitors";` and import `confirmRadarCompetitor`, `dismissRadarCompetitor`, and the `RadarCompetitorVM` type from `radar-client`.

2. Destructure `competitors` from `data` alongside `moves, history, signals` and extend the `Segmented` options:

```tsx
          options={[
            { value: "moves", label: `Moves${moves.length > 0 ? ` (${moves.length})` : ""}` },
            {
              value: "competitors",
              label: `Competitors${competitors.suggested.length > 0 ? ` (${competitors.suggested.length})` : ""}`,
            },
            { value: "history", label: "History" },
          ]}
```

3. Replace the "Coming soon" tile with the live one:

```tsx
        <SignalTile
          icon="eye"
          label="Competitors"
          value={
            signals.competitors.watching > 0
              ? `${signals.competitors.watching} watched`
              : signals.competitors.suggested > 0
                ? `${signals.competitors.suggested} suggested`
                : "None yet"
          }
          note={
            signals.competitors.watching > 0
              ? signals.competitors.changesLast7 > 0
                ? `${signals.competitors.changesLast7} change${signals.competitors.changesLast7 === 1 ? "" : "s"} this week · last ${whenLabel(signals.competitors.lastChangeAt)}`
                : "No changes this week"
              : "Radar suggests stores weekly - confirm to watch"
          }
        />
```

4. A competitor action helper next to `run` (same busy/toast pattern; competitor buttons reuse `busyId` with the competitor id):

```tsx
  const runCompetitor = useCallback(
    async (competitorId: string, fn: () => Promise<unknown>, doneMsg: string) => {
      setBusyId(competitorId);
      try {
        await fn();
        toast(doneMsg, "check");
        await load();
      } catch (err) {
        toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );
```

5. The tab body (after the history block; card sub-component inline). Every URL shown is data from the merchant's own list; the caption makes the non-endorsement explicit:

```tsx
      {tab === "competitors" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {competitors.suggested.length === 0 && competitors.watching.length === 0 && (
            <Placeholder
              icon="eye"
              title="No competitors yet"
              sub="Once your store is live, Radar searches the web weekly for stores selling similar products and lists them here. Nothing is watched until you confirm it."
            />
          )}

          {competitors.suggested.length > 0 && (
            <>
              <h3 style={{ margin: "4px 0 0" }}>Suggested</h3>
              <p className="cd-caption" style={{ margin: 0 }}>
                Found by web search - listed stores aren't affiliated with Calderyn. Confirm the ones you
                want watched; Radar checks watched stores nightly.
              </p>
              {competitors.suggested.map((c) => (
                <Card key={c.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    <span className="cd-chip">{c.host}</span>
                  </div>
                  {c.reason && <p className="cd-caption">{c.reason}</p>}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn kind="primary" disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => confirmRadarCompetitor(c.id), "Watching. Radar checks it nightly.")}>
                      {busyId === c.id ? "Confirming…" : "Watch this store"}
                    </Btn>
                    <Btn disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => dismissRadarCompetitor(c.id), "Dismissed.")}>
                      Dismiss
                    </Btn>
                  </div>
                </Card>
              ))}
            </>
          )}

          {competitors.watching.length > 0 && (
            <>
              <h3 style={{ margin: "4px 0 0" }}>
                Watching ({competitors.watching.length}/{competitors.watchLimit})
              </h3>
              {competitors.watching.map((c) => (
                <Card key={c.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    <span className="cd-chip">{c.host}</span>
                  </div>
                  {c.changes.length === 0 ? (
                    <p className="cd-caption">No changes spotted yet. Radar checks nightly.</p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      {c.changes.map((ch, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="cd-caption" style={{ margin: 0 }}>{whenLabel(ch.day)}</span>
                          {ch.chips.map((chip, j) => (
                            <span key={j} className="cd-chip">{chip}</span>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => dismissRadarCompetitor(c.id), "Stopped watching.")}>
                      Stop watching
                    </Btn>
                  </div>
                </Card>
              ))}
            </>
          )}
        </div>
      )}
```

`whenLabel` already tolerates a bare `YYYY-MM-DD` string (Date parses it); the `eye` icon is already used by the tile, so no `CD_ICONS` additions. If any class name used here doesn't exist in `dashboard.css`, use the closest existing one from another screen rather than adding CSS.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run app/routes/__tests__/dashboard.api.radar-competitors.test.ts && npm run build`
Expected: exit 0 - proves the client mirror matches, no `.server` module leaked into the client graph, and the bundle scan stays clean.

- [ ] **Step 4: Commit**

```bash
git add app/lib/dashboard/radar-client.ts app/components/dashboard/screens/Radar.tsx
git commit -m "dashboard/radar: Competitors tab with confirm/dismiss + change timeline, live tile"
```

---

### Task 10: Full gate + phase wrap

**Files:** none new.

- [ ] **Step 1: Full eval pipeline**

```bash
npm run typecheck && npm run lint && npm run build && npx vitest run
```
Expected: all exit 0; zero warnings on touched files. The build's `scripts/verify-client-bundle.mjs` scan must pass - if it flags anything from this branch, remove the marker (likely suspects: an internal comment in `Radar.tsx` or `radar-client.ts`).

- [ ] **Step 2: Merchant-copy sweep**

```bash
grep -rn "ploy" app/components app/lib/dashboard --include="*.ts" --include="*.tsx"
```
Expected: zero matches (the internal noun may appear only in `app/lib/radar/*.server.ts`, route server files, tests, and SQL). Also spot-check the new detector copy: `grep -n "ploy" app/lib/radar/detect-competitors.server.ts app/lib/radar/discovery.server.ts` - zero matches (these strings reach merchant cards and Claude prompts).

- [ ] **Step 3: /code-review**

Run the `/code-review` slash command on the working tree. Resolve every blocker; downgrade nits explicitly with a one-line justification each.

- [ ] **Step 4: Deployment checklist (verify, do not push)**

- `vercel.json` carries `/cron/radar-discover` (`0 8 * * 1`) alongside `/cron/radar-collect` (10:00) and `/cron/radar-draft` (10:30).
- Migration `20260721120000_radar_competitors.sql` is applied on prod (`mcp__supabase__list_migrations` shows it) and the Task 1 Step 2 verification queries pass - especially the constraint def listing both competitor kinds.
- No new required env vars (`RADAR_DISCOVERY_MODEL` is optional; `CRON_SECRET` and `ANTHROPIC_API_KEY` already exist).
- Spend sanity: discovery is 1 web_search-equipped call/shop/week (`max_uses: 3` searches inside it), belt-and-braces daily cap 2 via the `radar_discovery` bucket; snapshots make zero Claude calls; competitor moves ride the existing `radar` (polish) and `radar_apply` (apply-time generation) buckets.
- Prod autodeploys `origin/main` - do NOT push or merge; that waits for explicit instruction.

- [ ] **Step 5: Commit any gate fixes**

One commit per logical fix, subject prefixed with the module touched (e.g. `radar/snapshot: fix lint warning in ...`). Never `--no-verify`, never suppress a type error to silence the gate.

## Out of scope for this plan

- **New-page counters** and the `storefront.pages.$handle` route (spec decision 7 - counters modify existing pages only; Phase D counters target the home hero).
- **Auto-watching** discovered competitors, auto-confirming suggestions, or any path to `watching` other than the merchant's Confirm click.
- **One-click price changes** from competitor evidence (pricing moves stay informational; spec decision 6).
- Manually adding a competitor by URL (merchant-entered watches are a small follow-up; discovery + confirm is the v1 funnel).
- PDP/collection-targeted counter moves (needs truthful product-level attribution from competitor pages - deferred rather than guessed).
- Screenshot/visual diffing, sitemap crawling, JS-rendered pages (fetches are plain HTML GETs), per-competitor crawl scheduling.
- Bing/other search consoles, backlink analysis, multi-language, push/email delivery of competitor changes (spec v1 exclusions).
- Re-running discovery on demand from the UI (weekly cron only in v1).

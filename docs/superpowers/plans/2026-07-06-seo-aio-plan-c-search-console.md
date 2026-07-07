# Search (SEO & AIO) — Plan C: Google Search Console rankings loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant connect Google Search Console, pull their store's real ranking data once a day, show clicks / impressions / top query on the Search screen's "On Google" card, and surface product pages whose position is slipping so the merchant can fix them in the existing Plan B editor.

**Architecture:** A new server-only module `app/lib/seo/google-search-console.server.ts` holds the whole loop: an env-gated OAuth consent-URL builder, an injected-fetcher token exchange, a Search Analytics fetch, an idempotent upsert into a new `seo_ranking` table, and pure analyzers (`summariseGoogleCard`, `detectSlips`). It reuses the repo's existing Google data-scope OAuth client, the AES-256-GCM `encrypt`/`decrypt` helper, and the single-use `oauth_state` CSRF nonce. The Google refresh token lives ENCRYPTED in a separate deny-all secret table (`seo_google_credential`) that the read-lane `app_web` role can never see; only service-role server code reads it. The dashboard `dashboard.api.search` route gains `connectGoogle` / `disconnectGoogle` actions, a new callback route finishes the OAuth round-trip, a daily `cron.seo-rankings` route drives the sync, and `overview.server.ts` feeds the card + "slipping on Google" rows. Everything is inert when Google is not configured or a shop is not connected.

**Tech Stack:** TypeScript (strict), Remix 2.17.5, React 18, Supabase Postgres, Vitest 4 (`environment: "node"`; component smoke tests render via `react-dom/server`), `node:crypto` AES-256-GCM.

## Known external dependency (READ FIRST)

The live connection cannot be exercised in this environment. It needs, all external to this repo:

1. A real Google Cloud OAuth 2.0 client whose consent screen has the **`https://www.googleapis.com/auth/webmasters.readonly`** scope added and approved, and whose **authorized redirect URI** list includes `https://calderyncompany.com/dashboard/auth/gsc/callback`. Plan C reuses the existing verified data-scope client (`GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`), optionally overridable via `GOOGLE_SEARCH_CONSOLE_CLIENT_ID` / `_SECRET`.
2. The merchant's storefront property must be **verified in Search Console** (Calderyn injects a site-wide meta tag; DNS TXT is the custom-domain fallback). Search Analytics returns nothing until Google has indexed the store, which is why this is Phase 2.

**Because of this, every task is verifiable OFFLINE:** all external HTTP is behind an injected fetcher or a stubbed `global.fetch`, and every test mocks it. No test in this plan makes a network call. When the env vars are absent the connect URL is `null`, the cron no-ops, the "On Google" card stays a placeholder, and no code path throws — this dormancy is itself tested (Task C2 Step 1, Task C4 Step 1).

## Global Constraints

Copied verbatim from Plan A / Plan B. Every task implicitly includes these.

- Node.js 20.10+, ES modules (`"type": "module"`).
- TypeScript only. No `any` without written justification; prefer `unknown` + narrowing. `tsc --noEmit` is authoritative.
- Files ending `.server.ts` are server-only; never import them from a client module.
- Storefront is public and multi-tenant with NO Postgres RLS on that surface: every catalog/DB read is scoped by the `shopId` returned from `resolveStorefrontShop(request)`.
- Server reads Supabase via `getSupabase()` (uses `SUPABASE_SECRET_KEY`). Never reference env in client bundles.
- Browser-visible source hygiene: no comments/strings/identifiers implying AI generation, no dev overlays/debug panels, no client source maps. Keep browser-facing comments technical and product-neutral.
- No em dashes (`—`/`–`) in any user-facing copy this feature emits (titles, descriptions, screen copy). Use a middot `·`, comma, or period.
- Schema changes ship as a checked-in SQL migration in `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`, every table shop-scoped with RLS using `public.current_shop_id()`, plus `grant select ... to app_web`, plus a one-line classification in `app/lib/security/tenant-tables.ts`. Applied to prod (project `ajgrmnvzxfxxlwrxcgnu`) via the supabase MCP `apply_migration`.
- Pre-commit gate before any commit that touches routes/lib/schema: `npm run typecheck` (exit 0) -> `npm run lint` (exit 0) -> `npm run build` (exit 0). Never `--no-verify`, never silence `tsc`/eslint.
- Match existing file layout: shared logic in `app/lib/`, colocated tests in `__tests__/`.

### Plan C delta to the Global Constraints (schema bullet)

The schema bullet's "plus a one-line classification in `app/lib/security/tenant-tables.ts`" **does NOT apply to `seo_ranking` or `seo_google_credential`**, exactly as it did not apply to `seo_page` / `seo_settings` / `seo_ai_crawl_daily`. That census is frozen (`NO_POLICY_TABLE_COUNT = 49`, asserted against `20260702120000_tenant_isolation_hardening.sql`) and adding rows to it would break that self-test. These tables carry **self-contained RLS in the migration** and are intentionally NOT added to the census:

- `seo_ranking` follows the `seo_page` shop-scope convention: `enable row level security` + a `current_shop_id()` policy + `revoke ... from anon, authenticated` + `grant select ... to app_web` (its rows are non-secret ranking numbers, safe for the read lane).
- `seo_google_credential` follows the **`oauth_state` / `integration_credentials` deny-all-secret convention**: `enable row level security`, **NO policy**, `revoke all from anon, authenticated`, and **NO grant to `app_web`**. Only the service-role key (which bypasses RLS) may read the encrypted refresh token. This is the load-bearing security boundary of Plan C.

Everything else in the schema bullet (migration file, `current_shop_id()`, prod apply via MCP) still holds.

### Deferred by design

**Automatic rewrite-on-slip is intentionally deferred.** Plan C does NOT build an agent that rewrites a page's meta from a slipping keyword. Surfacing slipping pages in `needsAttention` (Task C5) is the actionable output; the merchant fixes them through the existing Plan B editor (`Search.tsx` -> `saveOverride`). Surfacing plus the human-reviewed manual editor covers the loop safely, with no unattended writes to a live storefront.

---

## Shared interface contract (used across tasks)

Plan A's engine (`buildProductDraft`, `scoreDraft`) and Plan B's read-models (`buildSeoOverview`, `getProductSeoDetail`, `getShopStorefrontOrigin`, `SeoOverviewVM`, `NeedsAttentionRow`), persistence (`getSeoSettings`), the dashboard route (`dashboard.api.search`), the browser client (`search-client.ts`), and `Search.tsx` are assumed present. Plan C changes `SeoOverviewVM` (adds a required `google` field) and adds the module below.

```ts
// app/lib/seo/google-search-console.server.ts

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export interface RankingRow {
  query: string;
  pageUrl: string;
  position: number;      // 1 = top of results; higher = worse
  impressions: number;
  clicks: number;
  ctr: number;
  capturedDate: string;  // YYYY-MM-DD (the GSC "date" dimension)
}
export interface GscState { connected: boolean; siteUrl: string | null; }
export interface GoogleCardVM {
  connected: boolean;
  clicks: number;
  impressions: number;
  topQuery: string | null;
  topPosition: number | null;
}
export interface RankingSlip {
  pageUrl: string;
  query: string;
  fromPosition: number;  // earliest capture in the window
  toPosition: number;    // latest capture in the window
  delta: number;         // toPosition - fromPosition (positive = slipped)
}

// --- env gating (dormancy) ---
export function gscConfigured(): boolean;
export function gscRedirectUri(): string;

// --- connect ---
export function buildConnectUrl(shopId: string, state: string): string | null; // null when not configured
export async function exchangeAndStore(shopId: string, code: string): Promise<void>;
export async function disconnect(shopId: string): Promise<void>;

// --- sync ---
export async function fetchSearchAnalytics(shopId: string): Promise<RankingRow[]>;
export async function syncRankings(shopId: string): Promise<{ upserted: number }>;
export async function listConnectedShopIds(): Promise<string[]>;

// --- reads for the overview ---
export async function getGscState(shopId: string): Promise<GscState>;
export async function getRankingsSince(shopId: string, sinceDate: string): Promise<RankingRow[]>;

// --- pure analyzers (unit-tested without I/O) ---
export type GoogleTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
export type TokenFetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<GoogleTokenResponse>;
export interface GscAnalyticsRow { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }
export interface GscAnalyticsResponse { rows?: GscAnalyticsRow[]; error?: { message?: string } }
export type AnalyticsFetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<GscAnalyticsResponse>;

export async function exchangeCodeForRefreshToken(fetcher: TokenFetcher, opts: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<string>;
export async function exchangeRefreshForAccess(fetcher: TokenFetcher, opts: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string>;
export function parseAnalyticsRows(resp: GscAnalyticsResponse): RankingRow[];
export async function fetchAnalyticsWith(fetcher: AnalyticsFetcher, opts: { accessToken: string; siteUrl: string; startDate: string; endDate: string }): Promise<RankingRow[]>;
export function summariseGoogleCard(rows: RankingRow[]): { clicks: number; impressions: number; topQuery: string | null; topPosition: number | null };
export function detectSlips(rows: RankingRow[], threshold?: number): RankingSlip[];
```

```ts
// app/lib/seo/overview.server.ts (CHANGED)
export interface SeoOverviewVM {
  storeHealth: number;
  productCount: number;
  needsAttention: NeedsAttentionRow[];
  aiCrawls: AiCrawlRow[];
  aiCrawlTotal: number;
  settings: SeoSettings;
  google: GoogleCardVM;   // NEW — always present; { connected:false, 0s } when not connected
}
```

```ts
// app/lib/dashboard/search-client.ts (CHANGED — browser-safe mirrors)
export interface GoogleCardVM { connected: boolean; clicks: number; impressions: number; topQuery: string | null; topPosition: number | null }
// SeoOverviewVM gains: google: GoogleCardVM
export const connectGoogleSearchConsole: () => Promise<{ url: string }>;
export const disconnectGoogleSearchConsole: () => Promise<{ ok: true }>;
```

**Reused infrastructure (do NOT reinvent):**
- Encryption: `encrypt`/`decrypt` from `~/lib/crypto.server` (AES-256-GCM, key `INTEGRATION_ENCRYPTION_KEY`, format `ivHex:tagHex:dataHex`).
- CSRF: `createOAuthState(sb, shopId, ctx?)` / `consumeOAuthState(sb, state)` from `~/lib/meta/oauth-state.server` (single-use nonce in `oauth_state`, 10-min TTL).
- Cron auth: `isAuthorizedCron(header, secret)` from `~/lib/cron-auth.server` (constant-time, fail-closed).
- OAuth base URL: `publicBaseUrl()` from `~/lib/dashboard/http.server` (`DASHBOARD_PUBLIC_URL || SHOPIFY_APP_URL`).
- Tenant host: `tenantDomain(slug)` from `~/lib/storefront/vercel-domain.server`.

**Entity-id convention:** slipping rows key on a product `handle` parsed from the ranked `page_url` (`/storefront/products/<handle>`), matching Plan B's editor which opens by handle. Non-product URLs (home/collection) are not surfaced as slipping rows in v1.

---

### Task C1: Migration — `seo_ranking` + `seo_settings` GSC columns + `seo_google_credential` secret table

**Files:**
- Create: `supabase/migrations/20260707120000_seo_search_console.sql`

**Interfaces:**
- Produces: the `seo_ranking` table (read via `app_web` + service role), two new `seo_settings` columns (`gsc_connected`, `gsc_site_url`), and the deny-all `seo_google_credential` secret table (service role only). No app code in this task.
- Consumes: `public.current_shop_id()`, `public.shops`, `public.seo_settings` (Plan B), the `app_web` role — all pre-existing.

Per the **Plan C delta**: self-contained RLS in the migration; do NOT touch `app/lib/security/tenant-tables.ts`.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260707120000_seo_search_console.sql`:

```sql
-- Google Search Console rankings loop (Plan C). Three changes:
--  1. seo_ranking: daily Search Analytics rows per store. Non-secret ranking
--     numbers; self-contained shop-scope RLS like seo_page / seo_ai_crawl_daily.
--  2. seo_settings: gsc_connected + gsc_site_url (non-secret connection state).
--  3. seo_google_credential: the encrypted Google refresh token. A DENY-ALL
--     secret table (RLS on, NO policy, NO app_web grant), reachable only by
--     service-role server code. Mirrors oauth_state / integration_credentials.
-- All three follow the storefront-facing tenant convention: RLS lives here in
-- the migration and these tables are intentionally NOT added to the frozen
-- app/lib/security/tenant-tables.ts census.

create table if not exists public.seo_ranking (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  query         text not null,
  page_url      text not null,
  position      numeric not null,
  impressions   integer not null default 0,
  clicks        integer not null default 0,
  ctr           numeric not null default 0,
  captured_date date not null,
  source        text not null default 'search_console',
  unique (shop_id, query, page_url, captured_date)
);
create index if not exists seo_ranking_shop_date_idx on public.seo_ranking (shop_id, captured_date);

alter table public.seo_ranking enable row level security;
drop policy if exists seo_ranking_shop_scope on public.seo_ranking;
create policy seo_ranking_shop_scope on public.seo_ranking
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_ranking from anon, authenticated;
grant select on table public.seo_ranking to app_web;

-- Non-secret connection state on the existing per-shop settings row.
alter table public.seo_settings add column if not exists gsc_connected boolean not null default false;
alter table public.seo_settings add column if not exists gsc_site_url  text;

-- SECRET: the Google refresh token. Deny-all (RLS on, NO policy, NO app_web
-- grant); only the service-role key (BYPASSRLS) may read/write it.
create table if not exists public.seo_google_credential (
  shop_id                 uuid primary key references public.shops(id) on delete cascade,
  refresh_token_encrypted text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.seo_google_credential enable row level security;
revoke all on table public.seo_google_credential from anon, authenticated;
-- Intentionally NO policy and NO grant to app_web: the encrypted refresh token
-- must never be readable by the dashboard read lane or any browser-reachable role.

-- Self-tests: fail the apply if any invariant is missing.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='seo_ranking' and rowsecurity=true) then
    raise exception 'seo_ranking is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='seo_google_credential' and rowsecurity=true) then
    raise exception 'seo_google_credential is missing RLS';
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='seo_google_credential') then
    raise exception 'seo_google_credential must have NO RLS policy (deny-all secret table)';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and table_name='seo_google_credential' and grantee='app_web'
  ) then
    raise exception 'seo_google_credential must NOT be granted to app_web (secret table)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='seo_settings' and column_name='gsc_connected') then
    raise exception 'seo_settings.gsc_connected was not added';
  end if;
end $$;
```

- [ ] **Step 2: Confirm the census is NOT touched**

Do not edit `app/lib/security/tenant-tables.ts`. Verify (read-only) that `seo_page`, `seo_settings`, and `seo_ai_crawl_daily` are absent from it — that is the precedent `seo_ranking` and `seo_google_credential` follow.

- [ ] **Step 3: Commit the migration**

```bash
git add supabase/migrations/20260707120000_seo_search_console.sql
git commit -m "seo: add seo_ranking + seo_settings GSC columns + seo_google_credential secret table"
```

- [ ] **Step 4: Apply the migration to prod** (OUTWARD, hard-to-reverse — confirm before running)

Writes to prod Supabase `ajgrmnvzxfxxlwrxcgnu`. Apply via the supabase MCP `mcp__supabase__apply_migration` with name `seo_search_console` and the SQL from Step 1. Then confirm via `mcp__supabase__execute_sql`:

```sql
select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('seo_ranking','seo_google_credential');
select count(*) as cred_policies from pg_policies where schemaname='public' and tablename='seo_google_credential';
select grantee from information_schema.role_table_grants where table_schema='public' and table_name='seo_google_credential';
```
Expected: both tables `rowsecurity = true`; `cred_policies = 0`; the grantee list for `seo_google_credential` contains only the table owner / service role, never `app_web` or `anon`.

Note: apply before deploying C2-C5. The GSC module reads these tables directly.

---

### Task C2: `google-search-console.server.ts` (OAuth + sync + analyzers)

**Files:**
- Create: `app/lib/seo/google-search-console.server.ts`
- Test: `app/lib/seo/__tests__/google-search-console.server.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` (`~/lib/crypto.server`); `getSupabase` (`~/lib/supabase.server`); `publicBaseUrl` (`~/lib/dashboard/http.server`); `tenantDomain` (`~/lib/storefront/vercel-domain.server`).
- Produces: everything in the shared contract's `google-search-console.server.ts` block.

Design mirrors `app/lib/google/oauth.server.ts`: pure helpers take an injected fetcher so URL building, token parsing, and analytics parsing are unit-testable without network; the DB-writing orchestrators (`exchangeAndStore`, `syncRankings`, `disconnect`) compose those with the real `fetch` + Supabase. Non-uuid (demo) shops never touch the DB (mirrors `seo-store.server.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/google-search-console.server.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deterministic, offline crypto: encrypt/decrypt round-trips without a real key.
vi.mock("../../crypto.server", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
}));
vi.mock("../../dashboard/http.server", () => ({ publicBaseUrl: () => "https://calderyncompany.com" }));
vi.mock("../../storefront/vercel-domain.server", () => ({ tenantDomain: (slug: string) => `${slug}.calderyncompany.com` }));

// Chainable Supabase fake: records upserts/deletes into an in-memory store and
// answers selects. Mirrors the seo-store.server test idiom.
type Row = Record<string, unknown>;
const store: Record<string, Row[]> = { seo_settings: [], seo_google_credential: [], seo_ranking: [], shops: [] };
let forcedError: { message: string } | null = null;
const matches = (row: Row, f: Record<string, unknown>) => Object.entries(f).every(([k, v]) => row[k] === v);

function tableApi(table: string) {
  const filters: Record<string, unknown> = {};
  const gte: { col?: string; val?: string } = {};
  const api: Record<string, unknown> = {
    select() { return api; },
    eq(c: string, v: unknown) { filters[c] = v; return api; },
    gte(c: string, v: string) { gte.col = c; gte.val = v; return api; },
    async maybeSingle() { return { data: store[table].filter((r) => matches(r, filters))[0] ?? null, error: forcedError }; },
    async upsert(rows: Row | Row[], opts: { onConflict: string }) {
      const keys = opts.onConflict.split(",");
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        store[table] = store[table].filter((r) => !keys.every((k) => r[k] === row[k]));
        store[table].push(row);
      }
      return { error: forcedError };
    },
    delete() { return { eq(c: string, v: unknown) { store[table] = store[table].filter((r) => r[c] !== v); return { error: forcedError }; } }; },
    then(resolve: (v: { data: Row[]; error: unknown }) => void) {
      let rows = store[table].filter((r) => matches(r, filters));
      if (gte.col) rows = rows.filter((r) => String(r[gte.col as string]) >= String(gte.val));
      resolve({ data: rows, error: forcedError });
    },
  };
  return api;
}
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => tableApi(t) }) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import * as gsc from "../google-search-console.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  store.seo_settings = []; store.seo_google_credential = []; store.seo_ranking = [];
  store.shops = [{ id: SHOP, org_slug: "ember" }];
  forcedError = null;
  process.env.GOOGLE_ADS_CLIENT_ID = "cid";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
  delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("dormancy — buildConnectUrl / gscConfigured", () => {
  it("returns null when the OAuth client env is missing (no throw)", () => {
    delete process.env.GOOGLE_ADS_CLIENT_ID;
    delete process.env.GOOGLE_ADS_CLIENT_SECRET;
    expect(gsc.gscConfigured()).toBe(false);
    expect(gsc.buildConnectUrl(SHOP, "state123")).toBeNull();
  });
  it("builds a consent URL for the webmasters.readonly scope with offline access", () => {
    const url = gsc.buildConnectUrl(SHOP, "state123");
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth?");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fcalderyncompany.com%2Fdashboard%2Fauth%2Fgsc%2Fcallback");
    expect(url).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fwebmasters.readonly");
    expect(url).toContain("state=state123");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
  });
});

describe("exchangeCodeForRefreshToken", () => {
  it("POSTs an authorization_code grant and returns the refresh token", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ access_token: "at", refresh_token: "rt", expires_in: 3599 });
    const rt = await gsc.exchangeCodeForRefreshToken(fetcher, { clientId: "cid", clientSecret: "s", redirectUri: "r", code: "abc" });
    expect(rt).toBe("rt");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code=abc");
  });
  it("throws when Google omits the refresh_token (silent re-consent)", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ access_token: "at" });
    await expect(gsc.exchangeCodeForRefreshToken(fetcher, { clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }))
      .rejects.toThrow(/no refresh_token/i);
  });
});

describe("parseAnalyticsRows / summariseGoogleCard / detectSlips", () => {
  const rows = [
    { keys: ["2026-06-01", "cedar candle", "https://ember.calderyncompany.com/storefront/products/cedar"], clicks: 5, impressions: 100, ctr: 0.05, position: 4 },
    { keys: ["2026-06-20", "cedar candle", "https://ember.calderyncompany.com/storefront/products/cedar"], clicks: 2, impressions: 90, ctr: 0.02, position: 12 },
    { keys: ["2026-06-20", "soy candle", "https://ember.calderyncompany.com/storefront/products/cedar"], clicks: 9, impressions: 300, ctr: 0.03, position: 3 },
  ];
  it("parseAnalyticsRows maps the [date, query, page] key tuple", () => {
    const parsed = gsc.parseAnalyticsRows({ rows });
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ capturedDate: "2026-06-01", query: "cedar candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/cedar", position: 4, impressions: 100, clicks: 5, ctr: 0.05 });
  });
  it("parseAnalyticsRows throws on an API error body (never swallows)", () => {
    expect(() => gsc.parseAnalyticsRows({ error: { message: "rateLimitExceeded" } })).toThrow(/rateLimitExceeded/);
  });
  it("summariseGoogleCard totals clicks/impressions and picks the top query by clicks", () => {
    const card = gsc.summariseGoogleCard(gsc.parseAnalyticsRows({ rows }));
    expect(card.clicks).toBe(16);
    expect(card.impressions).toBe(490);
    expect(card.topQuery).toBe("soy candle"); // 9 clicks beats cedar candle's 7
    expect(card.topPosition).toBe(3);
  });
  it("detectSlips flags a query whose position worsened by >= threshold", () => {
    const slips = gsc.detectSlips(gsc.parseAnalyticsRows({ rows }), 5);
    expect(slips).toHaveLength(1); // cedar candle 4 -> 12 (+8); soy candle single-day is ignored
    expect(slips[0]).toMatchObject({ query: "cedar candle", fromPosition: 4, toPosition: 12, delta: 8 });
  });
});

describe("orchestrators (mocked Supabase + stubbed fetch)", () => {
  it("exchangeAndStore encrypts the refresh token into the secret table and flips gsc_connected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3599 }) }));
    await gsc.exchangeAndStore(SHOP, "authcode");
    expect(store.seo_google_credential).toEqual([
      expect.objectContaining({ shop_id: SHOP, refresh_token_encrypted: "enc(rt)" }),
    ]);
    const settings = store.seo_settings.find((r) => r.shop_id === SHOP);
    expect(settings).toMatchObject({ gsc_connected: true, gsc_site_url: "https://ember.calderyncompany.com/" });
  });
  it("getGscState reflects the stored settings; defaults for a non-uuid shop", async () => {
    store.seo_settings.push({ shop_id: SHOP, gsc_connected: true, gsc_site_url: "https://ember.calderyncompany.com/" });
    expect(await gsc.getGscState(SHOP)).toEqual({ connected: true, siteUrl: "https://ember.calderyncompany.com/" });
    expect(await gsc.getGscState("demo-shop")).toEqual({ connected: false, siteUrl: null });
  });
  it("fetchSearchAnalytics decrypts the token, gets an access token, and returns parsed rows", async () => {
    store.seo_google_credential.push({ shop_id: SHOP, refresh_token_encrypted: "enc(rt)" });
    store.seo_settings.push({ shop_id: SHOP, gsc_connected: true, gsc_site_url: "https://ember.calderyncompany.com/" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ access_token: "at" }) })                       // refresh -> access
      .mockResolvedValueOnce({ json: async () => ({ rows: [{ keys: ["2026-06-20", "q", "https://ember.calderyncompany.com/storefront/products/cedar"], clicks: 1, impressions: 2, ctr: 0.5, position: 6 }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await gsc.fetchSearchAnalytics(SHOP);
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("q");
    // Second call hits the tenant's Search Analytics endpoint with a Bearer token.
    const [analyticsUrl, init] = fetchMock.mock.calls[1];
    expect(analyticsUrl).toContain("/webmasters/v3/sites/");
    expect(init.headers.authorization).toBe("Bearer at");
  });
  it("fetchSearchAnalytics returns [] when the shop has no stored credential", async () => {
    expect(await gsc.fetchSearchAnalytics(SHOP)).toEqual([]);
  });
  it("syncRankings upserts idempotently on (shop, query, page, date)", async () => {
    store.seo_google_credential.push({ shop_id: SHOP, refresh_token_encrypted: "enc(rt)" });
    store.seo_settings.push({ shop_id: SHOP, gsc_connected: true, gsc_site_url: "https://ember.calderyncompany.com/" });
    const analyticsBody = { rows: [{ keys: ["2026-06-20", "q", "https://ember.calderyncompany.com/storefront/products/cedar"], clicks: 1, impressions: 2, ctr: 0.5, position: 6 }] };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValue({ json: async () => ({ access_token: "at" }) })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "at" }) })
      .mockResolvedValueOnce({ json: async () => analyticsBody })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "at" }) })
      .mockResolvedValueOnce({ json: async () => analyticsBody }));
    const first = await gsc.syncRankings(SHOP);
    expect(first.upserted).toBe(1);
    const second = await gsc.syncRankings(SHOP);
    expect(second.upserted).toBe(1);
    expect(store.seo_ranking).toHaveLength(1); // replaced on the conflict key, not duplicated
  });
  it("disconnect deletes the credential and clears gsc_connected", async () => {
    store.seo_google_credential.push({ shop_id: SHOP, refresh_token_encrypted: "enc(rt)" });
    store.seo_settings.push({ shop_id: SHOP, gsc_connected: true, gsc_site_url: "https://ember.calderyncompany.com/" });
    await gsc.disconnect(SHOP);
    expect(store.seo_google_credential).toHaveLength(0);
    expect(store.seo_settings.find((r) => r.shop_id === SHOP)).toMatchObject({ gsc_connected: false, gsc_site_url: null });
  });
  it("listConnectedShopIds returns only connected shops", async () => {
    store.seo_settings.push({ shop_id: SHOP, gsc_connected: true }, { shop_id: "22222222-2222-3333-4444-555555555555", gsc_connected: false });
    expect(await gsc.listConnectedShopIds()).toEqual([SHOP]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/google-search-console.server.test.ts`
Expected: FAIL (`Cannot find module '../google-search-console.server'`).

- [ ] **Step 3: Implement `google-search-console.server.ts`**

```ts
// app/lib/seo/google-search-console.server.ts
// Google Search Console rankings loop. Reuses the repo's verified Google data
// OAuth client (GOOGLE_ADS_CLIENT_ID/SECRET, overridable via
// GOOGLE_SEARCH_CONSOLE_*) and adds the read-only Search Console scope. The
// merchant's refresh token is stored ENCRYPTED in seo_google_credential (a
// deny-all secret table); only this service-role module reads it. Pure helpers
// take an injected fetcher so token/analytics parsing is unit-testable offline.
import { getSupabase } from "~/lib/supabase.server";
import { encrypt, decrypt } from "~/lib/crypto.server";
import { publicBaseUrl } from "~/lib/dashboard/http.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_DAYS = 30;   // pull window; wide enough to hold slip history
const CARD_WINDOW_DAYS = 28;
const SLIP_THRESHOLD = 5; // positions a query must drop to count as slipping

export interface RankingRow {
  query: string;
  pageUrl: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  capturedDate: string;
}
export interface GscState { connected: boolean; siteUrl: string | null }
export interface GoogleCardVM {
  connected: boolean;
  clicks: number;
  impressions: number;
  topQuery: string | null;
  topPosition: number | null;
}
export interface RankingSlip { pageUrl: string; query: string; fromPosition: number; toPosition: number; delta: number }

export type GoogleTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
export type TokenFetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<GoogleTokenResponse>;
export interface GscAnalyticsRow { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }
export interface GscAnalyticsResponse { rows?: GscAnalyticsRow[]; error?: { message?: string } }
export type AnalyticsFetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<GscAnalyticsResponse>;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

// --- env gating (dormancy) -------------------------------------------------
function gscClientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID ?? process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET ?? process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
export function gscConfigured(): boolean {
  return gscClientCreds() !== null;
}
export function gscRedirectUri(): string {
  return `${publicBaseUrl()}/dashboard/auth/gsc/callback`;
}

// --- connect ---------------------------------------------------------------
export function buildConnectUrl(shopId: string, state: string): string | null {
  const creds = gscClientCreds();
  if (!creds) {
    console.warn(`[seo/gsc] connect requested for shop ${shopId} but Google OAuth is not configured`);
    return null;
  }
  const p = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: gscRedirectUri(),
    response_type: "code",
    scope: GSC_SCOPE,
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export async function exchangeCodeForRefreshToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    grant_type: "authorization_code",
  }).toString();
  const res = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (res.error || !res.access_token) {
    throw new Error(`Google OAuth error: ${res.error_description ?? res.error ?? "no access_token returned"}`);
  }
  if (!res.refresh_token) {
    throw new Error("Google OAuth returned no refresh_token; re-consent with access_type=offline & prompt=consent");
  }
  return res.refresh_token;
}

export async function exchangeRefreshForAccess(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (res.error || !res.access_token) {
    throw new Error(`Google OAuth token exchange failed (${res.error ?? "unknown"}): ${res.error_description ?? res.error ?? "no access_token"}`);
  }
  return res.access_token;
}

const realTokenFetcher: TokenFetcher = (url, init) => fetch(url, init).then((r) => r.json()) as Promise<GoogleTokenResponse>;
const realAnalyticsFetcher: AnalyticsFetcher = (url, init) => fetch(url, init).then((r) => r.json()) as Promise<GscAnalyticsResponse>;

// The Search Console property for a shop is its storefront origin (URL-prefix
// form). Resolved from shops.org_slug so we never call the overview module
// (which imports this one) and never hard-code a host.
async function siteUrlForShop(shopId: string): Promise<string> {
  const { data, error } = await getSupabase().from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (error) throw error;
  const slug = typeof data?.org_slug === "string" ? data.org_slug.trim() : "";
  return slug ? `https://${tenantDomain(slug)}/` : "";
}

export async function exchangeAndStore(shopId: string, code: string): Promise<void> {
  const creds = gscClientCreds();
  if (!creds) throw new Error("Google OAuth is not configured");
  const refreshToken = await exchangeCodeForRefreshToken(realTokenFetcher, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: gscRedirectUri(),
    code,
  });
  const sb = getSupabase();
  const now = new Date().toISOString();
  const { error: credErr } = await sb
    .from("seo_google_credential")
    .upsert({ shop_id: shopId, refresh_token_encrypted: encrypt(refreshToken), updated_at: now }, { onConflict: "shop_id" });
  if (credErr) throw credErr;
  const siteUrl = await siteUrlForShop(shopId);
  const { error: setErr } = await sb
    .from("seo_settings")
    .upsert({ shop_id: shopId, gsc_connected: true, gsc_site_url: siteUrl, updated_at: now }, { onConflict: "shop_id" });
  if (setErr) throw setErr;
}

export async function disconnect(shopId: string): Promise<void> {
  const sb = getSupabase();
  const { error: delErr } = await sb.from("seo_google_credential").delete().eq("shop_id", shopId);
  if (delErr) throw delErr;
  const { error: setErr } = await sb
    .from("seo_settings")
    .upsert({ shop_id: shopId, gsc_connected: false, gsc_site_url: null, updated_at: new Date().toISOString() }, { onConflict: "shop_id" });
  if (setErr) throw setErr;
}

// --- state reads -----------------------------------------------------------
export async function getGscState(shopId: string): Promise<GscState> {
  if (!UUID_RE.test(shopId)) return { connected: false, siteUrl: null };
  const { data, error } = await getSupabase().from("seo_settings").select("gsc_connected, gsc_site_url").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  return { connected: data?.gsc_connected === true, siteUrl: (data?.gsc_site_url as string | null) ?? null };
}

export async function listConnectedShopIds(): Promise<string[]> {
  const { data, error } = await getSupabase().from("seo_settings").select("shop_id").eq("gsc_connected", true);
  if (error) throw error;
  return (data ?? []).map((r) => String((r as { shop_id: string }).shop_id));
}

// --- sync ------------------------------------------------------------------
export function parseAnalyticsRows(resp: GscAnalyticsResponse): RankingRow[] {
  if (resp.error) throw new Error(`Search Console API error: ${resp.error.message ?? "unknown"}`);
  const out: RankingRow[] = [];
  for (const r of resp.rows ?? []) {
    const keys = r.keys ?? [];
    if (keys.length < 3) continue; // dimensions = [date, query, page]
    out.push({
      capturedDate: keys[0],
      query: keys[1],
      pageUrl: keys[2],
      position: Number(r.position ?? 0),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      ctr: Number(r.ctr ?? 0),
    });
  }
  return out;
}

export async function fetchAnalyticsWith(
  fetcher: AnalyticsFetcher,
  opts: { accessToken: string; siteUrl: string; startDate: string; endDate: string },
): Promise<RankingRow[]> {
  const url = `${GSC_API_BASE}/sites/${encodeURIComponent(opts.siteUrl)}/searchAnalytics/query`;
  const resp = await fetcher(url, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: opts.startDate, endDate: opts.endDate, dimensions: ["date", "query", "page"], rowLimit: 1000 }),
  });
  return parseAnalyticsRows(resp);
}

export async function fetchSearchAnalytics(shopId: string): Promise<RankingRow[]> {
  const creds = gscClientCreds();
  if (!creds) return [];
  const sb = getSupabase();
  const { data: cred, error: credErr } = await sb
    .from("seo_google_credential")
    .select("refresh_token_encrypted")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (credErr) throw credErr;
  const enc = (cred as { refresh_token_encrypted?: string } | null)?.refresh_token_encrypted;
  if (!enc) return [];
  const state = await getGscState(shopId);
  if (!state.siteUrl) return [];
  const refreshToken = decrypt(enc);
  const accessToken = await exchangeRefreshForAccess(realTokenFetcher, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken,
  });
  return fetchAnalyticsWith(realAnalyticsFetcher, {
    accessToken,
    siteUrl: state.siteUrl,
    startDate: ymd(new Date(Date.now() - WINDOW_DAYS * 86_400_000)),
    endDate: ymd(new Date()),
  });
}

export async function syncRankings(shopId: string): Promise<{ upserted: number }> {
  const rows = await fetchSearchAnalytics(shopId);
  if (rows.length === 0) return { upserted: 0 };
  const payload = rows.map((r) => ({
    shop_id: shopId,
    query: r.query,
    page_url: r.pageUrl,
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    captured_date: r.capturedDate,
    source: "search_console",
  }));
  const { error } = await getSupabase().from("seo_ranking").upsert(payload, { onConflict: "shop_id,query,page_url,captured_date" });
  if (error) throw error;
  return { upserted: payload.length };
}

export async function getRankingsSince(shopId: string, sinceDate: string): Promise<RankingRow[]> {
  if (!UUID_RE.test(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("seo_ranking")
    .select("query, page_url, position, impressions, clicks, ctr, captured_date")
    .eq("shop_id", shopId)
    .gte("captured_date", sinceDate);
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      query: String(row.query),
      pageUrl: String(row.page_url),
      position: Number(row.position ?? 0),
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      ctr: Number(row.ctr ?? 0),
      capturedDate: String(row.captured_date),
    };
  });
}

// --- pure analyzers --------------------------------------------------------
export function summariseGoogleCard(rows: RankingRow[]): { clicks: number; impressions: number; topQuery: string | null; topPosition: number | null } {
  let clicks = 0;
  let impressions = 0;
  const byQuery = new Map<string, { clicks: number; posSum: number; n: number }>();
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    const q = byQuery.get(r.query) ?? { clicks: 0, posSum: 0, n: 0 };
    q.clicks += r.clicks;
    q.posSum += r.position;
    q.n += 1;
    byQuery.set(r.query, q);
  }
  let topQuery: string | null = null;
  let topClicks = -1;
  let topPosition: number | null = null;
  for (const [q, agg] of byQuery) {
    if (agg.clicks > topClicks) {
      topClicks = agg.clicks;
      topQuery = q;
      topPosition = agg.n ? Math.round((agg.posSum / agg.n) * 10) / 10 : null;
    }
  }
  return { clicks, impressions, topQuery, topPosition };
}

export function detectSlips(rows: RankingRow[], threshold = SLIP_THRESHOLD): RankingSlip[] {
  const groups = new Map<string, RankingRow[]>();
  for (const r of rows) {
    const k = `${r.pageUrl} ${r.query}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  const slips: RankingSlip[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue; // need at least two captures to measure movement
    const sorted = [...g].sort((a, b) => (a.capturedDate < b.capturedDate ? -1 : a.capturedDate > b.capturedDate ? 1 : 0));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const delta = last.position - first.position; // positive = dropped down the results
    if (delta >= threshold) {
      slips.push({ pageUrl: last.pageUrl, query: last.query, fromPosition: first.position, toPosition: last.position, delta });
    }
  }
  return slips.sort((a, b) => b.delta - a.delta);
}

export const RANKING_CARD_WINDOW_DAYS = CARD_WINDOW_DAYS;
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/google-search-console.server.test.ts`
Expected: PASS (all cases). If `syncRankings` idempotency fails, confirm the fake's `upsert` filters on every `onConflict` key before pushing.

- [ ] **Step 5: Add the env keys to `.env.example`**

Append under the existing Google block in `.env.example` (documentation only, no secret values):

```
# Google Search Console (cron.seo-rankings). Reuses the verified GOOGLE_ADS_*
# OAuth client by default; set these only to point Search Console at a different
# Google Cloud OAuth client. The client's consent screen must include the scope
# https://www.googleapis.com/auth/webmasters.readonly and its authorized redirect
# URIs must include ${DASHBOARD_PUBLIC_URL}/dashboard/auth/gsc/callback.
GOOGLE_SEARCH_CONSOLE_CLIENT_ID=
GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET=
```

- [ ] **Step 6: Commit**

```bash
git add app/lib/seo/google-search-console.server.ts app/lib/seo/__tests__/google-search-console.server.test.ts .env.example
git commit -m "seo: add Google Search Console OAuth + rankings sync module"
```

---

### Task C3: Connect flow — API actions + callback route + browser client + Search.tsx button

**Files:**
- Modify: `app/routes/dashboard.api.search.tsx` (add `connectGoogle` / `disconnectGoogle` actions)
- Create: `app/routes/dashboard.auth.gsc_.callback.tsx`
- Modify: `app/lib/dashboard/search-client.ts` (add the two client calls + `GoogleCardVM` + `google` on the VM mirror)
- Modify: `app/lib/seo/overview.server.ts` (add `google: { connected }` to `buildSeoOverview` so the card can render its connect state)
- Modify: `app/components/dashboard/screens/Search.tsx` ("On Google" card: connect when disconnected, "Connected" + Disconnect when connected)
- Modify: `app/routes/__tests__/dashboard.api.search.test.ts` (add the two actions)
- Modify: `app/lib/seo/__tests__/overview.server.test.ts` (mock the GSC module; assert `google.connected`)
- Test: `app/components/dashboard/screens/__tests__/search-google-card.test.tsx`

**Interfaces:**
- Consumes: `createOAuthState` (`~/lib/meta/oauth-state.server`); `buildConnectUrl`, `disconnect`, `getGscState` (C2); `consumeOAuthState`, `exchangeAndStore` (C2 + oauth-state); `getSupabase`; `publicBaseUrl`.
- Produces: the `connectGoogle` / `disconnectGoogle` actions; the `/dashboard/auth/gsc/callback` loader; `connectGoogleSearchConsole` / `disconnectGoogleSearchConsole`; the `google` field on `SeoOverviewVM` (connect-state only; numbers arrive in C5).

- [ ] **Step 1: Add the two actions to `dashboard.api.search.tsx`**

Add imports at the top:

```ts
import { getSupabase } from "~/lib/supabase.server";
import { createOAuthState } from "~/lib/meta/oauth-state.server";
import { buildConnectUrl, disconnect as disconnectGsc } from "~/lib/seo/google-search-console.server";
```

Add two `case` arms to the `switch (body.action)` in `action`, before `default`:

```ts
    case "connectGoogle": {
      // Mint a single-use CSRF nonce bound to this shop; the callback consumes it.
      const state = await createOAuthState(getSupabase(), session.shopId, { dashboard: true });
      const url = buildConnectUrl(session.shopId, state);
      if (!url) return jsonError(503, "google_unavailable", "Google connection is not configured");
      return dashboardJson(async () => ({ url }));
    }
    case "disconnectGoogle": {
      return dashboardJson(async () => {
        await disconnectGsc(session.shopId);
        return { ok: true };
      });
    }
```

- [ ] **Step 2: Create the callback route `dashboard.auth.gsc_.callback.tsx`**

```ts
// app/routes/dashboard.auth.gsc_.callback.tsx
// Google Search Console OAuth callback. Validates the single-use CSRF nonce,
// exchanges the code for a refresh token (stored encrypted), then returns the
// merchant to the dashboard. Mirrors app/routes/auth.google.$.tsx: the nonce is
// the authenticator because the redirect arrives from Google's domain without a
// dashboard session cookie.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { consumeOAuthState } from "~/lib/meta/oauth-state.server";
import { exchangeAndStore } from "~/lib/seo/google-search-console.server";
import { publicBaseUrl } from "~/lib/dashboard/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  // Absolute base: this callback runs on the app origin; the dashboard SPA reads
  // ?search=connected|error the same way it reads ?google=connected.
  const base = publicBaseUrl();
  const sb = getSupabase();

  if (!code || !state) return redirect(`${base}/dashboard?search=error&reason=missing_params`);

  let shopId: string | null;
  try {
    shopId = await consumeOAuthState(sb, state);
  } catch {
    shopId = null;
  }
  if (!shopId) return redirect(`${base}/dashboard?search=error&reason=bad_state`);

  try {
    await exchangeAndStore(shopId, code);
  } catch (err) {
    console.error("[seo/gsc] callback exchange failed", err);
    return redirect(`${base}/dashboard?search=error&reason=exchange_failed`);
  }
  return redirect(`${base}/dashboard?search=connected`);
}
```

(Route filename `dashboard.auth.gsc_.callback.tsx` maps to `/dashboard/auth/gsc/callback`, matching the existing `dashboard.auth.google_.callback.tsx` escaping convention. Register this exact path as an authorized redirect URI on the Google OAuth client — external, see Known dependency.)

- [ ] **Step 3: Add the browser client calls**

In `app/lib/dashboard/search-client.ts`, add the `GoogleCardVM` interface, add `google` to `SeoOverviewVM`, and add the two calls:

```ts
export interface GoogleCardVM {
  connected: boolean;
  clicks: number;
  impressions: number;
  topQuery: string | null;
  topPosition: number | null;
}
```

Add `google: GoogleCardVM;` to the `SeoOverviewVM` interface. Then, next to the other exports:

```ts
export const connectGoogleSearchConsole = () =>
  apiSend<{ url: string }>("POST", "/dashboard/api/search", { action: "connectGoogle" });

export const disconnectGoogleSearchConsole = () =>
  apiSend<{ ok: true }>("POST", "/dashboard/api/search", { action: "disconnectGoogle" });
```

- [ ] **Step 4: Add `google: { connected }` to `buildSeoOverview`**

In `app/lib/seo/overview.server.ts`, add the import:

```ts
import { getGscState, type GoogleCardVM } from "./google-search-console.server";
```

Add `google: GoogleCardVM;` to the `SeoOverviewVM` interface. In `buildSeoOverview`, add `getGscState(shopId)` to the existing `Promise.all` destructure and return the connect-state card (numbers are filled in C5):

```ts
  const [products, overrides, settings, crawls, store, gsc] = await Promise.all([
    getCatalog().listProducts(shopId),
    listSeoOverrides(shopId),
    getSeoSettings(shopId),
    summariseAiCrawls(shopId),
    getStoreSettings(shopId),
    getGscState(shopId),
  ]);
```

and in the returned object add:

```ts
    google: { connected: gsc.connected, clicks: 0, impressions: 0, topQuery: null, topPosition: null },
```

- [ ] **Step 5: Wire the "On Google" card in `Search.tsx`**

Add to the imports from `search-client`:

```ts
  connectGoogleSearchConsole,
  disconnectGoogleSearchConsole,
```

Inside the `Search` component (which already destructures `{ app }`), add local state + handlers above the `return`:

```ts
  const [gscBusy, setGscBusy] = useState(false);

  async function onConnectGoogle() {
    setGscBusy(true);
    try {
      const { url } = await connectGoogleSearchConsole();
      window.location.assign(url); // leave the SPA for Google's consent screen
    } catch {
      app.toast("Could not start the Google connection", "warn", "critical");
      setGscBusy(false);
    }
  }

  async function onDisconnectGoogle() {
    setGscBusy(true);
    try {
      await disconnectGoogleSearchConsole();
      app.toast("Disconnected from Google.", "check");
      refresh();
    } catch {
      app.toast("Could not disconnect", "warn", "critical");
    } finally {
      setGscBusy(false);
    }
  }
```

Replace the "On Google" card's footer (the current `<div className="cd-seo__card-foot">` block with the disabled button + "Coming soon") with:

```tsx
              <div className="cd-seo__card-foot">
                {data.google.connected ? (
                  <>
                    <span className="cd-seo__soon">Connected</span>
                    <Btn kind="secondary" small onClick={onDisconnectGoogle} disabled={gscBusy}>
                      Disconnect
                    </Btn>
                  </>
                ) : (
                  <Btn kind="secondary" small onClick={onConnectGoogle} disabled={gscBusy}>
                    Connect Google
                  </Btn>
                )}
              </div>
```

(The card's `cd-seo__card-sub` copy stays as-is for now; C5 replaces it with real numbers when connected.)

- [ ] **Step 6: Extend the API route test**

In `app/routes/__tests__/dashboard.api.search.test.ts`, extend the `vi.hoisted` block with two spies and add mocks for the new modules, then add two cases. Add to the hoisted object:

```ts
  createOAuthStateMock: vi.fn().mockResolvedValue("nonce-state"),
  buildConnectUrlMock: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?state=nonce-state"),
  disconnectGscMock: vi.fn().mockResolvedValue(undefined),
```

Add the mocks (after the existing `vi.mock` calls):

```ts
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("~/lib/meta/oauth-state.server", () => ({ createOAuthState: createOAuthStateMock }));
vi.mock("~/lib/seo/google-search-console.server", () => ({ buildConnectUrl: buildConnectUrlMock, disconnect: disconnectGscMock }));
```

Add the cases inside `describe("dashboard.api.search action", ...)`:

```ts
  it("connectGoogle mints a CSRF state and returns the consent URL", async () => {
    const res = (await action({ request: req({ action: "connectGoogle" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(createOAuthStateMock).toHaveBeenCalledWith(expect.anything(), "shop1", { dashboard: true });
    expect((await res.json()).url).toContain("accounts.google.com");
  });
  it("connectGoogle 503s when Google is not configured (buildConnectUrl null)", async () => {
    buildConnectUrlMock.mockReturnValueOnce(null);
    const res = (await action({ request: req({ action: "connectGoogle" }) } as never)) as Response;
    expect(res.status).toBe(503);
  });
  it("disconnectGoogle clears the connection for the session shop", async () => {
    const res = (await action({ request: req({ action: "disconnectGoogle" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(disconnectGscMock).toHaveBeenCalledWith("shop1");
  });
```

- [ ] **Step 7: Update the overview test for the new mock + field**

In `app/lib/seo/__tests__/overview.server.test.ts`, add a mock for the GSC module (near the other `vi.mock` calls):

```ts
vi.mock("../google-search-console.server", () => ({
  getGscState: async () => ({ connected: false, siteUrl: null }),
  getRankingsSince: async () => [],
  summariseGoogleCard: () => ({ clicks: 0, impressions: 0, topQuery: null, topPosition: null }),
  detectSlips: () => [],
}));
```

Add an assertion in the `buildSeoOverview` describe block:

```ts
  it("includes a disconnected Google card by default", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.google).toEqual({ connected: false, clicks: 0, impressions: 0, topQuery: null, topPosition: null });
  });
```

- [ ] **Step 8: Write the Search.tsx card smoke test**

```tsx
// app/components/dashboard/screens/__tests__/search-google-card.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Seed the screen cache so the SSR render paints the overview (effects don't run
// server-side); mock the data layer so no network is touched.
const overview = {
  storeHealth: 90, productCount: 2, needsAttention: [], aiCrawls: [], aiCrawlTotal: 0,
  settings: { allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null },
  google: { connected: false, clicks: 0, impressions: 0, topQuery: null, topPosition: null },
};
let seeded = overview;
vi.mock("~/lib/dashboard/screen-cache", () => ({
  cachedScreenData: () => seeded,
  cacheScreenData: () => {},
  SCREEN_CACHE_KEYS: { search: "search" },
}));
vi.mock("~/lib/dashboard/search-client", () => ({
  fetchSearch: async () => seeded,
  loadProductDetail: async () => ({}),
  saveOverride: async () => ({ ok: true }),
  resetOverride: async () => ({ ok: true }),
  updateSettings: async () => ({ settings: seeded.settings }),
  connectGoogleSearchConsole: async () => ({ url: "https://accounts.google.com/x" }),
  disconnectGoogleSearchConsole: async () => ({ ok: true }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search from "../Search";
// eslint-disable-next-line import/first -- see above
import type { DashboardCtx } from "../../context";

function makeApp(): DashboardCtx {
  return { toast: () => {}, refresh: () => {} } as unknown as DashboardCtx;
}

beforeEach(() => { seeded = overview; });

describe("Search 'On Google' card", () => {
  it("shows a Connect Google button when not connected", () => {
    const html = renderToStaticMarkup(h(Search, { app: makeApp() }));
    expect(html).toContain("Connect Google");
    expect(html).not.toContain("Disconnect");
  });
  it("shows Connected + Disconnect when connected", () => {
    seeded = { ...overview, google: { ...overview.google, connected: true } };
    const html = renderToStaticMarkup(h(Search, { app: makeApp() }));
    expect(html).toContain("Disconnect");
  });
});
```

- [ ] **Step 9: Run the tests, verify they pass**

Run: `npx vitest run app/routes/__tests__/dashboard.api.search.test.ts app/lib/seo/__tests__/overview.server.test.ts app/components/dashboard/screens/__tests__/search-google-card.test.tsx`
Expected: PASS. Then `npm run typecheck` -> exit 0 (the route + client + Search edits are type-checked together).

- [ ] **Step 10: Commit**

```bash
git add app/routes/dashboard.api.search.tsx app/routes/dashboard.auth.gsc_.callback.tsx \
  app/lib/dashboard/search-client.ts app/lib/seo/overview.server.ts \
  app/components/dashboard/screens/Search.tsx \
  app/routes/__tests__/dashboard.api.search.test.ts app/lib/seo/__tests__/overview.server.test.ts \
  app/components/dashboard/screens/__tests__/search-google-card.test.tsx
git commit -m "seo: wire Google Search Console connect/disconnect into the Search screen"
```

---

### Task C4: Daily cron — `cron.seo-rankings.tsx`

**Files:**
- Create: `app/routes/cron.seo-rankings.tsx`
- Test: `app/routes/__tests__/cron.seo-rankings.test.ts`
- Modify: `vercel.json` (add the cron schedule)

**Interfaces:**
- Consumes: `isAuthorizedCron` (`~/lib/cron-auth.server`); `listConnectedShopIds`, `syncRankings` (C2).
- Produces: the `/cron/seo-rankings` loader (Bearer `CRON_SECRET`, per-shop failure isolation, JSON summary).

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/cron.seo-rankings.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { isAuthorizedCronMock, listConnectedShopIdsMock, syncRankingsMock } = vi.hoisted(() => ({
  isAuthorizedCronMock: vi.fn(),
  listConnectedShopIdsMock: vi.fn(),
  syncRankingsMock: vi.fn(),
}));

vi.mock("~/lib/cron-auth.server", () => ({ isAuthorizedCron: isAuthorizedCronMock }));
vi.mock("~/lib/seo/google-search-console.server", () => ({
  listConnectedShopIds: listConnectedShopIdsMock,
  syncRankings: syncRankingsMock,
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { loader } from "../cron.seo-rankings";

function req() {
  return new Request("https://app.x/cron/seo-rankings", { headers: { authorization: "Bearer test" } });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("cron.seo-rankings", () => {
  it("401s when the bearer check fails", async () => {
    isAuthorizedCronMock.mockReturnValue(false);
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(401);
    expect(listConnectedShopIdsMock).not.toHaveBeenCalled();
  });

  it("syncs every connected shop and returns a summary", async () => {
    isAuthorizedCronMock.mockReturnValue(true);
    listConnectedShopIdsMock.mockResolvedValue(["s1", "s2"]);
    syncRankingsMock.mockResolvedValueOnce({ upserted: 3 }).mockResolvedValueOnce({ upserted: 0 });
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toEqual([{ shopId: "s1", upserted: 3 }, { shopId: "s2", upserted: 0 }]);
    expect(body.errors).toEqual([]);
  });

  it("isolates a per-shop failure without aborting the rest", async () => {
    isAuthorizedCronMock.mockReturnValue(true);
    listConnectedShopIdsMock.mockResolvedValue(["s1", "s2"]);
    syncRankingsMock.mockRejectedValueOnce(new Error("token revoked")).mockResolvedValueOnce({ upserted: 1 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await loader({ request: req() } as never)) as Response;
    const body = await res.json();
    expect(body.synced).toEqual([{ shopId: "s2", upserted: 1 }]);
    expect(body.errors).toEqual(["s1: token revoked"]);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.seo-rankings.test.ts`
Expected: FAIL (`Cannot find module '../cron.seo-rankings'`).

- [ ] **Step 3: Implement `cron.seo-rankings.tsx`**

```ts
// app/routes/cron.seo-rankings.tsx
// Daily Google Search Console pull. For each shop that has connected GSC, sync
// its Search Analytics into seo_ranking (idempotent on shop+query+page+date).
// Per-shop failures are isolated so one dead token never aborts the sweep.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { listConnectedShopIds, syncRankings } from "~/lib/seo/google-search-console.server";

interface Summary {
  synced: Array<{ shopId: string; upserted: number }>;
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary: Summary = { synced: [], errors: [] };
  const shopIds = await listConnectedShopIds();

  for (const shopId of shopIds) {
    try {
      const { upserted } = await syncRankings(shopId);
      summary.synced.push({ shopId, upserted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${shopId}: ${message}`);
      console.error(`[cron.seo-rankings] sync failed for ${shopId}`, err);
    }
  }

  return json(summary);
};
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/routes/__tests__/cron.seo-rankings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Schedule the cron in `vercel.json`**

Add one entry to the `crons` array in `vercel.json` (GSC data lags ~2 days; a daily morning pull is ample):

```json
    { "path": "/cron/seo-rankings", "schedule": "0 8 * * *" },
```

- [ ] **Step 6: Commit**

```bash
git add app/routes/cron.seo-rankings.tsx app/routes/__tests__/cron.seo-rankings.test.ts vercel.json
git commit -m "seo: add daily cron.seo-rankings sync of Search Console data"
```

---

### Task C5: Overview integration — Google card numbers + "slipping on Google" rows

**Files:**
- Modify: `app/lib/seo/overview.server.ts` (fill the card + merge slipping product rows)
- Modify: `app/lib/seo/__tests__/overview.server.test.ts` (connected fixture)
- Modify: `app/components/dashboard/screens/Search.tsx` ("On Google" card sub-copy shows real numbers)

**Interfaces:**
- Consumes: `getGscState`, `getRankingsSince`, `summariseGoogleCard`, `detectSlips`, `RANKING_CARD_WINDOW_DAYS` (C2).
- Produces: a populated `google` card and slipping-page entries in `needsAttention` when connected.

- [ ] **Step 1: Update the overview test to the connected shape**

In `app/lib/seo/__tests__/overview.server.test.ts`, replace the GSC mock added in C3 with a connected one that returns two captures of one product's query (a slip), and keep a helper to flip it. Add near the other mocks:

```ts
const rankingRows = [
  { query: "cedar candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/cedar-bloom", position: 3, impressions: 100, clicks: 8, ctr: 0.08, capturedDate: "2026-06-01" },
  { query: "cedar candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/cedar-bloom", position: 11, impressions: 90, clicks: 2, ctr: 0.02, capturedDate: "2026-06-20" },
];
vi.mock("../google-search-console.server", async () => {
  const actual = await vi.importActual<typeof import("../google-search-console.server")>("../google-search-console.server");
  return {
    ...actual, // keep the REAL summariseGoogleCard / detectSlips so the math is exercised
    getGscState: async () => ({ connected: true, siteUrl: "https://ember.calderyncompany.com/" }),
    getRankingsSince: async () => rankingRows,
  };
});
```

Add assertions to the `buildSeoOverview` describe block:

```ts
  it("populates the Google card from seo_ranking when connected", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.google.connected).toBe(true);
    expect(vm.google.clicks).toBe(10);        // 8 + 2
    expect(vm.google.impressions).toBe(190);  // 100 + 90
    expect(vm.google.topQuery).toBe("cedar candle");
  });
  it("adds a slipping product page to needsAttention", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    const slip = vm.needsAttention.find((r) => r.handle === "cedar-bloom");
    expect(slip).toBeTruthy();
    expect(slip?.topIssue).toMatch(/slipping on google/i);
  });
```

(`cedar-bloom` is Product A from the existing fixture, which otherwise scores 100 and would not appear in `needsAttention`; the slip is what surfaces it.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/overview.server.test.ts`
Expected: FAIL (card still returns zeros; no slip row) — proves C1's placeholder is what runs today.

- [ ] **Step 3: Fill the card + slipping rows in `buildSeoOverview`**

In `app/lib/seo/overview.server.ts`, widen the import:

```ts
import { getGscState, getRankingsSince, summariseGoogleCard, detectSlips, RANKING_CARD_WINDOW_DAYS, type GoogleCardVM } from "./google-search-console.server";
```

Add a small local helper near the top (after the constants):

```ts
/** The product handle behind a ranked storefront URL, or null for non-product pages. */
function productHandleFromUrl(pageUrl: string): string | null {
  const m = pageUrl.match(/\/storefront\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
```

In the product loop, capture each product's health so a slip row can reuse it. Replace the loop body's row-collection so it also records scores + overrides by handle:

```ts
  let scoreSum = 0;
  const rows: NeedsAttentionRow[] = [];
  const scoreByHandle = new Map<string, number>();
  const overrideByHandle = new Map<string, boolean>();
  const productByHandle = new Map<string, { id: string; title: string }>();
  for (const p of products) {
    const override = overrides.get(`product:${p.id}`) ?? null;
    const draft = applyOverride(buildProductDraft(p, store, storefrontOrigin), override);
    const report = scoreDraft(draft);
    scoreSum += report.score;
    scoreByHandle.set(p.handle, report.score);
    overrideByHandle.set(p.handle, override != null);
    productByHandle.set(p.handle, { id: p.id, title: p.title });
    if (report.score < 100) {
      rows.push({ id: p.id, handle: p.handle, title: p.title, score: report.score, topIssue: topIssue(report), hasOverride: override != null });
    }
  }
```

Then, after the loop and before the `rows.sort(...)`, build the Google card and merge slips:

```ts
  let google: GoogleCardVM = { connected: gsc.connected, clicks: 0, impressions: 0, topQuery: null, topPosition: null };
  if (gsc.connected) {
    const since = new Date(Date.now() - RANKING_CARD_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const rankings = await getRankingsSince(shopId, since);
    google = { connected: true, ...summariseGoogleCard(rankings) };
    for (const slip of detectSlips(rankings)) {
      const handle = productHandleFromUrl(slip.pageUrl);
      if (!handle) continue;
      const product = productByHandle.get(handle);
      if (!product) continue;
      if (rows.some((r) => r.handle === handle)) continue; // already flagged for low health
      rows.push({
        id: product.id,
        handle,
        title: product.title,
        score: scoreByHandle.get(handle) ?? 0,
        topIssue: `Slipping on Google: "${slip.query}" moved to position ${Math.round(slip.toPosition)}`,
        hasOverride: overrideByHandle.get(handle) ?? false,
      });
    }
  }

  rows.sort((a, b) => a.score - b.score);
```

Finally, replace the C3 placeholder `google: { connected: gsc.connected, ... }` in the return object with the computed `google`:

```ts
    google,
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/overview.server.test.ts`
Expected: PASS. If the slip row is missing, confirm `detectSlips` needs two captures on the same (page, query) and the fixture supplies both.

- [ ] **Step 5: Show the numbers in the `Search.tsx` card**

In `Search.tsx`, replace the "On Google" card's `<p className="cd-seo__card-sub">` (currently "See where your pages show up in Google search.") with a connection-aware line:

```tsx
              {data.google.connected ? (
                data.google.impressions > 0 ? (
                  <p className="cd-seo__card-sub">
                    <b className="cd-seo__strong">{data.google.clicks.toLocaleString()}</b> clicks ·{" "}
                    <b className="cd-seo__strong">{data.google.impressions.toLocaleString()}</b> impressions
                    {data.google.topQuery ? (
                      <>
                        {" "}· top search{" "}
                        <b className="cd-seo__strong">{data.google.topQuery}</b>
                      </>
                    ) : null}
                    .
                  </p>
                ) : (
                  <p className="cd-seo__card-sub">Connected. Waiting for Google to report search data.</p>
                )
              ) : (
                <p className="cd-seo__card-sub">See where your pages show up in Google search.</p>
              )}
```

(No em dashes; the middot `·` is used, matching the AI-assistants card copy.)

- [ ] **Step 6: Run the affected tests + typecheck**

Run: `npx vitest run app/lib/seo/__tests__/overview.server.test.ts app/components/dashboard/screens/__tests__/search-google-card.test.tsx`
Expected: PASS (the card smoke still renders Connect/Disconnect; the SSR fixture has `impressions: 0` so the connected copy is the "Waiting" line).
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/lib/seo/overview.server.ts app/lib/seo/__tests__/overview.server.test.ts app/components/dashboard/screens/Search.tsx
git commit -m "seo: surface Google ranking numbers + slipping pages in the Search overview"
```

---

## Final gate (run once after C5, before any push)

Per the Global Constraints pre-commit gate:

```bash
npx vitest run app/lib/seo app/routes/__tests__/dashboard.api.search.test.ts app/routes/__tests__/cron.seo-rankings.test.ts app/components/dashboard/screens/__tests__/search-google-card.test.tsx
npm run typecheck   # exit 0
npm run lint        # exit 0, no warnings on touched files
npm run build       # exit 0
```

---

## Self-review

**1. Spec coverage (against the design spec's "Search Console loop (phase 2)" + the locked scope):**

| Spec / locked requirement | Task |
|---|---|
| `seo_ranking` migration (unique on shop+query+page+date, index on shop+date, app_web select) | C1 |
| `seo_settings` `gsc_connected` + `gsc_site_url` columns | C1 |
| Refresh token encrypted, in a deny-all secret table unreadable by `app_web` | C1 (table + grants) + C2 (`encrypt`) |
| `buildConnectUrl` returns not-configured when env missing (dormant-safe) | C2 Step 1/3 |
| `exchangeAndStore` (code -> encrypted refresh token + gsc_connected) | C2 |
| `fetchSearchAnalytics` (decrypt -> access token -> GSC API, mocked in tests) | C2 |
| `syncRankings` idempotent upsert on the conflict key | C2 |
| `disconnect` (delete credential + clear flag) | C2 |
| Connect flow: `connectGoogle` / `disconnectGoogle` actions | C3 |
| Callback route validating CSRF `state` | C3 (`consumeOAuthState`) |
| Search.tsx button wiring; connected -> data + Disconnect | C3 (chrome) + C5 (numbers) |
| Daily cron, Bearer `CRON_SECRET`, per-shop failure isolation, JSON summary | C4 |
| Google card `{ clicks, impressions, topQuery, topPosition }` from last 28 days | C5 |
| "Slipping on Google" entries in `needsAttention` (>= +5 positions vs earliest capture) | C5 |
| Auto-rewrite-on-slip DEFERRED with a one-line note | "Deferred by design" section |
| Dormancy: inert with no env / not connected; all external HTTP mocked | Known-dependency callout + C2 Step 1 (null URL) + C4 Step 1 (no shops) |

No spec requirement in scope is left without a task.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle errors appropriately". Every code step shows the full code; every test step shows full assertions; every command has an expected result. "Similar to Task N" is never used.

**3. Type consistency:** `GoogleCardVM` has the identical shape in C2 (server), C3 (`search-client` mirror), and the `SeoOverviewVM.google` field. `RankingRow` (camelCase, `capturedDate`) is produced by `parseAnalyticsRows`/`getRankingsSince` and consumed by `summariseGoogleCard`/`detectSlips` with matching fields. `getGscState -> { connected, siteUrl }` is used by both C3 and C5. `syncRankings -> { upserted }` matches the cron summary in C4. `buildConnectUrl(shopId, state)` and `exchangeAndStore(shopId, code)` signatures match their call sites in C3. DB column names (`gsc_connected`, `gsc_site_url`, `refresh_token_encrypted`, `captured_date`, `page_url`) are identical between the C1 migration and the C2 queries.

**4. Security check (the load-bearing invariant):** The Google refresh token is written ONLY as `encrypt(refreshToken)` into `seo_google_credential` (C2 `exchangeAndStore`), a table with RLS enabled, NO policy, and NO `app_web` grant (C1) — the migration's own self-test fails the apply if a policy or `app_web` grant exists. It is read ONLY by `fetchSearchAnalytics` via the service-role `getSupabase()` and immediately `decrypt`ed in memory; it is never selected into any VM, never returned by `buildSeoOverview`, never mirrored into `search-client.ts`, and never sent to the browser. The dashboard only ever sees derived ranking numbers (non-secret, in `seo_ranking`, which `app_web` may select). The connect URL and callback carry a single-use CSRF nonce (`createOAuthState`/`consumeOAuthState`), so a replayed or forged `state` binds to no shop.

**5. Dormancy check:** With no `GOOGLE_*` env: `gscConfigured()` is false, `buildConnectUrl` returns `null`, `connectGoogle` returns 503 (no throw), `fetchSearchAnalytics` returns `[]`, `syncRankings` returns `{ upserted: 0 }`, the cron iterates connected shops (none, since nobody can connect) and returns an empty summary, and `buildSeoOverview` returns `google: { connected: false, ... }` so the card shows "Connect Google". No path throws on absent env or absent credential. All of C2/C4's external HTTP is behind an injected fetcher or `vi.stubGlobal("fetch")`, so the entire plan is verified offline.

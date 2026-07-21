# Radar Phase B: Google Search Console rankings loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchants connect Google Search Console; a daily cron pulls Search Analytics rows into `seo_ranking`; the Search screen shows a live Google card. This is the rankings data foundation for Radar (spec `docs/superpowers/specs/2026-07-20-radar-background-watcher-design.md`, Phase B).

**Architecture:** Mirror the Google Ads connect flow (`app/routes/auth.google.$.tsx` + `app/lib/google/oauth.server.ts`) with a least-privilege `webmasters.readonly` scope. Refresh token is encrypted (`app/lib/crypto.server.ts`) into the deny-all `seo_google_credential` table (migration `20260707120000_seo_search_console.sql`, already in repo). A daily cron drains connected shops with per-shop failure isolation and a time budget. The dashboard reads a summary through a SQL RPC (PostgREST clamps at 1000 rows; never row-fetch rankings).

**Tech Stack:** Remix 2.16.7 (pinned), TypeScript strict, Supabase (service-role via `getSupabase()`), vitest, existing `cd-*` dashboard primitives.

## Global Constraints

- All `@remix-run/*` stay pinned exact 2.16.7; no new top-level dependencies.
- `.server.ts` files never imported from client modules; DTOs shaped in loaders, no raw rows to the client.
- Every dashboard route: `requireDashboardSession(request)`; writes also `requireSameOrigin(request)`.
- No literal Anthropic/Google secrets in code; env only, server-side only.
- No merchant-visible string may contain "ploy", provenance, or jargon; plain language ("Google results", not "SERP").
- Migrations: `supabase/migrations/YYYYMMDDHHMMSS_name.sql`, shop-scoped RLS + self-test block, applied via supabase MCP.
- Pre-commit gate before any commit is pushed anywhere: `npm run typecheck`, `npm run lint`, `npm run build`, `npx vitest run` for touched suites.
- Cron auth: `isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)` from `app/lib/cron-auth.server.ts`, fail-closed.
- GSC env: `GOOGLE_SEARCH_CONSOLE_CLIENT_ID/SECRET`, falling back to `GOOGLE_ADS_CLIENT_ID/SECRET` (documented in `.env.example:196-202`).

---

### Task 1: GSC OAuth + credential store (`app/lib/seo/gsc.server.ts`)

**Files:**
- Create: `app/lib/seo/gsc.server.ts`
- Test: `app/lib/seo/__tests__/gsc.server.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` from `~/lib/crypto.server`; `getSupabase` from `~/lib/supabase.server`.
- Produces (used by Tasks 2-4):
  - `buildGscAuthUrl(opts: { redirectUri: string; state: string }): string`
  - `exchangeGscCode(code: string, redirectUri: string, fetcher?: typeof fetch): Promise<{ refreshToken: string | null; accessToken: string }>`
  - `refreshGscAccessToken(refreshToken: string, fetcher?: typeof fetch): Promise<string>`
  - `saveGscCredential(shopId: string, refreshToken: string): Promise<void>`
  - `loadGscRefreshToken(shopId: string): Promise<string | null>`
  - `disconnectGsc(shopId: string): Promise<void>` (deletes credential, clears `gsc_connected`/`gsc_site_url`)

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/gsc.server.test.ts
import { describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("~/lib/crypto.server", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));

import { buildGscAuthUrl, exchangeGscCode, refreshGscAccessToken, saveGscCredential, loadGscRefreshToken } from "../gsc.server";

describe("buildGscAuthUrl", () => {
  it("requests offline webmasters.readonly consent", () => {
    process.env.GOOGLE_ADS_CLIENT_ID = "ads-client";
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
    const url = new URL(buildGscAuthUrl({ redirectUri: "https://app.example/cb", state: "st1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("ads-client");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st1");
  });
  it("prefers the dedicated GSC client id", () => {
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = "gsc-client";
    const url = new URL(buildGscAuthUrl({ redirectUri: "https://app.example/cb", state: "s" }));
    expect(url.searchParams.get("client_id")).toBe("gsc-client");
  });
});

describe("exchangeGscCode / refreshGscAccessToken", () => {
  it("exchanges the code and surfaces the Google error body on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ refresh_token: "rt", access_token: "at" }), { status: 200 }),
    );
    const out = await exchangeGscCode("code1", "https://app.example/cb", fetcher as typeof fetch);
    expect(out).toEqual({ refreshToken: "rt", accessToken: "at" });
    const failing = vi.fn().mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(exchangeGscCode("bad", "https://app.example/cb", failing as typeof fetch))
      .rejects.toThrow(/invalid_grant/);
  });
  it("refreshes an access token", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 }),
    );
    await expect(refreshGscAccessToken("rt", fetcher as typeof fetch)).resolves.toBe("fresh");
  });
});

describe("credential store", () => {
  it("saves encrypted and loads decrypted", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { refresh_token_encrypted: "enc:rt" }, error: null });
    fromMock.mockImplementation((table: string) => {
      if (table !== "seo_google_credential") throw new Error(`unexpected table ${table}`);
      return {
        upsert,
        select: () => ({ eq: () => ({ maybeSingle }) }),
      };
    });
    await saveGscCredential("shop-1", "rt");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: "shop-1", refresh_token_encrypted: "enc:rt" }),
      { onConflict: "shop_id" },
    );
    await expect(loadGscRefreshToken("shop-1")).resolves.toBe("rt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/gsc.server.test.ts`
Expected: FAIL — `Cannot find module '../gsc.server'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/seo/gsc.server.ts
// Google Search Console connect + credential store (Radar Phase B).
// Least privilege: webmasters.readonly only. The refresh token is encrypted
// into seo_google_credential, a deny-all table only service-role code reads.
import { encrypt, decrypt } from "~/lib/crypto.server";
import { getSupabase } from "~/lib/supabase.server";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function clientId(): string {
  const id = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
  if (!id) throw new Error("Google Search Console OAuth client id is not configured");
  return id;
}
function clientSecret(): string {
  const secret =
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!secret) throw new Error("Google Search Console OAuth client secret is not configured");
  return secret;
}

export function buildGscAuthUrl(opts: { redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(
  body: URLSearchParams,
  fetcher: typeof fetch,
): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google token endpoint ${res.status}: ${text}`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string };
}

export async function exchangeGscCode(
  code: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<{ refreshToken: string | null; accessToken: string }> {
  const out = await tokenRequest(
    new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    fetcher,
  );
  return { refreshToken: out.refresh_token ?? null, accessToken: out.access_token };
}

export async function refreshGscAccessToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const out = await tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
    }),
    fetcher,
  );
  return out.access_token;
}

export async function saveGscCredential(shopId: string, refreshToken: string): Promise<void> {
  const { error } = await getSupabase()
    .from("seo_google_credential")
    .upsert(
      { shop_id: shopId, refresh_token_encrypted: encrypt(refreshToken), updated_at: new Date().toISOString() },
      { onConflict: "shop_id" },
    );
  if (error) throw new Error(`saveGscCredential: ${error.message}`);
}

export async function loadGscRefreshToken(shopId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("seo_google_credential")
    .select("refresh_token_encrypted")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`loadGscRefreshToken: ${error.message}`);
  return data ? decrypt(data.refresh_token_encrypted) : null;
}

export async function disconnectGsc(shopId: string): Promise<void> {
  const sb = getSupabase();
  const del = await sb.from("seo_google_credential").delete().eq("shop_id", shopId);
  if (del.error) throw new Error(`disconnectGsc: ${del.error.message}`);
  const upd = await sb
    .from("seo_settings")
    .update({ gsc_connected: false, gsc_site_url: null })
    .eq("shop_id", shopId);
  if (upd.error) throw new Error(`disconnectGsc settings: ${upd.error.message}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/gsc.server.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/gsc.server.ts app/lib/seo/__tests__/gsc.server.test.ts
git commit -m "seo/gsc: Search Console OAuth helpers + encrypted credential store"
```

---

### Task 2: Search Analytics pull (`app/lib/seo/search-console.server.ts`)

**Files:**
- Create: `app/lib/seo/search-console.server.ts`
- Test: `app/lib/seo/__tests__/search-console.server.test.ts`

**Interfaces:**
- Consumes: `refreshGscAccessToken`, `loadGscRefreshToken` from `./gsc.server`; `getSupabase`.
- Produces (used by Tasks 3-4):
  - `listGscSites(accessToken: string, fetcher?: typeof fetch): Promise<string[]>` (siteUrl strings)
  - `pickSiteForOrigin(sites: string[], origin: string): string | null`
  - `fetchSearchAnalytics(accessToken: string, siteUrl: string, day: string, fetcher?: typeof fetch): Promise<RankingRow[]>` where `RankingRow = { query: string; pageUrl: string; position: number; impressions: number; clicks: number; ctr: number }`
  - `upsertRankings(shopId: string, day: string, rows: RankingRow[]): Promise<number>`
  - `pullShopRankings(shopId: string, opts?: { fetcher?: typeof fetch; today?: Date }): Promise<{ days: number; rows: number }>` — pulls the 3 most recent lagged days (GSC data lags ~2 days), idempotent upserts.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/search-console.server.test.ts
import { describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("../gsc.server", () => ({
  loadGscRefreshToken: vi.fn().mockResolvedValue("rt"),
  refreshGscAccessToken: vi.fn().mockResolvedValue("at"),
}));

import { fetchSearchAnalytics, pickSiteForOrigin, upsertRankings, pullShopRankings } from "../search-console.server";

describe("pickSiteForOrigin", () => {
  it("prefers exact url-prefix property, then sc-domain", () => {
    const sites = ["sc-domain:calderyncompany.com", "https://peak.calderyncompany.com/"];
    expect(pickSiteForOrigin(sites, "https://peak.calderyncompany.com")).toBe("https://peak.calderyncompany.com/");
    expect(pickSiteForOrigin(["sc-domain:calderyncompany.com"], "https://peak.calderyncompany.com")).toBe("sc-domain:calderyncompany.com");
    expect(pickSiteForOrigin(["https://other.com/"], "https://peak.calderyncompany.com")).toBeNull();
  });
});

describe("fetchSearchAnalytics", () => {
  it("maps rows and throws with the Google body on error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rows: [{ keys: ["trail boots", "https://x/p/boots"], position: 4.2, impressions: 100, clicks: 9, ctr: 0.09 }],
    }), { status: 200 }));
    const rows = await fetchSearchAnalytics("at", "sc-domain:x.com", "2026-07-18", fetcher as typeof fetch);
    expect(rows).toEqual([{ query: "trail boots", pageUrl: "https://x/p/boots", position: 4.2, impressions: 100, clicks: 9, ctr: 0.09 }]);
    const url = (fetcher.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain(encodeURIComponent("sc-domain:x.com"));
    const failing = vi.fn().mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }));
    await expect(fetchSearchAnalytics("at", "s", "2026-07-18", failing as typeof fetch)).rejects.toThrow(/403/);
  });
});

describe("upsertRankings", () => {
  it("upserts on the natural key and returns the row count", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const n = await upsertRankings("shop-1", "2026-07-18", [
      { query: "q", pageUrl: "u", position: 5, impressions: 10, clicks: 1, ctr: 0.1 },
    ]);
    expect(n).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ shop_id: "shop-1", query: "q", page_url: "u", captured_date: "2026-07-18" })],
      { onConflict: "shop_id,query,page_url,captured_date" },
    );
  });
});

describe("pullShopRankings", () => {
  it("pulls the three lagged days idempotently", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { gsc_site_url: "sc-domain:x.com" }, error: null });
    fromMock.mockImplementation((table: string) =>
      table === "seo_settings"
        ? { select: () => ({ eq: () => ({ maybeSingle }) }) }
        : { upsert });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
    const out = await pullShopRankings("shop-1", { fetcher: fetcher as typeof fetch, today: new Date("2026-07-20T12:00:00Z") });
    expect(out.days).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3); // 2026-07-18, 17, 16
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/search-console.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/seo/search-console.server.ts
// Search Analytics pull -> seo_ranking (Radar Phase B). Idempotent daily
// upserts on (shop_id, query, page_url, captured_date). GSC data lags about
// two days, so each pull re-covers the three most recent lagged days.
import { getSupabase } from "~/lib/supabase.server";
import { loadGscRefreshToken, refreshGscAccessToken } from "./gsc.server";

const API = "https://www.googleapis.com/webmasters/v3";
const ROW_LIMIT = 1000;
const LAG_DAYS = 2;
const PULL_DAYS = 3;

export type RankingRow = {
  query: string;
  pageUrl: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
};

export async function listGscSites(accessToken: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const res = await fetcher(`${API}/sites`, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GSC sites ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as { siteEntry?: Array<{ siteUrl: string }> };
  return (parsed.siteEntry ?? []).map((s) => s.siteUrl);
}

export function pickSiteForOrigin(sites: string[], origin: string): string | null {
  const host = new URL(origin).hostname;
  const prefix = sites.find((s) => {
    try {
      return !s.startsWith("sc-domain:") && new URL(s).hostname === host;
    } catch {
      return false;
    }
  });
  if (prefix) return prefix;
  const domain = sites.find((s) => s.startsWith("sc-domain:") && host.endsWith(s.slice("sc-domain:".length)));
  return domain ?? null;
}

export async function fetchSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  day: string,
  fetcher: typeof fetch = fetch,
): Promise<RankingRow[]> {
  const res = await fetcher(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: day, endDate: day, dimensions: ["query", "page"], rowLimit: ROW_LIMIT }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GSC searchAnalytics ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as {
    rows?: Array<{ keys: [string, string]; position: number; impressions: number; clicks: number; ctr: number }>;
  };
  return (parsed.rows ?? []).map((r) => ({
    query: r.keys[0],
    pageUrl: r.keys[1],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
  }));
}

export async function upsertRankings(shopId: string, day: string, rows: RankingRow[]): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await getSupabase().from("seo_ranking").upsert(
    rows.map((r) => ({
      shop_id: shopId,
      query: r.query,
      page_url: r.pageUrl,
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      captured_date: day,
    })),
    { onConflict: "shop_id,query,page_url,captured_date" },
  );
  if (error) throw new Error(`upsertRankings: ${error.message}`);
  return rows.length;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function pullShopRankings(
  shopId: string,
  opts: { fetcher?: typeof fetch; today?: Date } = {},
): Promise<{ days: number; rows: number }> {
  const fetcher = opts.fetcher ?? fetch;
  const refreshToken = await loadGscRefreshToken(shopId);
  if (!refreshToken) throw new Error("gsc_not_connected");
  const { data, error } = await getSupabase()
    .from("seo_settings")
    .select("gsc_site_url")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`pullShopRankings settings: ${error.message}`);
  const siteUrl = data?.gsc_site_url;
  if (!siteUrl) throw new Error("gsc_site_not_set");
  const accessToken = await refreshGscAccessToken(refreshToken, fetcher);
  const today = opts.today ?? new Date();
  let rows = 0;
  for (let back = LAG_DAYS; back < LAG_DAYS + PULL_DAYS; back++) {
    const day = isoDay(new Date(today.getTime() - back * 86_400_000));
    rows += await upsertRankings(shopId, day, await fetchSearchAnalytics(accessToken, siteUrl, day, fetcher));
  }
  return { days: PULL_DAYS, rows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/search-console.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/search-console.server.ts app/lib/seo/__tests__/search-console.server.test.ts
git commit -m "seo/search-console: daily Search Analytics pull with idempotent upserts"
```

---

### Task 3: Connect/callback routes (`dashboard.auth.gsc`)

**Files:**
- Create: `app/routes/dashboard.auth.gsc.tsx`
- Create: `app/routes/dashboard.auth.gsc_.callback.tsx`
- Test: `app/routes/__tests__/dashboard.auth.gsc.test.ts`

**Interfaces:**
- Consumes: Task 1 (`buildGscAuthUrl`, `exchangeGscCode`, `saveGscCredential`), Task 2 (`listGscSites`, `pickSiteForOrigin`); `requireDashboardSession`; `getShopStorefrontOrigin` from `~/lib/storefront/shop.server`; `upsertSeoSettings` pattern via direct `seo_settings` update.
- Produces: browser flow `GET /dashboard/auth/gsc` -> Google consent -> `GET /dashboard/auth/gsc/callback?code&state` -> redirect `/dashboard?search=google-connected` (or `?search=google-error`).
- State CSRF cookie: `__Host-gsc_state` (Path=/, Secure, HttpOnly, SameSite=Lax, Max-Age=600) holding a random state token; callback compares.

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/dashboard.auth.gsc.test.ts
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop-1", userId: "u1" }),
  buildGscAuthUrl: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
  exchangeGscCode: vi.fn().mockResolvedValue({ refreshToken: "rt", accessToken: "at" }),
  saveGscCredential: vi.fn().mockResolvedValue(undefined),
  listGscSites: vi.fn().mockResolvedValue(["https://peak.calderyncompany.com/"]),
  pickSiteForOrigin: vi.fn().mockReturnValue("https://peak.calderyncompany.com/"),
  getShopStorefrontOrigin: vi.fn().mockResolvedValue("https://peak.calderyncompany.com"),
  updateEq: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: mocks.requireDashboardSession }));
vi.mock("~/lib/seo/gsc.server", () => ({
  buildGscAuthUrl: mocks.buildGscAuthUrl,
  exchangeGscCode: mocks.exchangeGscCode,
  saveGscCredential: mocks.saveGscCredential,
}));
vi.mock("~/lib/seo/search-console.server", () => ({
  listGscSites: mocks.listGscSites,
  pickSiteForOrigin: mocks.pickSiteForOrigin,
}));
vi.mock("~/lib/storefront/shop.server", () => ({ getShopStorefrontOrigin: mocks.getShopStorefrontOrigin }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ update: () => ({ eq: mocks.updateEq }) }) }),
}));

import { loader as startLoader } from "../dashboard.auth.gsc";
import { loader as callbackLoader } from "../dashboard.auth.gsc_.callback";

describe("GET /dashboard/auth/gsc", () => {
  it("sets a state cookie and redirects to Google", async () => {
    const res = await startLoader({
      request: new Request("https://app.calderyncompany.com/dashboard/auth/gsc"),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(res.headers.get("set-cookie")).toContain("__Host-gsc_state=");
  });
});

describe("GET /dashboard/auth/gsc/callback", () => {
  it("rejects a state mismatch without exchanging the code", async () => {
    const res = await callbackLoader({
      request: new Request("https://app.calderyncompany.com/dashboard/auth/gsc/callback?code=c&state=evil", {
        headers: { cookie: "__Host-gsc_state=good" },
      }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("google-error");
    expect(mocks.exchangeGscCode).not.toHaveBeenCalled();
  });
  it("exchanges, saves, picks the site, marks connected", async () => {
    const res = await callbackLoader({
      request: new Request("https://app.calderyncompany.com/dashboard/auth/gsc/callback?code=c&state=good", {
        headers: { cookie: "__Host-gsc_state=good" },
      }),
      params: {}, context: {},
    } as never);
    expect(mocks.exchangeGscCode).toHaveBeenCalled();
    expect(mocks.saveGscCredential).toHaveBeenCalledWith("shop-1", "rt");
    expect(res.headers.get("location")).toContain("google-connected");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0"); // state cookie cleared
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.gsc.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write both routes**

```tsx
// app/routes/dashboard.auth.gsc.tsx
// Start the Google Search Console connect flow. Session-gated; sets a
// short-lived CSRF state cookie and forwards to Google's consent screen.
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { randomBytes } from "node:crypto";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { buildGscAuthUrl } from "~/lib/seo/gsc.server";

export const STATE_COOKIE = "__Host-gsc_state";

export function gscRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/dashboard/auth/gsc/callback`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireDashboardSession(request);
  const state = randomBytes(16).toString("hex");
  return redirect(buildGscAuthUrl({ redirectUri: gscRedirectUri(request), state }), {
    headers: {
      "set-cookie": `${STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
};
```

```tsx
// app/routes/dashboard.auth.gsc_.callback.tsx
// Google Search Console OAuth callback: verify state, exchange the code,
// store the encrypted refresh token, auto-pick the matching GSC property,
// and mark the shop connected. Errors land back on the Search screen.
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { exchangeGscCode, saveGscCredential } from "~/lib/seo/gsc.server";
import { listGscSites, pickSiteForOrigin } from "~/lib/seo/search-console.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { getSupabase } from "~/lib/supabase.server";
import { STATE_COOKIE, gscRedirectUri } from "./dashboard.auth.gsc";

const CLEAR_STATE = `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

function back(result: "google-connected" | "google-error", reason?: string): Response {
  const q = new URLSearchParams({ search: result });
  if (reason) q.set("reason", reason);
  return redirect(`/dashboard?${q.toString()}`, { headers: { "set-cookie": CLEAR_STATE } });
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookieValue(request, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return back("google-error", "state_mismatch");
  try {
    const { refreshToken, accessToken } = await exchangeGscCode(code, gscRedirectUri(request));
    if (!refreshToken) return back("google-error", "no_refresh_token");
    await saveGscCredential(session.shopId, refreshToken);
    const origin = await getShopStorefrontOrigin(session.shopId);
    const site = origin ? pickSiteForOrigin(await listGscSites(accessToken), origin) : null;
    const { error } = await getSupabase()
      .from("seo_settings")
      .update({ gsc_connected: true, gsc_site_url: site })
      .eq("shop_id", session.shopId);
    if (error) throw new Error(error.message);
    return back("google-connected");
  } catch (err) {
    console.error("[gsc] connect failed", err);
    return back("google-error", "exchange_failed");
  }
};
```

Note: if `seo_settings` has no row for the shop yet, the `update` matches zero rows. Use the existing `upsertSeoSettings` helper from `~/lib/seo/seo-store.server.ts` instead if it accepts these fields; otherwise switch the update to an upsert on `shop_id` (check `seo-store.server.ts:53-99` first and reuse — DRY beats a second writer).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.gsc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.auth.gsc.tsx app/routes/dashboard.auth.gsc_.callback.tsx app/routes/__tests__/dashboard.auth.gsc.test.ts
git commit -m "dashboard/auth: Google Search Console connect + callback flow"
```

---

### Task 4: Daily cron (`cron.seo-rankings`)

**Files:**
- Create: `app/routes/cron.seo-rankings.tsx`
- Modify: `vercel.json` (add `{ "path": "/cron/seo-rankings", "schedule": "30 9 * * *" }` to the `crons` array)
- Test: `app/routes/__tests__/cron.seo-rankings.test.ts`

**Interfaces:**
- Consumes: `pullShopRankings` (Task 2); `isAuthorizedCron` from `~/lib/cron-auth.server`; `getSupabase`.
- Produces: `GET /cron/seo-rankings` returns `{ pulled: number, failed: number, skipped: boolean }`; drains all `seo_settings` rows with `gsc_connected = true`, per-shop try/catch, 50s time budget (remaining shops picked up next run — pulls are idempotent).

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/cron.seo-rankings.test.ts
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pullShopRankings: vi.fn(),
  rows: [{ shop_id: "s1" }, { shop_id: "s2" }],
}));
vi.mock("~/lib/seo/search-console.server", () => ({ pullShopRankings: mocks.pullShopRankings }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: mocks.rows, error: null }) }) }) }),
  }),
}));

import { loader } from "../cron.seo-rankings";

function req(auth?: string): never {
  return {
    request: new Request("https://x/cron/seo-rankings", { headers: auth ? { authorization: auth } : {} }),
    params: {}, context: {},
  } as never;
}

describe("cron.seo-rankings", () => {
  it("401s without the bearer secret", async () => {
    process.env.CRON_SECRET = "sekrit";
    const res = await loader(req());
    expect(res.status).toBe(401);
  });
  it("drains connected shops with per-shop isolation", async () => {
    process.env.CRON_SECRET = "sekrit";
    mocks.pullShopRankings
      .mockResolvedValueOnce({ days: 3, rows: 10 })
      .mockRejectedValueOnce(new Error("gsc_site_not_set"));
    const res = await loader(req("Bearer sekrit"));
    const body = await res.json();
    expect(body).toMatchObject({ pulled: 1, failed: 1 });
    expect(mocks.pullShopRankings).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.seo-rankings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the cron route**

```tsx
// app/routes/cron.seo-rankings.tsx
// Daily Search Console pull for every connected shop. Idempotent (upserts on
// the natural key), per-shop failure isolation, 50s time budget: shops not
// reached this run are re-covered next run because each pull re-fetches the
// three most recent lagged days.
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { pullShopRankings } from "~/lib/seo/search-console.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase()
    .from("seo_settings")
    .select("shop_id")
    .eq("gsc_connected", true)
    .order("shop_id");
  if (error) return json({ error: error.message }, { status: 500 });
  let pulled = 0;
  let failed = 0;
  let skipped = false;
  for (const row of data ?? []) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped = true;
      break;
    }
    try {
      await pullShopRankings(row.shop_id);
      pulled++;
    } catch (err) {
      failed++;
      console.error(`[cron.seo-rankings] shop ${row.shop_id} failed`, err);
    }
  }
  return json({ pulled, failed, skipped });
};
```

- [ ] **Step 4: Run tests, then update vercel.json**

Run: `npx vitest run app/routes/__tests__/cron.seo-rankings.test.ts`
Expected: PASS.

Then add to the `crons` array in `vercel.json` (keep existing entries untouched):

```json
{ "path": "/cron/seo-rankings", "schedule": "30 9 * * *" }
```

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.seo-rankings.tsx app/routes/__tests__/cron.seo-rankings.test.ts vercel.json
git commit -m "cron/seo-rankings: daily Search Console drain for connected shops"
```

---

### Task 5: Rankings summary RPC (migration)

**Files:**
- Create: `supabase/migrations/20260720120000_seo_rankings_summary_rpc.sql`

**Interfaces:**
- Produces: `read_seo_rankings_summary(p_shop uuid)` returning one json object:
  `{ "clicks": int, "impressions": int, "topQueries": [{"query","clicks","position"}...max 5], "slipping": [{"pageUrl","query","position","prevPosition"}...max 5], "lastCapturedDate": "YYYY-MM-DD"|null }`
  over the trailing 28 days. Slipping = best query per page whose 7-day avg position worsened by 3+ vs the prior 7 days. Service-role callable (used by the dashboard loader in Task 6).

- [ ] **Step 1: Write the migration**

```sql
-- Rankings summary for the Search screen Google card (Radar Phase B).
-- One RPC so the dashboard never row-fetches seo_ranking through PostgREST
-- (1000-row clamp). SECURITY DEFINER, pinned search_path, EXECUTE revoked
-- from anon/authenticated; the service-role dashboard loader is the caller.
create or replace function public.read_seo_rankings_summary(p_shop uuid)
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
totals as (
  select coalesce(sum(clicks),0)::int as clicks,
         coalesce(sum(impressions),0)::int as impressions,
         max(captured_date) as last_day
  from recent
),
top_queries as (
  select query,
         sum(clicks)::int as clicks,
         round(avg(position)::numeric, 1) as position
  from recent
  group by query
  order by sum(clicks) desc, sum(impressions) desc
  limit 5
),
per_page as (
  select page_url, query,
         avg(position) filter (where captured_date >= current_date - 7) as cur_pos,
         avg(position) filter (where captured_date < current_date - 7
                               and captured_date >= current_date - 14) as prev_pos,
         sum(impressions) as imp
  from recent
  group by page_url, query
),
slipping as (
  select page_url, query,
         round(cur_pos::numeric, 1) as position,
         round(prev_pos::numeric, 1) as prev_position
  from per_page
  where cur_pos is not null and prev_pos is not null
    and cur_pos - prev_pos >= 3
  order by (cur_pos - prev_pos) desc, imp desc
  limit 5
)
select jsonb_build_object(
  'clicks', (select clicks from totals),
  'impressions', (select impressions from totals),
  'topQueries', coalesce((select jsonb_agg(jsonb_build_object(
      'query', query, 'clicks', clicks, 'position', position)) from top_queries), '[]'::jsonb),
  'slipping', coalesce((select jsonb_agg(jsonb_build_object(
      'pageUrl', page_url, 'query', query, 'position', position,
      'prevPosition', prev_position)) from slipping), '[]'::jsonb),
  'lastCapturedDate', (select to_char(last_day, 'YYYY-MM-DD') from totals)
);
$$;

revoke execute on function public.read_seo_rankings_summary(uuid) from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'read_seo_rankings_summary'
  ) then
    raise exception 'read_seo_rankings_summary was not created';
  end if;
end $$;
```

- [ ] **Step 2: Apply to prod via the supabase MCP**

Use `mcp__supabase__apply_migration` (project `ajgrmnvzxfxxlwrxcgnu`) with the file's name and contents. Verify with `mcp__supabase__execute_sql`: `select public.read_seo_rankings_summary('00000000-0000-0000-0000-000000000000'::uuid);` — expect a jsonb object with zero totals, not an error. Also confirm `20260707120000_seo_search_console.sql` is in `mcp__supabase__list_migrations` output (it shipped earlier; if missing, apply it FIRST).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260720120000_seo_rankings_summary_rpc.sql
git commit -m "seo/migrations: rankings summary RPC for the Search screen Google card"
```

---

### Task 6: Google card in the Search screen

**Files:**
- Modify: `app/routes/dashboard.api.search.tsx` (loader: add `google` block; action: add `"gsc_disconnect"` case)
- Modify: `app/lib/dashboard/search-client.ts` (extend `SearchOverviewVM`)
- Modify: the Search screen component (found via `SCREEN_CACHE_KEYS.search` usage — `app/components/dashboard/screens/Search.tsx` or as named on the branch; locate with `grep -r "fetchSearchOverview" app/components`)
- Test: extend `app/routes/__tests__/dashboard.api.search.test.ts`

**Interfaces:**
- Consumes: Task 5 RPC via `getSupabase().rpc("read_seo_rankings_summary", { p_shop: session.shopId })`; `disconnectGsc` (Task 1); existing `getSeoSettings`.
- Produces client VM extension:

```ts
export interface SearchGoogleVM {
  connected: boolean;
  siteUrl: string | null;
  clicks: number;
  impressions: number;
  topQueries: Array<{ query: string; clicks: number; position: number }>;
  slipping: Array<{ pageUrl: string; query: string; position: number; prevPosition: number }>;
  lastCapturedDate: string | null;
}
// SearchOverviewVM gains: google: SearchGoogleVM
```

- [ ] **Step 1: Write the failing test (extend the existing suite)**

Add to `app/routes/__tests__/dashboard.api.search.test.ts`, following its established `vi.hoisted` mock style (mock `~/lib/seo/gsc.server`'s `disconnectGsc` and add an `rpc` mock to the supabase mock already present in that file):

```ts
it("includes the google block when connected", async () => {
  // arrange: settings mock returns gsc_connected true + site url;
  // rpc mock returns { clicks: 12, impressions: 340, topQueries: [], slipping: [], lastCapturedDate: "2026-07-18" }
  const res = await loader(makeRequest());
  const body = await res.json();
  expect(body.google).toMatchObject({ connected: true, clicks: 12, impressions: 340 });
});

it("disconnects on gsc_disconnect", async () => {
  const res = await action(makePost({ action: "gsc_disconnect" }));
  expect(res.status).toBe(200);
  expect(disconnectGscMock).toHaveBeenCalledWith("shop-1");
});

it("returns a zeroed google block when the RPC fails (never breaks the screen)", async () => {
  // arrange rpc mock to reject
  const res = await loader(makeRequest());
  const body = await res.json();
  expect(body.google.connected).toBe(true);
  expect(body.google.clicks).toBe(0);
});
```

(Write `makeRequest`/`makePost` to match the helpers already in that file; read it first — the test file is the source of truth for its own harness.)

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run app/routes/__tests__/dashboard.api.search.test.ts`
Expected: new cases FAIL (`google` undefined / unknown action), pre-existing cases PASS.

- [ ] **Step 3: Implement loader + action changes**

In `dashboard.api.search.tsx` loader, after the existing settings load:

```ts
const google: SearchGoogleVM = {
  connected: Boolean(settings.gscConnected ?? rawSettings?.gsc_connected),
  siteUrl: rawSettings?.gsc_site_url ?? null,
  clicks: 0, impressions: 0, topQueries: [], slipping: [], lastCapturedDate: null,
};
if (google.connected) {
  try {
    const { data, error } = await getSupabase().rpc("read_seo_rankings_summary", { p_shop: session.shopId });
    if (error) throw new Error(error.message);
    const s = data as { clicks: number; impressions: number; topQueries: SearchGoogleVM["topQueries"]; slipping: SearchGoogleVM["slipping"]; lastCapturedDate: string | null };
    Object.assign(google, s);
  } catch (err) {
    console.error("[search] rankings summary failed", err); // card shows zeros + note, screen never breaks
  }
}
return { ...existingPayload, google };
```

(Adapt the settings-read to however the existing loader fetches `seo_settings` — extend that read to include `gsc_connected, gsc_site_url` rather than adding a second query.)

Action: add to the existing `switch (body.action)`:

```ts
case "gsc_disconnect": {
  await disconnectGsc(session.shopId);
  return { ok: true };
}
```

- [ ] **Step 4: Implement the card UI**

In the Search screen component, add a "Google" card using the existing `cd-*` primitives already imported there (`Card`, `Btn`, `CDIcon`):

- Not connected: title "Google results", one line "See how your store ranks on Google and catch pages that slip.", primary `Btn` "Connect Google" -> `window.location.href = "/dashboard/auth/gsc"`.
- Connected: clicks + impressions stat pair ("28 days"), top queries list (query, clicks, avg position), a "Needs a look" list from `slipping` ("was #4, now #9"), footer line "Google data through {lastCapturedDate}", and a quiet "Disconnect" action posting `{ action: "gsc_disconnect" }` then refetching.
- On mount, if `location.search` contains `search=google-connected` or `google-error`, show the existing toast/notice pattern used by that screen and strip the query param via `history.replaceState`.
- Keep the card copy jargon-free: "average spot on Google" not "SERP position".
- Screen-cache: no new key needed — the card rides `SCREEN_CACHE_KEYS.search` through the existing `fetchSearchOverview`; the VM change flows through `cacheScreenData` write-through automatically.

- [ ] **Step 5: Run the suite and gate**

```bash
npx vitest run app/routes/__tests__/dashboard.api.search.test.ts app/lib/seo
npm run typecheck && npm run lint && npm run build
```
Expected: all PASS / exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.search.tsx app/lib/dashboard/search-client.ts app/components/dashboard/screens/Search.tsx app/routes/__tests__/dashboard.api.search.test.ts
git commit -m "dashboard/search: Google card with rankings summary + GSC connect state"
```

---

### Task 7: Full gate + phase wrap

**Files:** none new.

- [ ] **Step 1: Full eval pipeline**

```bash
npm run typecheck && npm run lint && npm run build && npx vitest run
```
Expected: all exit 0; zero warnings on touched files.

- [ ] **Step 2: /code-review**

Run the `/code-review` slash command on the working tree. Resolve every blocker; downgrade nits with one-line justifications.

- [ ] **Step 3: Verify env + cron registration**

- `.env.example` GSC block already documents the redirect URI (`:196-202`) — confirm it matches the actual route path `/dashboard/auth/gsc/callback` built in Task 3.
- `vercel.json` contains the `/cron/seo-rankings` entry.
- Vercel prod env: `GOOGLE_SEARCH_CONSOLE_CLIENT_ID/SECRET` may stay unset (falls back to `GOOGLE_ADS_*`); note in the wrap-up that the Google Cloud OAuth client needs the `webmasters.readonly` scope on its consent screen and the new redirect URI added — a human step.

- [ ] **Step 4: Commit any gate fixes; do NOT push**

Prod autodeploys `origin/main`; pushing/merging waits for explicit instruction.

## Out of scope for this plan

- Auto-rewrite-on-slip: deliberately NOT built here — slip response ships as a Radar move (`seo_regression_patch`) in Phase C, so there is exactly one rewrite path.
- Radar tables, detectors, drafter, Radar screen (Phase C plan).
- Competitor discovery/snapshots (Phase D plan).

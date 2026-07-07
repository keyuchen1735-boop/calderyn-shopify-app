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

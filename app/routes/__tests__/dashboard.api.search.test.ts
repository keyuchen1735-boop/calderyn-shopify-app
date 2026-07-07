import { describe, it, expect, vi, beforeEach } from "vitest";
// vi.mock is hoisted above this import, so the mocks below apply before the
// route module (and its transitive ~/lib/seo imports) is evaluated.
import { loader, action } from "../dashboard.api.search";

// Spies live in vi.hoisted so the vi.mock factories below can close over
// already-initialized functions instead of a TDZ error.
const {
  requireDashboardSessionMock,
  requireSameOriginMock,
  getSeoSettingsMock,
  upsertSeoSettingsMock,
  getStoreSettingsMock,
  listCollectionsMock,
  listProductsMock,
  buildStoreDescriptionMock,
  getShopStorefrontOriginMock,
} = vi.hoisted(() => ({
  requireDashboardSessionMock: vi.fn().mockResolvedValue({ shopId: "shop1", userId: "u1", shopDomain: null, sessionId: "s1" }),
  requireSameOriginMock: vi.fn(),
  getSeoSettingsMock: vi.fn().mockResolvedValue({ allowSearchEngines: true, allowAiCrawlers: true, orgName: null, orgDescription: null, googleSiteVerification: null }),
  upsertSeoSettingsMock: vi.fn().mockResolvedValue({ allowSearchEngines: true, allowAiCrawlers: false, orgName: "Ember", orgDescription: null, googleSiteVerification: null }),
  getStoreSettingsMock: vi.fn().mockResolvedValue({ storeName: "Ember", voiceTagline: "Candles." }),
  listCollectionsMock: vi.fn().mockResolvedValue([{ handle: "soy", title: "Soy Candles" }]),
  listProductsMock: vi.fn().mockResolvedValue([{ id: "p1", handle: "cedar", title: "Cedar" }]),
  buildStoreDescriptionMock: vi.fn().mockReturnValue("Ember sells Soy Candles. Candles."),
  getShopStorefrontOriginMock: vi.fn().mockResolvedValue("https://ember.calderyncompany.com"),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: requireDashboardSessionMock }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: requireSameOriginMock,
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string, m?: string) => new Response(JSON.stringify({ error: e, message: m }), { status: s }),
}));
vi.mock("~/lib/seo/seo-store.server", () => ({
  getSeoSettings: getSeoSettingsMock,
  upsertSeoSettings: upsertSeoSettingsMock,
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: getStoreSettingsMock }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listCollections: listCollectionsMock, listProducts: listProductsMock, getProduct: async () => null }),
}));
vi.mock("~/lib/seo/writer.server", () => ({ buildStoreDescription: buildStoreDescriptionMock }));
vi.mock("~/lib/storefront/shop.server", () => ({ getShopStorefrontOrigin: getShopStorefrontOriginMock }));

function req(body?: unknown, method = "POST") {
  return new Request("https://app.x/dashboard/api/search", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("dashboard.api.search loader", () => {
  it("returns this shop's SEO settings plus its live sitemap URL", async () => {
    const res = (await loader({ request: req(undefined, "GET") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(getSeoSettingsMock).toHaveBeenCalledWith("shop1");
    const body = await res.json();
    expect(body.settings).toEqual({ allowSearchEngines: true, allowAiCrawlers: true, orgName: null, orgDescription: null, googleSiteVerification: null });
    expect(body.sitemapUrl).toBe("https://ember.calderyncompany.com/sitemap.xml");
  });
  it("returns a null sitemap URL when the shop has no storefront yet", async () => {
    getShopStorefrontOriginMock.mockResolvedValueOnce("");
    const body = await ((await loader({ request: req(undefined, "GET") } as never)) as Response).json();
    expect(body.sitemapUrl).toBeNull();
  });
});

describe("dashboard.api.search action", () => {
  it("runs the same-origin CSRF check before anything else", async () => {
    await action({ request: req({ action: "updateSettings", allowAiCrawlers: false }) } as never);
    expect(requireSameOriginMock).toHaveBeenCalled();
  });
  it("405s a non-POST method", async () => {
    const res = (await action({ request: req({ action: "updateSettings" }, "PUT") } as never)) as Response;
    expect(res.status).toBe(405);
  });
  it("updateSettings forwards only the provided flags", async () => {
    const res = (await action({ request: req({ action: "updateSettings", allowAiCrawlers: false }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { allowAiCrawlers: false });
  });
  it("updateSettings forwards the search-engine flag independently", async () => {
    const res = (await action({ request: req({ action: "updateSettings", allowSearchEngines: false }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { allowSearchEngines: false });
  });
  it("updateSettings trims and forwards the Google verification token", async () => {
    const res = (await action({ request: req({ action: "updateSettings", googleSiteVerification: "  google-abc123  " }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { googleSiteVerification: "google-abc123" });
  });
  it("updateSettings extracts the bare token when the merchant pastes Google's whole meta tag", async () => {
    const tag = '<meta name="google-site-verification" content="dCDyNAElOSKCGAaLHqlljYb6ncB0dkDpiviSaYM5BZA" />';
    const res = (await action({ request: req({ action: "updateSettings", googleSiteVerification: tag }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { googleSiteVerification: "dCDyNAElOSKCGAaLHqlljYb6ncB0dkDpiviSaYM5BZA" });
  });
  it("updateSettings extracts the token from a bare content=\"...\" attribute too", async () => {
    const res = (await action({ request: req({ action: "updateSettings", googleSiteVerification: 'content="abc-123_XYZ"' }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { googleSiteVerification: "abc-123_XYZ" });
  });
  it("updateSettings normalizes a blank verification token to null (clears the tag)", async () => {
    await action({ request: req({ action: "updateSettings", googleSiteVerification: "   " }) } as never);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { googleSiteVerification: null });
  });
  it("updateSettings 422s an over-long verification token without writing", async () => {
    const res = (await action({ request: req({ action: "updateSettings", googleSiteVerification: "x".repeat(201) }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(upsertSeoSettingsMock).not.toHaveBeenCalled();
  });
  it("updateSettings 422s an over-long store name without writing", async () => {
    const res = (await action({ request: req({ action: "updateSettings", orgName: "x".repeat(81) }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(upsertSeoSettingsMock).not.toHaveBeenCalled();
  });
  it("updateSettings 422s an over-long description without writing", async () => {
    const res = (await action({ request: req({ action: "updateSettings", orgDescription: "x".repeat(201) }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(upsertSeoSettingsMock).not.toHaveBeenCalled();
  });
  it("updateSettings 422s when no recognized field is provided", async () => {
    const res = (await action({ request: req({ action: "updateSettings" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(upsertSeoSettingsMock).not.toHaveBeenCalled();
  });
  it("422s an unknown action", async () => {
    const res = (await action({ request: req({ action: "nope" }) } as never)) as Response;
    expect(res.status).toBe(422);
  });
  it("suggestDescription composes from collection titles and returns the draft without saving", async () => {
    const res = (await action({ request: req({ action: "suggestDescription" }) } as never)) as Response;
    expect(res.status).toBe(200);
    // Collections present → their titles are the subjects; no settings write.
    expect(buildStoreDescriptionMock).toHaveBeenCalledWith({ storeName: "Ember", voiceTagline: "Candles." }, ["Soy Candles"]);
    expect(upsertSeoSettingsMock).not.toHaveBeenCalled();
    expect((await res.json()).description).toBe("Ember sells Soy Candles. Candles.");
  });
  it("suggestDescription falls back to product titles when there are no collections", async () => {
    listCollectionsMock.mockResolvedValueOnce([]);
    await action({ request: req({ action: "suggestDescription" }) } as never);
    expect(buildStoreDescriptionMock).toHaveBeenCalledWith(expect.anything(), ["Cedar"]);
  });
});

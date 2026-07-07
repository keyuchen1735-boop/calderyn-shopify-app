import { describe, it, expect, vi, beforeEach } from "vitest";
// vi.mock is hoisted above this import, so the mocks below apply before the
// route module (and its transitive ~/lib/seo imports) is evaluated.
import { loader, action } from "../dashboard.api.search";

// Spies live in vi.hoisted so the vi.mock factories below can close over
// already-initialized functions instead of a TDZ error.
const {
  requireDashboardSessionMock,
  requireSameOriginMock,
  buildSeoOverviewMock,
  getProductSeoDetailMock,
  getShopStorefrontOriginMock,
  upsertSeoOverrideMock,
  deleteSeoOverrideMock,
  upsertSeoSettingsMock,
  createOAuthStateMock,
  buildConnectUrlMock,
  disconnectGscMock,
  listProductsMock,
} = vi.hoisted(() => ({
  requireDashboardSessionMock: vi.fn().mockResolvedValue({ shopId: "shop1", userId: "u1", shopDomain: null, sessionId: "s1" }),
  requireSameOriginMock: vi.fn(),
  buildSeoOverviewMock: vi.fn().mockResolvedValue({
    storeHealth: 82,
    productCount: 3,
    needsAttention: [],
    aiCrawls: [],
    aiCrawlTotal: 0,
    settings: { allowAiCrawlers: true, orgName: null, orgDescription: null },
  }),
  getProductSeoDetailMock: vi.fn().mockResolvedValue({
    id: "p1",
    handle: "cedar",
    title: "Cedar",
    googlePreview: { title: "t", url: "u", description: "d" },
    health: { score: 100, checks: [] },
    override: null,
    aiSummary: "s",
  }),
  getShopStorefrontOriginMock: vi.fn().mockResolvedValue("https://ember.calderyncompany.com"),
  upsertSeoOverrideMock: vi.fn().mockResolvedValue(undefined),
  deleteSeoOverrideMock: vi.fn().mockResolvedValue(undefined),
  upsertSeoSettingsMock: vi.fn().mockResolvedValue({ allowAiCrawlers: false, orgName: "Ember", orgDescription: null }),
  createOAuthStateMock: vi.fn().mockResolvedValue("nonce-state"),
  buildConnectUrlMock: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?state=nonce-state"),
  disconnectGscMock: vi.fn().mockResolvedValue(undefined),
  // saveOverride confirms the entityId is a real product of the shop; p1 is owned.
  listProductsMock: vi.fn().mockResolvedValue([{ id: "p1", handle: "cedar", title: "Cedar", description: "", images: [], variants: [], collections: [] }]),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: requireDashboardSessionMock }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: requireSameOriginMock,
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string, m?: string) => new Response(JSON.stringify({ error: e, message: m }), { status: s }),
}));
vi.mock("~/lib/seo/overview.server", () => ({
  buildSeoOverview: buildSeoOverviewMock,
  getProductSeoDetail: getProductSeoDetailMock,
  getShopStorefrontOrigin: getShopStorefrontOriginMock,
}));
vi.mock("~/lib/seo/seo-store.server", () => ({
  upsertSeoOverride: upsertSeoOverrideMock,
  deleteSeoOverride: deleteSeoOverrideMock,
  upsertSeoSettings: upsertSeoSettingsMock,
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listProducts: listProductsMock, getProduct: async () => null, listCollections: async () => [] }),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("~/lib/meta/oauth-state.server", () => ({ createOAuthState: createOAuthStateMock }));
vi.mock("~/lib/seo/google-search-console.server", () => ({ buildConnectUrl: buildConnectUrlMock, disconnect: disconnectGscMock }));

function req(body?: unknown, method = "POST") {
  return new Request("https://app.x/dashboard/api/search", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("dashboard.api.search loader", () => {
  it("returns the overview for the session shop + resolved origin", async () => {
    const res = (await loader({ request: req(undefined, "GET") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(buildSeoOverviewMock).toHaveBeenCalledWith("shop1", "https://ember.calderyncompany.com");
    expect((await res.json()).storeHealth).toBe(82);
  });
});

describe("dashboard.api.search action", () => {
  it("runs the same-origin CSRF check before anything else", async () => {
    await action({ request: req({ action: "detail", handle: "cedar" }) } as never);
    expect(requireSameOriginMock).toHaveBeenCalled();
  });
  it("405s a non-POST method", async () => {
    const res = (await action({ request: req({ action: "detail" }, "PUT") } as never)) as Response;
    expect(res.status).toBe(405);
  });
  it("detail resolves the product detail with the origin", async () => {
    const res = (await action({ request: req({ action: "detail", handle: "cedar" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(getProductSeoDetailMock).toHaveBeenCalledWith("shop1", "cedar", "https://ember.calderyncompany.com");
  });
  it("saveOverride persists trimmed fields scoped to the session user + product entity", async () => {
    const res = (await action({ request: req({ action: "saveOverride", entityId: "p1", metaTitle: " Title ", metaDescription: " Desc " }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoOverrideMock).toHaveBeenCalledWith("shop1", { entityType: "product", entityId: "p1", metaTitle: "Title", metaDescription: "Desc", updatedBy: "u1" });
  });
  it("saveOverride 422s a blank title without touching the store", async () => {
    const res = (await action({ request: req({ action: "saveOverride", entityId: "p1", metaTitle: "   ", metaDescription: "Desc" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(upsertSeoOverrideMock).not.toHaveBeenCalled();
  });
  it("saveOverride 422s an entityId that is not a product of this shop, without touching the store", async () => {
    const res = (await action({ request: req({ action: "saveOverride", entityId: "ghost", metaTitle: "T", metaDescription: "D" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(listProductsMock).toHaveBeenCalledWith("shop1");
    expect(upsertSeoOverrideMock).not.toHaveBeenCalled();
  });
  it("resetOverride deletes the product override", async () => {
    const res = (await action({ request: req({ action: "resetOverride", entityId: "p1" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(deleteSeoOverrideMock).toHaveBeenCalledWith("shop1", "product", "p1");
  });
  it("updateSettings forwards only the provided flags", async () => {
    const res = (await action({ request: req({ action: "updateSettings", allowAiCrawlers: false }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettingsMock).toHaveBeenCalledWith("shop1", { allowAiCrawlers: false });
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
  it("422s an unknown action", async () => {
    const res = (await action({ request: req({ action: "nope" }) } as never)) as Response;
    expect(res.status).toBe(422);
  });
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
});

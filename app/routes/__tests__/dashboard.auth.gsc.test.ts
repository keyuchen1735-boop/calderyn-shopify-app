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
  GSC_STATE_COOKIE: "__Host-gsc_state",
  gscRedirectUri: (request: Request) => {
    const url = new URL(request.url);
    return `${url.origin}/dashboard/auth/gsc/callback`;
  },
}));
vi.mock("~/lib/seo/search-console.server", () => ({
  listGscSites: mocks.listGscSites,
  pickSiteForOrigin: mocks.pickSiteForOrigin,
}));
vi.mock("~/lib/storefront/shop.server", () => ({ getShopStorefrontOrigin: mocks.getShopStorefrontOrigin }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ upsert: mocks.updateEq }) }),
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
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/dashboard/store/preferences?")).toBe(true);
    expect(location).toContain("google-error");
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
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/dashboard/store/preferences?")).toBe(true);
    expect(location).toContain("google-connected");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0"); // state cookie cleared
  });
});

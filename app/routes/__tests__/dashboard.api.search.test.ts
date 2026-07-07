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
} = vi.hoisted(() => ({
  requireDashboardSessionMock: vi.fn().mockResolvedValue({ shopId: "shop1", userId: "u1", shopDomain: null, sessionId: "s1" }),
  requireSameOriginMock: vi.fn(),
  getSeoSettingsMock: vi.fn().mockResolvedValue({ allowSearchEngines: true, allowAiCrawlers: true, orgName: null, orgDescription: null }),
  upsertSeoSettingsMock: vi.fn().mockResolvedValue({ allowSearchEngines: true, allowAiCrawlers: false, orgName: "Ember", orgDescription: null }),
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

function req(body?: unknown, method = "POST") {
  return new Request("https://app.x/dashboard/api/search", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("dashboard.api.search loader", () => {
  it("returns just this shop's SEO settings", async () => {
    const res = (await loader({ request: req(undefined, "GET") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(getSeoSettingsMock).toHaveBeenCalledWith("shop1");
    const body = await res.json();
    expect(body.settings).toEqual({ allowSearchEngines: true, allowAiCrawlers: true, orgName: null, orgDescription: null });
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
});

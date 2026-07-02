// app/routes/__tests__/dashboard-api-integrations-action.test.ts
// Dashboard-native connect/disconnect (POST /dashboard/api/integrations) is a
// thin dispatcher over calderynClient.integrations — mock the client + auth
// boundary and assert the wiring: provider validation at the boundary, the
// dashboard return-leg flag on OAuth starts, and refreshed rows after mutations.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { action, loader } from "../dashboard.api.integrations";
import { CalderynError } from "~/lib/calderyn.server";
import type * as HttpServer from "~/lib/dashboard/http.server";
import type * as CalderynServer from "~/lib/calderyn.server";

const requireDashboardSession = vi.fn();
const startOAuth = vi.fn();
const connectApiKey = vi.fn();
const disconnect = vi.fn();
const list = vi.fn();

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
const rateLimitOk = vi.fn(async () => true);

vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
  requireSameOrigin: vi.fn(),
  rateLimit: (...a: unknown[]) => rateLimitOk(...(a as [])),
}));
vi.mock("~/lib/calderyn.server", async (importOriginal) => ({
  ...(await importOriginal<typeof CalderynServer>()),
  calderynClient: () => ({
    integrations: {
      startOAuth: (...a: unknown[]) => startOAuth(...a),
      connectApiKey: (...a: unknown[]) => connectApiKey(...a),
      disconnect: (...a: unknown[]) => disconnect(...a),
      list: (...a: unknown[]) => list(...a),
    },
  }),
}));

function post(body: unknown, method = "POST"): Request {
  return new Request("https://calderyncompany.com/dashboard/api/integrations", {
    method,
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

const call = (body: unknown, method = "POST") =>
  action({ request: post(body, method), params: {}, context: {} } as never) as Promise<Response>;

const FRESH = { meta_ads: { name: "Meta Ads", status: "disconnected", detail: "", logoCls: "" } };

describe("POST /dashboard/api/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    list.mockResolvedValue(FRESH);
  });

  it("connect: returns the provider consent URL with the dashboard return leg set", async () => {
    startOAuth.mockResolvedValue({ redirectUrl: "https://facebook.com/dialog?state=abc" });
    const res = await call({ intent: "connect", provider: "meta" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://facebook.com/dialog?state=abc" });
    // (provider, host, popup, dashboard) — the dashboard flag steers the callback
    // back to /dashboard instead of the embedded admin.
    expect(startOAuth).toHaveBeenCalledWith("meta", null, false, true);
  });

  it("connect: rejects a non-OAuth provider at the boundary", async () => {
    const res = await call({ intent: "connect", provider: "easypost" });
    expect(res.status).toBe(422);
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it("connect-key: stores the pasted credential and returns refreshed rows", async () => {
    connectApiKey.mockResolvedValue({ kind: "easypost_ship" });
    const res = await call({ intent: "connect-key", provider: "easypost", apiKey: "EZAK123" });
    expect(res.status).toBe(200);
    expect(connectApiKey).toHaveBeenCalledWith("easypost", "EZAK123");
    expect(await res.json()).toEqual({ integrations: FRESH });
  });

  it("connect-key: rejects an OAuth provider (paste is not its mechanism)", async () => {
    const res = await call({ intent: "connect-key", provider: "meta", apiKey: "x" });
    expect(res.status).toBe(422);
    expect(connectApiKey).not.toHaveBeenCalled();
  });

  it("connect-key: rejects a missing/blank credential at the boundary", async () => {
    for (const body of [
      { intent: "connect-key", provider: "easypost" },
      { intent: "connect-key", provider: "easypost", apiKey: "   " },
      { intent: "connect-key", provider: "easypost", apiKey: 42 },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "empty_api_key" });
    }
    expect(connectApiKey).not.toHaveBeenCalled();
  });

  it("rate-limits mutations (key probes must not be a validation oracle)", async () => {
    rateLimitOk.mockResolvedValueOnce(false);
    const res = await call({ intent: "disconnect", provider: "meta" });
    expect(res.status).toBe(429);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("connect-key: surfaces the client's validation failure (bad key never stored)", async () => {
    connectApiKey.mockRejectedValue(
      new CalderynError({ code: "EASYPOST_KEY_INVALID", status: 400, message: "Bad key" }),
    );
    const res = await call({ intent: "connect-key", provider: "easypost", apiKey: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "EASYPOST_KEY_INVALID" });
  });

  it("disconnect: removes the pairing and returns refreshed rows", async () => {
    disconnect.mockResolvedValue(undefined);
    const res = await call({ intent: "disconnect", provider: "quickbooks" });
    expect(res.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith("quickbooks");
    expect(await res.json()).toEqual({ integrations: FRESH });
  });

  it("disconnect: rejects an unknown provider (shopify is not disconnectable here)", async () => {
    const res = await call({ intent: "disconnect", provider: "shopify" });
    expect(res.status).toBe(422);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent", async () => {
    const res = await call({ intent: "explode", provider: "meta" });
    expect(res.status).toBe(422);
  });

  it("rejects non-POST methods", async () => {
    const res = await call(undefined, "DELETE");
    expect(res.status).toBe(405);
  });
});

describe("GET /dashboard/api/integrations (unchanged read path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    list.mockResolvedValue(FRESH);
  });

  it("returns the integrations map", async () => {
    const req = new Request("https://calderyncompany.com/dashboard/api/integrations");
    const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ integrations: FRESH });
  });
});

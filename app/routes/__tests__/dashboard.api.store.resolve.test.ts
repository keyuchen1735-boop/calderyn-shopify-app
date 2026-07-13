import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { action } from "../dashboard.api.store.resolve";

const { sessionMock, rateLimitMock, evidenceMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  rateLimitMock: vi.fn(),
  evidenceMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/dashboard/http.server", async (original) => {
  const actual = await original<typeof HttpServer>();
  return { ...actual, rateLimit: rateLimitMock };
});
vi.mock("~/lib/storefront-bundle/routing-evidence.server", () => ({ buildCatalogRoutingEvidence: evidenceMock }));

const post = (body: unknown, method = "POST") =>
  action({
    request: new Request("https://app.test/dashboard/api/store/resolve", {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs);

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: "shop-1", userId: "user-1" });
  rateLimitMock.mockReset().mockResolvedValue(true);
  evidenceMock.mockReset().mockResolvedValue({
    productTitles: [],
    productTypes: [],
    productTags: [],
    optionNames: [],
    collectionTitles: [],
    fingerprint: "sha256:server",
  });
});

describe("dashboard store design resolver endpoint", () => {
  it("authenticates, rate-limits, and returns the pure resolver result", async () => {
    const response = await post({ prompt: "Build a sustainable refill shop", mode: "auto" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "recipe",
      templateId: "commons-index",
      catalogFingerprint: "sha256:server",
    });
    expect(sessionMock).toHaveBeenCalledOnce();
    expect(rateLimitMock).toHaveBeenCalledWith("store-design-resolve:shop-1", 30, 60_000);
    expect(evidenceMock).toHaveBeenCalledWith("shop-1");
  });

  it("never accepts browser-supplied catalog evidence", async () => {
    const response = await post({
      prompt: "",
      mode: "auto",
      evidence: {
        productTypes: ["pet supplement"],
        productTags: ["dog health"],
        collectionTitles: ["pet wellness"],
        fingerprint: "sha256:attacker",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "custom", catalogFingerprint: "sha256:server" });
    expect(evidenceMock).toHaveBeenCalledWith("shop-1");
  });

  it("returns 422 invalid_design_request for every invalid combination", async () => {
    for (const body of [
      { prompt: "", mode: "custom" },
      { prompt: "x", mode: "auto", templateId: "atelier-nine" },
      { prompt: "", mode: "recipe" },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_design_request" });
    }
    expect(evidenceMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, non-POST methods, and excess traffic", async () => {
    const malformed = await action({
      request: new Request("https://app.test/dashboard/api/store/resolve", { method: "POST", body: "{" }),
      params: {},
      context: {},
    } as ActionFunctionArgs);
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toEqual({ error: "invalid_design_request" });

    expect((await post({}, "PUT")).status).toBe(405);
    rateLimitMock.mockResolvedValueOnce(false);
    const limited = await post({ prompt: "x", mode: "auto" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });
});

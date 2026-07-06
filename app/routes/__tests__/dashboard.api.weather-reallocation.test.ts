import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireSameOrigin, requireDashboardSession, executeReallocation } = vi.hoisted(() => ({
  requireSameOrigin: vi.fn(),
  requireDashboardSession: vi.fn(async () => ({ shopId: "shop-1" })),
  executeReallocation: vi.fn(async () => ({ outcome: "succeeded" })),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/dashboard/http.server")>("~/lib/dashboard/http.server");
  return { ...actual, requireSameOrigin };
});
vi.mock("~/lib/actions/reallocate.server", () => ({ executeReallocation }));

let suggestion: Record<string, unknown> | null;
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.update = () => chain;
      chain.maybeSingle = async () => ({ data: suggestion, error: null });
      return chain;
    },
  }),
}));

import { action } from "../dashboard.api.weather-reallocation";

const post = (body: unknown) =>
  action({
    request: new Request("https://app.test/dashboard/api/weather-reallocation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never);

beforeEach(() => {
  executeReallocation.mockClear();
  suggestion = {
    id: "sg1", shop_id: "shop-1", status: "pending",
    source_campaign_id: "src", dest_campaign_id: "dst", amount_cents: 3000,
  };
});

describe("weather-reallocation action", () => {
  it("applies a pending suggestion via executeReallocation", async () => {
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(executeReallocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ sourceCampaignId: "src", destCampaignId: "dst", amountCents: 3000, idempotencyKey: "weather:sg1" }),
      expect.anything(),
    );
    expect(res.status).toBe(200);
  });
  it("dismisses without reallocating", async () => {
    const res = await post({ suggestionId: "sg1", intent: "dismiss" });
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
  it("409s a non-pending suggestion", async () => {
    suggestion = { ...(suggestion as object), status: "applied" } as Record<string, unknown>;
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(409);
    expect(executeReallocation).not.toHaveBeenCalled();
  });
  it("404s an unknown / wrong-shop suggestion", async () => {
    suggestion = null;
    const res = await post({ suggestionId: "nope", intent: "apply" });
    expect(res.status).toBe(404);
  });
  it("422s a bad intent", async () => {
    const res = await post({ suggestionId: "sg1", intent: "frobnicate" });
    expect(res.status).toBe(422);
  });
});

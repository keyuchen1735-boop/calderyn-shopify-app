import { describe, it, expect, vi, beforeEach } from "vitest";
import { action } from "../dashboard.api.campaigns.$id.action";

const { executeAction, metaDraftPushEnabled } = vi.hoisted(() => ({
  executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
  metaDraftPushEnabled: vi.fn(async () => true),
}));
vi.mock("~/lib/actions/execute.server", () => ({ executeAction }));
vi.mock("~/lib/meta/ad-create.server", () => ({ metaDraftPushEnabled }));
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn(async () => ({ shopId: "shop-1", shopDomain: "s.myshopify.com" })),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  jsonError: (status: number, code: string) => new Response(JSON.stringify({ error: code }), { status }),
  dashboardJson: (fn: () => Promise<unknown>) =>
    Promise.resolve(fn()).then((b) => new Response(JSON.stringify(b), { status: 200 })),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("~/lib/calderyn.server", () => ({ calderynClient: () => ({ alerts: { get: vi.fn() } }) }));
vi.mock("~/lib/calibration/approval.server", () => ({ recordApproval: vi.fn() }));
vi.mock("~/lib/calibration/delta", () => ({ ZERO_APPROVE_RECEIPT: {} }));

function req(body: unknown) {
  return new Request("https://app.calderyncompany.com/dashboard/api/campaigns/c-1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("dashboard campaign action — push_creative_draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metaDraftPushEnabled.mockResolvedValue(true);
  });

  it("validates the creative, computes a deterministic key, and dispatches", async () => {
    const creative = {
      headline: "Summer Sale",
      primaryText: "50% off.",
      cta: "SHOP_NOW",
      destinationUrl: "https://shop.example.com/sale",
      imageUrl: "https://cdn.example.com/a.jpg",
    };
    const res = await action({ request: req({ type: "push_creative_draft", creative }), params: { id: "c-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(executeAction).toHaveBeenCalledTimes(1);
    const arg = (executeAction.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(arg.kind).toBe("push_creative_draft");
    expect(arg.campaignId).toBe("c-1");
    expect(String(arg.idempotencyKey)).toMatch(/^push_creative_draft:[a-f0-9]{64}$/);
    expect((arg.creative as Record<string, unknown>).headline).toBe("Summer Sale");
  });

  it("rejects an invalid creative with 422 and never dispatches", async () => {
    const res = await action({ request: req({ type: "push_creative_draft", creative: { primaryText: "x" } }), params: { id: "c-1" }, context: {} } as never);
    expect(res.status).toBe(422);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("refuses with 403 when the token lacks ads_management and never dispatches", async () => {
    metaDraftPushEnabled.mockResolvedValue(false);
    const creative = {
      headline: "Summer Sale",
      primaryText: "50% off.",
      cta: "SHOP_NOW",
      destinationUrl: "https://shop.example.com/sale",
      imageUrl: "https://cdn.example.com/a.jpg",
    };
    const res = await action({ request: req({ type: "push_creative_draft", creative }), params: { id: "c-1" }, context: {} } as never);
    expect(res.status).toBe(403);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("returns 422 (not 403) when the creative is malformed AND scope is insufficient", async () => {
    // Shape validation must run before the scope gate: a malformed body is
    // always 422, regardless of the token's scopes.
    metaDraftPushEnabled.mockResolvedValue(false);
    const res = await action({ request: req({ type: "push_creative_draft", creative: { primaryText: "x" } }), params: { id: "c-1" }, context: {} } as never);
    expect(res.status).toBe(422);
    expect(metaDraftPushEnabled).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { ActionFunctionArgs } from "react-router";
import { action } from "../app.campaigns.$campaignId";

// Spies hoisted so vi.mock factories can close over them.
const { executeActionSpy, resolveShopIdSpy } = vi.hoisted(() => ({
  executeActionSpy: vi.fn(),
  resolveShopIdSpy: vi.fn(),
}));

// Stub Polaris so importing the route module doesn't pull the real UI lib.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    Banner: Stub,
    BlockStack: Stub,
    Button: Stub,
    Card: Stub,
    InlineGrid: Stub,
    InlineStack: Stub,
    Page: Stub,
    Spinner: Stub,
    Text: Stub,
    Thumbnail: Stub,
  };
});
vi.mock("@shopify/polaris-icons", () => ({ ImageIcon: () => null }));
vi.mock("~/components/Scorecard", () => ({ Scorecard: () => null }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ __fake: "sb" }),
  resolveShopId: (...a: unknown[]) => resolveShopIdSpy(...a),
}));

vi.mock("~/lib/actions/execute.server", () => ({
  executeAction: (...a: unknown[]) => executeActionSpy(...a),
}));

// Stub remaining deps the route module imports at the top level.
vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    campaigns: { get: async () => null },
    alerts: { list: async () => [] },
    guardrails: { get: async () => ({}) },
  }),
}));
vi.mock("~/lib/ads/campaign-dim.server", () => ({ resolveCampaignDimId: async () => null }));
vi.mock("~/lib/meta/client.server", () => ({ metaClientForShop: async () => null }));
vi.mock("~/lib/meta/campaigns.server", () => ({ listCampaigns: async () => [] }));
vi.mock("~/lib/meta/creatives.server", () => ({ listCampaignCreatives: async () => [] }));
vi.mock("~/lib/meta/ad-insights.server", () => ({ listCampaignAdInsights: async () => [] }));
vi.mock("~/lib/google/client.server", () => ({ googleClientForShop: async () => null }));
vi.mock("~/lib/google/creatives.server", () => ({ listGoogleCampaignCreatives: async () => [] }));
vi.mock("~/lib/ads/campaign-detail.server", () => ({
  buildCampaignPerformance: () => ({
    available: false, dailyBudgetCents: null, spend7dCents: null,
    reportedRoas: null, realRoas: null, breakEvenRoas: null, contributionMargin: null,
  }),
}));
vi.mock("~/lib/screener/campaign-ads.server", () => ({ loadCachedAdScorecards: async () => [] }));
vi.mock("~/lib/screener/types", () => ({
  DEFAULT_SPEND_CENTS: 5000, MIN_SPEND_CENTS: 100, MAX_SPEND_CENTS: 100000,
}));
vi.mock("~/lib/actions/direction-reason.server", () => ({
  resolveCampaignDirection: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  executeActionSpy.mockReset();
  resolveShopIdSpy.mockReset();
  resolveShopIdSpy.mockResolvedValue("shop-1");
});

function applyDirectionRequest(over: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.set("intent", "apply_direction");
  fd.set("campaign_id", "cmp-dim-1");
  fd.set("action_kind", "increase_campaign_budget");
  fd.set("daily_budget_cents", "12000");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return new Request("http://localhost/app/campaigns/999extid", { method: "POST", body: fd });
}

describe("campaign detail action — apply_direction", () => {
  it("calls executeAction with the form-supplied dim uuid (not params.campaignId)", async () => {
    executeActionSpy.mockResolvedValue({ id: "aud-1", outcome: "succeeded" });

    const res = toResponse(await action({
      request: applyDirectionRequest(),
      params: { campaignId: "999extid" },
      context: {},
    } as unknown as ActionFunctionArgs));

    const body = (await res.json()) as { ok: boolean; outcome: string };
    expect(body.ok).toBe(true);
    expect(executeActionSpy).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        kind: "increase_campaign_budget",
        campaignId: "cmp-dim-1",
        dailyBudgetCents: 12000,
      }),
      expect.anything(),
    );
  });

  it("returns 400 and does not call executeAction when campaign_id is missing", async () => {
    const fd = new FormData();
    fd.set("intent", "apply_direction");
    fd.set("action_kind", "increase_campaign_budget");
    fd.set("daily_budget_cents", "12000");
    // deliberately omit campaign_id
    const req = new Request("http://localhost/app/campaigns/999extid", { method: "POST", body: fd });

    const res = toResponse(await action({
      request: req,
      params: { campaignId: "999extid" },
      context: {},
    } as unknown as ActionFunctionArgs));

    expect(res.status).toBe(400);
    expect(executeActionSpy).not.toHaveBeenCalled();
  });

  it("returns 409 and ok:false when executeAction throws (ownership miss)", async () => {
    executeActionSpy.mockRejectedValueOnce(new Error("ownership"));

    const res = toResponse(await action({
      request: applyDirectionRequest(),
      params: { campaignId: "999extid" },
      context: {},
    } as unknown as ActionFunctionArgs));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("rejects an unknown intent with 400", async () => {
    const res = toResponse(await action({
      request: applyDirectionRequest({ intent: "nope" }),
      params: { campaignId: "cmp-1" },
      context: {},
    } as unknown as ActionFunctionArgs));

    expect(res.status).toBe(400);
    expect(executeActionSpy).not.toHaveBeenCalled();
  });

  it("rejects a disallowed action_kind with 400", async () => {
    const res = toResponse(await action({
      request: applyDirectionRequest({ action_kind: "delete_campaign" }),
      params: { campaignId: "cmp-1" },
      context: {},
    } as unknown as ActionFunctionArgs));

    expect(res.status).toBe(400);
    expect(executeActionSpy).not.toHaveBeenCalled();
  });

  it("rejects a budget action without daily_budget_cents with 400 and never calls executeAction", async () => {
    const fd = new FormData();
    fd.set("intent", "apply_direction");
    fd.set("action_kind", "increase_campaign_budget");
    // deliberately omit daily_budget_cents
    const req = new Request("http://localhost/app/campaigns/cmp-1", { method: "POST", body: fd });

    const res = toResponse(await action({
      request: req,
      params: { campaignId: "cmp-1" },
      context: {},
    } as unknown as ActionFunctionArgs));

    expect(res.status).toBe(400);
    expect(executeActionSpy).not.toHaveBeenCalled();
  });
});

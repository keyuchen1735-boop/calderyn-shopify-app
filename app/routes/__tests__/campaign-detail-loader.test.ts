import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";
// vitest hoists the vi.mock() calls below above this import, so the route module
// loads with every boundary already mocked.
import { loader } from "../app.campaigns.$campaignId";

// Spies for the boundaries the loader resolves a campaign through.
const {
  getSpy,
  resolveDimSpy,
  resolveShopIdSpy,
  metaForShopSpy,
  listCampaignsSpy,
  listCreativesSpy,
  listAdInsightsSpy,
  loadCachedSpy,
} = vi.hoisted(() => ({
  getSpy: vi.fn(),
  resolveDimSpy: vi.fn(),
  resolveShopIdSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
  listCampaignsSpy: vi.fn(),
  listCreativesSpy: vi.fn(),
  listAdInsightsSpy: vi.fn(),
  loadCachedSpy: vi.fn(),
}));

// Stub the UI deps so importing the route module doesn't pull the real libs.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    Banner: Stub,
    BlockStack: Stub,
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

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({ campaigns: { get: (...a: unknown[]) => getSpy(...a) } }),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ __fake: "sb" }),
  resolveShopId: (...a: unknown[]) => resolveShopIdSpy(...a),
}));

vi.mock("~/lib/ads/campaign-dim.server", () => ({
  resolveCampaignDimId: (...a: unknown[]) => resolveDimSpy(...a),
}));

vi.mock("~/lib/meta/client.server", () => ({
  metaClientForShop: (...a: unknown[]) => metaForShopSpy(...a),
}));

vi.mock("~/lib/meta/campaigns.server", () => ({
  listCampaigns: (...a: unknown[]) => listCampaignsSpy(...a),
}));

vi.mock("~/lib/meta/creatives.server", () => ({
  listCampaignCreatives: (...a: unknown[]) => listCreativesSpy(...a),
}));

vi.mock("~/lib/meta/ad-insights.server", () => ({
  listCampaignAdInsights: (...a: unknown[]) => listAdInsightsSpy(...a),
}));

vi.mock("~/lib/google/client.server", () => ({
  googleClientForShop: async () => null,
}));

vi.mock("~/lib/google/creatives.server", () => ({
  listGoogleCampaignCreatives: async () => [],
}));

vi.mock("~/lib/ads/campaign-detail.server", () => ({
  buildCampaignPerformance: () => ({
    available: false,
    dailyBudgetCents: null,
    spend7dCents: null,
    reportedRoas: null,
    realRoas: null,
  }),
}));

vi.mock("~/lib/screener/campaign-ads.server", () => ({
  loadCachedAdScorecards: (...a: unknown[]) => loadCachedSpy(...a),
}));

vi.mock("~/lib/screener/types", () => ({
  DEFAULT_SPEND_CENTS: 5000,
  MIN_SPEND_CENTS: 100,
  MAX_SPEND_CENTS: 100000,
}));

// A Meta external id is a long numeric string — NOT a uuid. Hitting v_campaigns_flat
// (whose id column is uuid) with it makes Postgres throw 22P02.
const META_EXTERNAL_ID = "23848262133110025";

function loadDetail(campaignId: string, platform = "Meta") {
  const request = new Request(
    `http://localhost/app/campaigns/${campaignId}?platform=${platform}`,
  );
  return loader({ request, params: { campaignId } } as unknown as LoaderFunctionArgs);
}

beforeEach(() => {
  getSpy.mockReset();
  resolveDimSpy.mockReset();
  resolveShopIdSpy.mockReset();
  resolveShopIdSpy.mockResolvedValue("shop-uuid-1");
  metaForShopSpy.mockReset();
  metaForShopSpy.mockResolvedValue({ client: { get: vi.fn() }, adAccountId: "act_1" });
  listCampaignsSpy.mockReset();
  listCreativesSpy.mockReset();
  listCreativesSpy.mockResolvedValue([]);
  listAdInsightsSpy.mockReset();
  listAdInsightsSpy.mockResolvedValue([]);
  loadCachedSpy.mockReset();
  loadCachedSpy.mockResolvedValue([]);
});

describe("campaign detail loader — non-uuid (Meta external) id", () => {
  it("recovers via the live-Meta fallback instead of 500ing on the uuid cast", async () => {
    // The dim-uuid lookup would throw 22P02 if ever called with a non-uuid id.
    getSpy.mockRejectedValue({
      code: "22P02",
      message: `campaigns.get: invalid input syntax for type uuid: "${META_EXTERNAL_ID}"`,
    });
    // Not ingested → no external→dim mapping.
    resolveDimSpy.mockResolvedValue(null);
    // Live Meta account owns the campaign → identity-only detail.
    listCampaignsSpy.mockResolvedValue([
      { id: META_EXTERNAL_ID, name: "Retargeting", status: "ACTIVE" },
    ]);

    const res = await loadDetail(META_EXTERNAL_ID);
    const body = (await res.json()) as {
      error: { code: string } | null;
      detail: { name: string; metaExternalId: string | null } | null;
    };

    expect(body.error).toBeNull();
    expect(body.detail).not.toBeNull();
    expect(body.detail?.name).toBe("Retargeting");
    expect(body.detail?.metaExternalId).toBe(META_EXTERNAL_ID);
    // The non-uuid id must never be passed into the uuid-typed dim lookup.
    expect(getSpy).not.toHaveBeenCalledWith(META_EXTERNAL_ID);
  });
});

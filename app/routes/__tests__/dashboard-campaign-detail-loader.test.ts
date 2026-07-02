import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
// vitest hoists the vi.mock() calls below above this import, so the route module
// loads with the session + data boundaries already mocked. resolveCampaignScore,
// the aggregate/blend, and dashboardJson run for REAL — only Supabase/Meta/Claude
// boundaries are faked, so the test exercises the actual creative-half blend.
import { loader } from "../dashboard.api.campaigns.$id";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import type { AdScorecard } from "~/lib/screener/campaign-ads.server";
import type { ScoreCard, MetricScore } from "~/lib/screener/types";
import type { CampaignGradeRow } from "~/lib/types";

const { getSpy, gradesSpy, loadCreativesSpy } = vi.hoisted(() => ({
  getSpy: vi.fn(),
  gradesSpy: vi.fn(),
  loadCreativesSpy: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: async () => ({
    shopId: "shop-uuid-1",
    shopDomain: "acme.myshopify.com",
    sessionId: "sess-1",
  }),
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    campaigns: { get: (...a: unknown[]) => getSpy(...a) },
    analytics: { campaignGrades: (...a: unknown[]) => gradesSpy(...a) },
  }),
  // dashboardJson (via http.server) imports CalderynError; provide a real class.
  CalderynError: class CalderynError extends Error {
    status = 500;
    code = "error";
  },
}));

vi.mock("~/lib/screener/campaign-creatives-load.server", () => ({
  loadCampaignCreativeScorecards: (...a: unknown[]) => loadCreativesSpy(...a),
}));

function card(composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): ScoreCard {
  return {
    composite, grade: "okay", confidence: "high", summary: "", metrics,
    outcomes: {
      estimatedRoas: 0, roasLow: 0, roasHigh: 0, breakEvenRoas: 0,
      predictedCtr: 0, holdRate: 0, assumedSpendCents: 0, predictedRevenueCents: 0,
      mappedSku: null, skuPriceCents: null,
    },
    tips,
  };
}
function done(adId: string, composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): AdScorecard {
  return { adId, status: "done", scorecard: card(composite, metrics, tips), error: null };
}
const grade = (over: Partial<CampaignGradeRow> = {}): CampaignGradeRow => ({
  campaign_id: "c1", name: "C", grade: "", roas: 4, break_even_roas: 2,
  spend_cents: 10000, revenue_cents: 40000, day_bucket: "2026-06-27", ...over,
});

function loadDetail(id: string) {
  const request = new Request(`http://localhost/dashboard/api/campaigns/${id}`);
  return loader({ request, params: { id } } as unknown as LoaderFunctionArgs);
}

beforeEach(() => {
  getSpy.mockReset();
  getSpy.mockResolvedValue({ id: "c1", name: "C", platform: "Meta", status: "active" });
  gradesSpy.mockReset();
  gradesSpy.mockResolvedValue([grade()]);
  loadCreativesSpy.mockReset();
});

describe("dashboard campaign detail loader — full-blend score", () => {
  it("blends the creative half from cached scorecards and carries weakDimensions", async () => {
    const weak: MetricScore = { id: "hook", group: "attention", label: "Hook strength", score: 40, reasoning: "" };
    // One active ad with a cached scorecard, one paused ad (must not contribute).
    loadCreativesSpy.mockResolvedValue({
      creatives: [
        { adId: "a1", adName: "Ad 1", status: "ACTIVE", creative: {} },
        { adId: "a2", adName: "Ad 2", status: "PAUSED", creative: {} },
      ],
      scorecards: [done("a1", 70, [weak], ["Tighten the hook"])],
      assumedSpendCents: DEFAULT_SPEND_CENTS,
      metaConnected: true,
      creativesError: null,
    });

    const res = await loadDetail("c1");
    const body = (await res.json()) as {
      campaign: {
        calderynScore: {
          performance: number | null;
          creative: number | null;
          value: number | null;
          adsCovered: number;
          adsTotal: number;
          weakDimensions: { label: string; score: number; adId: string }[];
          tips: string[];
        };
      };
    };

    // Cache-only load: NO assumedSpendCents-from-Claude; the creatives loader is
    // called with session.shopId (UUID) for both the shop identity args so first-party
    // (null-domain) sessions work. The UUID fast-path in resolveShopId handles this.
    expect(loadCreativesSpy).toHaveBeenCalledWith(
      "shop-uuid-1", "shop-uuid-1", "c1", DEFAULT_SPEND_CENTS,
    );
    const s = body.campaign.calderynScore;
    expect(s.performance).toBe(100); // clamp(round(50*4/2),0,100)
    expect(s.creative).toBe(70); // non-null creative half now populates
    expect(s.value).toBe(91); // round(0.7*100 + 0.3*70)
    // Only the active ad contributes; paused a2 is excluded from coverage.
    expect(s.adsCovered).toBe(1);
    expect(s.adsTotal).toBe(1);
    expect(s.weakDimensions).toEqual([{ label: "Hook strength", score: 40, adId: "a1" }]);
    expect(s.tips).toEqual(["Tighten the hook"]);
  });
});

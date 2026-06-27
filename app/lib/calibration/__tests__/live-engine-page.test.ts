import { describe, it, expect } from "vitest";
import { buildLiveEnginePageData } from "../live-engine-page.server";
import type { AuditEntry, SKU } from "../../types";

const NOW = new Date("2026-06-21T12:00:00Z").getTime();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

type Client = Parameters<typeof buildLiveEnginePageData>[0];

function auditRow(p: Partial<AuditEntry> & Pick<AuditEntry, "id" | "action_kind">): AuditEntry {
  return {
    outcome: "succeeded",
    target: "",
    dollar_impact_at_exec: 0,
    pre_state: null,
    post_state: null,
    created_at: iso(0.02),
    actor: "merchant",
    undo_eligible: false,
    alert_id: null,
    detector_id: "campaign_below_breakeven",
    ...p,
  } as AuditEntry;
}

function sku(p: Partial<SKU> & Pick<SKU, "title" | "sku" | "velocity" | "days_of_cover">): SKU {
  return {
    id: p.sku,
    on_hand: 0,
    locations: {},
    sources: [],
    demand: null,
    suggested_transfer: null,
    locations_detail: [],
    ship_cost_source: null,
    ship_cost_confidence: null,
    ship_pnl_cents: null,
    ...p,
  } as unknown as SKU;
}

function stubClient(): Client {
  return {
    calibration: {
      liveEngine: async () => ({
        autopilotEnabled: true,
        moneyProtectedWeekCents: 7000,
        features: [
          {
            detectorId: "campaign_below_breakeven",
            actionKind: "pause_campaign",
            name: "Pause campaign",
            watching: "Campaign is losing money",
            enabled: true,
            moneyCents: 8000,
            actions: 2,
            lastAt: iso(0.01),
          },
        ],
      }),
      pairEvidence: async () => [
        { detectorId: "campaign_below_breakeven", actionKind: "pause_campaign", alpha: 8, beta: 0, graduationThreshold: 80, graduated: true },
        { detectorId: "sku_stockout_vs_spend", actionKind: "pause_campaign", alpha: 2, beta: 1, graduationThreshold: 80, graduated: false },
      ],
      get: async () => ({ pct: 42, updated_at: null }),
      nearGraduation: async () => 1,
    },
    queue: {
      list: async () => [
        {
          alertId: "a1",
          detector_id: "sku_stockout_vs_spend",
          action_kind: "pause_campaign",
          title: "Pause Trailhead Cap ads",
          dollar_impact: 394000,
          confidence: 52,
          reasoning: "Sold out 3 days but still spending",
        },
      ],
    },
    audit: {
      list: async () => [
        auditRow({ id: "e1", action_kind: "pause_campaign", actor: "autopilot", target: "Alpine Crew Sock", dollar_impact_at_exec: 121000, created_at: iso(0.02), trigger_reason: "Auto-pause: Campaign is losing money" }),
        auditRow({ id: "e2", action_kind: "pause_campaign", actor: "merchant", target: "Summit Tee retarget", detector_id: "sku_stockout_vs_spend", dollar_impact_at_exec: 50000, created_at: iso(0.1) }),
        auditRow({ id: "e3", action_kind: "pause_campaign", actor: "merchant", undo_of: "e1", target: "Alpine Crew Sock", dollar_impact_at_exec: -121000, created_at: iso(0.05) }),
        auditRow({ id: "e4", action_kind: "pause_campaign", actor: "autopilot", outcome: "failed", failure_reason: "daily budget cap reached", target: "Ridge Beanie", created_at: iso(0.2) }),
      ],
    },
    skus: {
      list: async () => [
        sku({ title: "Basecamp Water Bottle", sku: "BWB", velocity: 2, days_of_cover: 9, on_hand: 18 }),
        sku({ title: "NeverOut Hoodie", sku: "NOH", velocity: 0, days_of_cover: 999, on_hand: 50 }),
        sku({ title: "Slow Mover", sku: "SLM", velocity: 0.1, days_of_cover: 300, on_hand: 30 }),
      ],
    },
    alerts: {
      list: async () => [
        { id: "al9", detector_id: "campaign_below_breakeven", severity: "high", status: "open", dollar_impact: 621600, claude_rank: 1, created_at: iso(0.3), title: "Summit Tee is bleeding money", narrative: "ROAS 0.7 for 5 days", campaign: "Summit", campaign_id: null, campaign_external_id: null, sku: null, evidence: {} },
        // The open alert behind proposal "a1": its narrative + evidence feed the
        // pending inspector. Internal id + title keys are suppressed; the rest is
        // humanized. Impact kept below al9 so it stays the predictions top alert.
        { id: "a1", detector_id: "sku_stockout_vs_spend", severity: "high", status: "open", dollar_impact: 394000, claude_rank: 2, created_at: iso(0.2), title: "Trailhead Cap sold out", narrative: "Sold out 3 days but still spending", campaign: null, campaign_id: null, campaign_external_id: null, sku: null, evidence: { inventory_item_id: "gid://shopify/InventoryItem/1", title: "Trailhead Cap", stock: "0 units", days_of_cover: "0", spend_this_7d_usd: "120" } },
      ],
    },
    analytics: {
      campaignGrades: async () => [
        { campaign_id: "c1", name: "Summit Logo Tee", grade: "poor", roas: 0.7, break_even_roas: 1.5, spend_cents: 0, revenue_cents: 0, day_bucket: "" },
        { campaign_id: "c2", name: "Healthy PMax", grade: "winning", roas: 3.2, break_even_roas: 1.5, spend_cents: 0, revenue_cents: 0, day_bucket: "" },
      ],
    },
  } as unknown as Client;
}

const NO_DASH = /[—–]/;
function assertNoDashesDeep(v: unknown) {
  if (typeof v === "string") expect(v).not.toMatch(NO_DASH);
  else if (Array.isArray(v)) v.forEach(assertNoDashesDeep);
  else if (v && typeof v === "object") Object.values(v).forEach(assertNoDashesDeep);
}

describe("buildLiveEnginePageData", () => {
  it("passes through autopilot summary + calibration headline", async () => {
    const d = await buildLiveEnginePageData(stubClient(), undefined, NOW);
    expect(d.autopilotEnabled).toBe(true);
    expect(d.moneyProtectedWeekCents).toBe(7000);
    expect(d.calibrationPct).toBe(42);
    expect(d.nearGraduation).toBe(1);
    expect(d.features[0].lastText.startsWith("last acted")).toBe(true);
  });

  it("blends the pipeline so both the auto and ask branches appear when both exist", async () => {
    const d = await buildLiveEnginePageData(stubClient(), undefined, NOW);
    expect(d.pipeline.some((c) => c.auto)).toBe(true); // graduated autopilot row
    expect(d.pipeline.some((c) => !c.auto)).toBe(true); // proposal at 52% < 80%
    for (const c of d.pipeline) {
      expect(c.factors).toHaveLength(3);
      expect(c.threshold).toBeGreaterThan(0);
    }
  });

  it("maps real audit rows to honest trace tags + inspector detail", async () => {
    const d = await buildLiveEnginePageData(stubClient(), undefined, NOW);
    const byId = (id: string) => d.trace.find((t) => t.id === id)!;
    expect(byId("e1").tag).toBe("AUTO");
    expect(byId("e1").moneyCents).toBe(121000);
    expect(byId("e1").factors).not.toBeNull();
    expect(byId("e1").decisionLabel).toBe("DONE AUTOMATICALLY");
    expect(byId("e2").tag).toBe("APPROVED");
    expect(byId("e3").tag).toBe("UNDONE");
    expect(byId("e4").tag).toBe("BLOCKED");
    expect(byId("e4").decisionNote).toContain("daily budget cap reached");
  });

  it("builds pending proposals: plain why, humanized figures, approve/deny copy", async () => {
    const d = await buildLiveEnginePageData(stubClient(), undefined, NOW);
    expect(d.pending).toHaveLength(1);
    const p = d.pending[0];
    expect(p.alertId).toBe("a1");
    expect(p.actionKind).toBe("pause_campaign");
    expect(p.actionLabel).toBe("Pause campaign");
    expect(p.dollarImpactCents).toBe(394000);
    expect(p.confidence).toBe(52);
    expect(p.threshold).toBe(80); // the pair's real graduation bar
    // signal comes from the matched alert's narrative, not raw fields
    expect(p.signal).toBe("Sold out 3 days but still spending");
    // internal id + product name suppressed; the rest humanized + formatted, capped at 3
    expect(p.stats).toEqual([
      { label: "Total stock", value: "0 units" },
      { label: "Days until sold out", value: "0 days" },
      { label: "Spend, this 7 days", value: "$120" },
    ]);
    expect(p.approveText).toBe("Calderyn will pause campaign now. You can undo it anytime from your history.");
    expect(p.denyText).toContain("Nothing changes");
    expect(p.trustLine).toContain("Still learning this one");
  });

  it("derives predictions from real signals only (runway + below-breakeven + top alert)", async () => {
    const d = await buildLiveEnginePageData(stubClient(), undefined, NOW);
    const stock = d.predictions.find((p) => p.kind === "stockout");
    expect(stock?.text).toContain("Basecamp Water Bottle");
    expect(stock?.text).toContain("9 days");
    // velocity=0 (NeverOut) and 300-day cover (Slow Mover) are excluded
    expect(d.predictions.filter((p) => p.kind === "stockout")).toHaveLength(1);
    const camp = d.predictions.find((p) => p.kind === "campaign");
    expect(camp?.text).toContain("Summit Logo Tee"); // winning campaign excluded
    expect(d.predictions.filter((p) => p.kind === "campaign")).toHaveLength(1);
    expect(d.predictions.find((p) => p.kind === "alert")?.text).toContain("Summit Tee");
  });

  it("produces no em or en dashes anywhere in the merchant-facing payload", async () => {
    const d = await buildLiveEnginePageData(stubClient(), undefined, NOW);
    assertNoDashesDeep(d);
  });

  it("degrades to empty sections without throwing when reads reject", async () => {
    const broken = {
      calibration: {
        liveEngine: async () => { throw new Error("x"); },
        pairEvidence: async () => { throw new Error("x"); },
        get: async () => { throw new Error("x"); },
        nearGraduation: async () => { throw new Error("x"); },
      },
      queue: { list: async () => { throw new Error("x"); } },
      audit: { list: async () => { throw new Error("x"); } },
      skus: { list: async () => { throw new Error("x"); } },
      alerts: { list: async () => { throw new Error("x"); } },
      analytics: { campaignGrades: async () => { throw new Error("x"); } },
    } as unknown as Client;
    const d = await buildLiveEnginePageData(broken, undefined, NOW);
    expect(d.features).toEqual([]);
    expect(d.trace).toEqual([]);
    expect(d.pending).toEqual([]);
    expect(d.predictions).toEqual([]);
    expect(d.autopilotEnabled).toBe(false);
  });
});

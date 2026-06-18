import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropic } from "~/lib/assistant/anthropic.server";
import { directionTemplate, resolveCampaignDirection, type ReasonFacts } from "../direction-reason.server";

vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: vi.fn(),
  assistantModel: () => "claude-test",
}));

const facts: ReasonFacts = { roas: 1.5, breakEvenRoas: 1, dataSufficient: true, status: "active" };

describe("directionTemplate", () => {
  it("explains scale_up in plain English referencing the return and break-even", () => {
    const t = directionTemplate("scale_up", facts);
    expect(t).toMatch(/winning|earning/i);
    expect(t).toContain("1.5×");
    expect(t).not.toMatch(/ROAS/); // no jargon (matches scale-reason.ts house style)
  });
  it("explains pause as losing money", () => {
    expect(directionTemplate("pause", { ...facts, roas: 0.5 })).toMatch(/losing|pause/i);
  });
  it("explains scale_down as trimming an underperformer", () => {
    expect(directionTemplate("scale_down", { ...facts, roas: 0.8 })).toMatch(/below|trim|underperform/i);
  });
  it("explains keep for an at-break-even campaign", () => {
    expect(directionTemplate("keep", { ...facts, roas: 1.0 })).toMatch(/hold|steady|break/i);
  });
  it("says paused when the campaign is paused", () => {
    expect(directionTemplate("keep", { ...facts, status: "paused" })).toMatch(/paused/i);
  });
  it("says not enough data when dataSufficient is false", () => {
    expect(directionTemplate("keep", { ...facts, dataSufficient: false })).toMatch(/not enough|yet/i);
  });
});

// Minimal chainable Supabase double: supports .from().select().eq()*.maybeSingle()
// and .from().upsert(); records upserts and counts reads.
function fakeSb(cachedRow: Record<string, unknown> | null) {
  const calls = { upserts: [] as Record<string, unknown>[], reads: 0 };
  const sb = {
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          calls.reads += 1;
          return { data: cachedRow, error: null };
        },
        upsert: (row: Record<string, unknown>) => {
          calls.upserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const baseArgs = {
  shopId: "shop-1",
  campaignId: "cmp-1",
  roas: 1.5,
  breakEvenRoas: 1,
  contributionMargin: 0.4,
  status: "active" as const,
  currentBudgetCents: 10000,
  alerts: [],
  guardrails: { autopilot_max_budget_increase_pct: 20, autopilot_max_budget_cut_pct: 50, autopilot_max_daily_budget_cents: null },
  now: new Date("2026-06-18T12:00:00Z"),
};

function mockClaude(text: string) {
  (getAnthropic as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) },
  });
}
function mockClaudeThrows() {
  (getAnthropic as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    messages: { create: vi.fn().mockRejectedValue(new Error("boom")) },
  });
}

describe("resolveCampaignDirection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the Claude sentence and caches it on a cache miss", async () => {
    mockClaude("This winner has room to grow.");
    const { sb, calls } = fakeSb(null);
    // winning + scaling alert -> scale_up
    const r = await resolveCampaignDirection({
      ...baseArgs,
      alerts: [{ detector_id: "campaign_scaling_opportunity", status: "open", campaign_id: "cmp-1" }],
      sb,
    });
    expect(r.direction).toBe("scale_up");
    expect(r.reason).toBe("This winner has room to grow.");
    expect(r.reasonSource).toBe("claude");
    expect(r.suggestedBudgetCents).toBe(12000);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0]).toMatchObject({ direction: "scale_up", source: "claude", as_of_date: "2026-06-18" });
  });

  it("falls back to the template (source=template) when Claude throws", async () => {
    mockClaudeThrows();
    const { sb } = fakeSb(null);
    const r = await resolveCampaignDirection({ ...baseArgs, sb });
    expect(r.reasonSource).toBe("template");
    expect(r.reason).toMatch(/break even|steady|winning/i);
  });

  it("reuses the cached reason and does NOT call Claude on a hit", async () => {
    const createSpy = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "SHOULD NOT BE USED" }] });
    (getAnthropic as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ messages: { create: createSpy } });
    const { sb } = fakeSb({ reason: "Cached sentence.", source: "claude" });
    const r = await resolveCampaignDirection({ ...baseArgs, sb });
    expect(r.reason).toBe("Cached sentence.");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("NEVER lets Claude change the decided direction (even if the sentence says otherwise)", async () => {
    mockClaude("You should pause this immediately.");
    const { sb } = fakeSb(null);
    // roas 1.5 vs BE 1, scaling alert -> deterministic scale_up
    const r = await resolveCampaignDirection({
      ...baseArgs,
      alerts: [{ detector_id: "campaign_scaling_opportunity", status: "open", campaign_id: "cmp-1" }],
      sb,
    });
    expect(r.direction).toBe("scale_up");
    expect(r.actionKind).toBe("increase_campaign_budget");
  });

  it("returns keep + dataSufficient false + no action when metrics are missing", async () => {
    mockClaude("n/a");
    const { sb } = fakeSb(null);
    const r = await resolveCampaignDirection({ ...baseArgs, roas: null, sb });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
    expect(r.dataSufficient).toBe(false);
  });

  it("falls back to the template when Claude returns no text block", async () => {
    (getAnthropic as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      messages: { create: vi.fn().mockResolvedValue({ content: [] }) },
    });
    const { sb } = fakeSb(null);
    const r = await resolveCampaignDirection({ ...baseArgs, sb });
    expect(r.reasonSource).toBe("template");
  });
});

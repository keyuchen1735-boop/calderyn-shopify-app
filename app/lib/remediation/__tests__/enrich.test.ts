// app/lib/remediation/__tests__/enrich.test.ts
import { describe, it, expect, vi } from "vitest";
import { enrichRemediation } from "../enrich.server";
import type { Alert } from "../../types";
import type { RemediationPlan } from "../types";
import type { SupabaseClient } from "@supabase/supabase-js";

const LOSER_SKU = "sku-loser-uuid";
const WINNER_SKU = "sku-winner-uuid";
const LOSER_CAMP = "camp-loser-uuid";
const WINNER_CAMP = "camp-winner-uuid";

function plan(over: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
    moves: [
      { kind: "reallocate_to_winner", dollarImpactCents: 530449, executor: null, label: "Move ad budget to a higher-margin product" },
      { kind: "cut_ads", dollarImpactCents: 530449, executor: null, label: "Cut the ad spend driving the loss" },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "reallocate_to_winner",
    structurallyDead: false,
    ...over,
  };
}

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 530449,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "SUMMIT-TEE-M",
    evidence: { sku_id: LOSER_SKU, gross_unit_margin_usd: 23, cac_per_unit_usd: 170 },
    ...over,
  } as Alert;
}

// Fake supabase: returns the loser row, then the winner-pool rows, per .from() table.
// loserError/winnersError simulate a DB failure on the respective query.
function fakeSb(rows: {
  loser?: Record<string, unknown> | null;
  winners?: Record<string, unknown>[];
  loserError?: Error | null;
  winnersError?: Error | null;
}) {
  function builder() {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: rows.loser ?? null, error: rows.loserError ?? null }));
    // winner pool fetch resolves the awaited builder to { data, error }
    chain.then = (res: (v: { data: unknown; error: Error | null }) => void) =>
      res({ data: rows.winners ?? [], error: rows.winnersError ?? null });
    return chain;
  }
  return { from: vi.fn(() => builder()) } as unknown as SupabaseClient;
}

describe("enrichRemediation — reallocate eligibility", () => {
  it("dedicated loser campaign + qualifying winner → reallocate_spend_sku button with named winner + amount", async () => {
    const sb = fakeSb({
      loser: {
        sku_id: LOSER_SKU, contribution_per_unit_cents: 2300,
        dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta",
        dedicated_campaign_budget_cents: 45000,
      },
      winners: [
        { sku_id: WINNER_SKU, title: "Hydration Bottle", winner_rank: 1,
          dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "meta",
          dedicated_campaign_budget_cents: 7000, contribution_per_unit_cents: 1800 },
      ],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBe("reallocate_spend_sku");
    expect(realloc.target?.loserCampaignId).toBe(LOSER_CAMP);
    expect(realloc.target?.winnerCampaignId).toBe(WINNER_CAMP);
    expect(realloc.target?.winnerLabel).toBe("Hydration Bottle");
    expect(realloc.target?.amountCents).toBeGreaterThan(0);
    expect(realloc.target?.amountCents).toBeLessThan(45000); // must leave source above zero
    expect(realloc.ineligibleReason).toBeUndefined();
  });

  it("no dedicated loser campaign (shared Advantage+) → advisory, ineligibleReason set, NOT a button", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: null, dedicated_campaign_platform: null, dedicated_campaign_budget_cents: null },
      winners: [{ sku_id: WINNER_SKU, title: "Hydration Bottle", winner_rank: 1, dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 7000, contribution_per_unit_cents: 1800 }],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/shared campaign|Advantage/i);
  });

  it("dedicated loser campaign but NO qualifying winner → reallocate stays advisory", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 45000 },
      winners: [], // no winner_rank rows
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/no qualifying winner/i);
  });

  it("winner on a different platform than the loser → advisory (Meta-only shift)", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 45000 },
      winners: [{ sku_id: WINNER_SKU, title: "Hydration Bottle", winner_rank: 1, dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "google", dedicated_campaign_budget_cents: 7000, contribution_per_unit_cents: 1800 }],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/same platform|Meta/i);
  });

  it("leaves a plan with no reallocate move untouched (e.g. structurally dead → discontinue)", async () => {
    const sb = fakeSb({ loser: null, winners: [] });
    const dead = plan({ moves: [{ kind: "discontinue", dollarImpactCents: 5000, executor: "discontinue_sku", label: "Stop reordering this product" }, { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" }], recommended: "discontinue", structurallyDead: true });
    const out = await enrichRemediation(alert(), dead, sb, "shop-1");
    expect(out.moves.find((m) => m.kind === "discontinue")?.executor).toBe("discontinue_sku");
  });

  it("alert with neither sku_id on evidence nor a sku code → both ad moves advisory with a reason (rule 12)", async () => {
    const sb = fakeSb({ loser: null, winners: [] });
    const out = await enrichRemediation(alert({ evidence: {}, sku: null }), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    const cut = out.moves.find((m) => m.kind === "cut_ads")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/SKU|review manually/i);
    // cut_ads must not be a bare label either.
    expect(cut.executor).toBeNull();
    expect(cut.ineligibleReason).toBeTruthy();
  });
});

describe("enrichRemediation — no bare labels (rule 12)", () => {
  const bareNullMoves = (p: RemediationPlan) =>
    p.moves.filter((m) => m.executor == null && !m.ineligibleReason);

  it("shared Advantage+ loser → cut_ads carries a reason too, and no move is a bare null label", async () => {
    const sb = fakeSb({
      loser: {
        sku_id: LOSER_SKU, contribution_per_unit_cents: 2300,
        dedicated_campaign_id: null, dedicated_campaign_platform: null,
        dedicated_campaign_budget_cents: null,
      },
      winners: [],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const cut = out.moves.find((m) => m.kind === "cut_ads")!;
    expect(cut.executor).toBeNull();
    expect(cut.ineligibleReason).toBeTruthy();
    expect(bareNullMoves(out)).toHaveLength(0);
  });
});

describe("enrichRemediation — both moves enriched in one pass (no-clobber invariant)", () => {
  it("loser with dedicated Meta campaign AND qualifying Meta winner → cut_ads executor set AND reallocate executor set on the same returned plan", async () => {
    const sb = fakeSb({
      loser: {
        sku_id: LOSER_SKU,
        contribution_per_unit_cents: 2300,
        dedicated_campaign_id: LOSER_CAMP,
        dedicated_campaign_platform: "meta",
        dedicated_campaign_budget_cents: 45000,
      },
      winners: [
        {
          sku_id: WINNER_SKU,
          title: "Hydration Bottle",
          winner_rank: 1,
          dedicated_campaign_id: WINNER_CAMP,
          dedicated_campaign_platform: "meta",
          dedicated_campaign_budget_cents: 7000,
          contribution_per_unit_cents: 1800,
        },
      ],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");

    // cut_ads must be executable with the loser campaign wired in
    const cut = out.moves.find((m) => m.kind === "cut_ads")!;
    expect(cut.executor).not.toBeNull();
    expect(cut.target?.loserCampaignId).toBe(LOSER_CAMP);

    // reallocate_to_winner must ALSO be executable with winner details — same plan, not clobbered
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBe("reallocate_spend_sku");
    expect(realloc.target?.winnerLabel).toBe("Hydration Bottle");
    expect(realloc.target?.winnerSkuId).toBe(WINNER_SKU);
    expect(realloc.target?.amountCents).toBeGreaterThan(0);
  });
});

describe("enrichRemediation — winner-query failure preserves cut_ads (rule 12)", () => {
  it("keeps cut_ads executable when the winner query throws after cut_ads was enriched", async () => {
    // Loser has a dedicated mutable Meta campaign → cut_ads is enriched first.
    // The winner-pool query then fails. The catch must fall back to the ENRICHED
    // plan (cut_ads button preserved), not the base plan (which would discard it).
    const sb = fakeSb({
      loser: {
        sku_id: LOSER_SKU, contribution_per_unit_cents: 2300,
        dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta",
        dedicated_campaign_budget_cents: 45000,
      },
      winnersError: new Error("winner pool query failed"),
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");

    const cut = out.moves.find((m) => m.kind === "cut_ads")!;
    expect(cut.executor).not.toBeNull(); // survived the winner-query failure
    expect(cut.target?.loserCampaignId).toBe(LOSER_CAMP);

    // reallocate could not resolve a winner → advisory with the DB-error reason.
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/review manually/i);
  });
});

describe("enrichRemediation — cut_ads", () => {
  it("dedicated loser campaign → cut_ads becomes reduce_campaign_budget with loserCampaignId, even with no winner", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 45000 },
      winners: [],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const cut = out.moves.find((m) => m.kind === "cut_ads")!;
    expect(cut.executor).toBe("reduce_campaign_budget");
    expect(cut.target?.loserCampaignId).toBe(LOSER_CAMP);
    // Carries the loser's current budget so cut_ads can compute the reduced
    // budget on a SKU alert whose campaign isn't in the surface's campaign list.
    expect(cut.target?.loserCampaignBudgetCents).toBe(45000);
  });

  it("no dedicated loser campaign → cut_ads stays advisory too", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: null, dedicated_campaign_platform: null, dedicated_campaign_budget_cents: null },
      winners: [],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    expect(out.moves.find((m) => m.kind === "cut_ads")?.executor).toBeNull();
  });

  it("enriches via alert.sku when v_alerts_view evidence omits sku_id (real negative_unit_economics shape)", async () => {
    const sb = fakeSb({
      loser: {
        sku_id: LOSER_SKU, contribution_per_unit_cents: 2169,
        dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta",
        dedicated_campaign_budget_cents: 45000,
      },
      winners: [
        { sku_id: WINNER_SKU, title: "Switchback Cap", winner_rank: 1,
          dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "meta",
          dedicated_campaign_budget_cents: 3000, contribution_per_unit_cents: 1900 },
      ],
    });
    // v_alerts_view evidence for this detector carries only margins — no sku_id.
    // The SKU is still identified by alert.sku; enrich must resolve the loser
    // from it, or the ad-budget moves stay (wrongly) advisory.
    const out = await enrichRemediation(
      alert({ evidence: { gross_unit_margin_usd: 21.69, cac_per_unit_usd: 200 } }),
      plan(),
      sb,
      "shop-1",
    );
    expect(out.moves.find((m) => m.kind === "cut_ads")!.executor).not.toBeNull();
    expect(out.moves.find((m) => m.kind === "reallocate_to_winner")!.executor).toBe("reallocate_spend_sku");
  });
});

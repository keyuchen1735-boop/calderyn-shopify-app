// app/lib/remediation/__tests__/enrich-review-pricing.test.ts
import { describe, it, expect, vi } from "vitest";
import { enrichRemediation } from "../enrich.server";
import type { Alert } from "../../types";
import type { RemediationPlan } from "../types";
import type { SupabaseClient } from "@supabase/supabase-js";

const VARIANT = "gid://shopify/ProductVariant/123";

function reviewPlan(): RemediationPlan {
  return {
    moves: [
      { kind: "review_pricing", dollarImpactCents: 12000, executor: null, label: "Raise price or renegotiate cost" },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "review_pricing",
    structurallyDead: false,
  };
}

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    detector_id: "margin_erosion",
    severity: "high",
    status: "open",
    dollar_impact: 12000,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "SUMMIT-TEE-M",
    evidence: { baseline_unit_margin_usd: 9, current_unit_margin_usd: 7 },
    ...over,
  } as Alert;
}

/** sku_dim resolver stub: one maybeSingle() returning id + external_id. */
function sb(row: { id: string; external_id: string | null } | null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

function reviewMove(p: RemediationPlan) {
  return p.moves.find((m) => m.kind === "review_pricing")!;
}

describe("enrichRemediation — review_pricing → adjust_price", () => {
  it("margin_erosion with a baseline margin + linked variant → executable adjust_price button", async () => {
    const out = await enrichRemediation(alert(), reviewPlan(), sb({ id: "sku-1", external_id: VARIANT }), "shop-1");
    const m = reviewMove(out);
    expect(m.executor).toBe("adjust_price");
    expect(m.ineligibleReason).toBeUndefined();
    expect(m.target?.skuId).toBe("sku-1");
  });

  it("cogs_drift where cost rose + linked variant → executable", async () => {
    const a = alert({
      detector_id: "cogs_drift",
      evidence: { prior_unit_cost_usd: 5, current_unit_cost_usd: 7 },
    });
    const out = await enrichRemediation(a, reviewPlan(), sb({ id: "sku-1", external_id: VARIANT }), "shop-1");
    expect(reviewMove(out).executor).toBe("adjust_price");
  });

  it("no linked Shopify variant → advisory, NOT a button (rule 12)", async () => {
    const out = await enrichRemediation(alert(), reviewPlan(), sb({ id: "sku-1", external_id: null }), "shop-1");
    const m = reviewMove(out);
    expect(m.executor).toBeNull();
    expect(m.ineligibleReason).toBeTruthy();
  });

  it("margin_erosion with no baseline margin → advisory (no raise to make)", async () => {
    const out = await enrichRemediation(alert({ evidence: {} }), reviewPlan(), sb({ id: "sku-1", external_id: VARIANT }), "shop-1");
    expect(reviewMove(out).executor).toBeNull();
  });
});

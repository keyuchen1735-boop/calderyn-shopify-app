// Learned Rules contract (spec §7: "Rules are visible, attributable, undoable"):
// - undoRule deactivates the rule, and for a muted_pair ALSO clears
//   pair_calibration.merchant_disabled — "Hand it back any time from Learned
//   rules" was a dead end before this: the i_handle_this RPC set both flags but
//   the undo cleared only the rule, so graduationVerdict kept blocking forever.
// - learnedRules() renders plain-language summaries for every rule kind that
//   has a writer, including the PR-2 pair_blackout_hours.
import { describe, it, expect, vi, beforeEach } from "vitest";

const ruleMaybeSingle = vi.fn();
const rulesOrder = vi.fn();
/** Sibling-mute lookup result (the `.neq(id).limit(1)` query). */
const siblingLimit = vi.fn();
const ruleUpdates: Array<Record<string, unknown>> = [];
const pairUpdates: Array<Record<string, unknown>> = [];
/** Interleaved write log — the unmute MUST land before the rule deactivation. */
const writeOrder: string[] = [];

vi.mock("../supabase.server", () => ({
  resolveShopId: async (_domain: string) => "shop-1",
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "calibration_rule") {
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.neq = vi.fn().mockReturnValue(chain);
        chain.limit = siblingLimit;
        chain.maybeSingle = ruleMaybeSingle;
        chain.order = rulesOrder;
        return {
          select: () => chain,
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: async () => {
                ruleUpdates.push(patch);
                writeOrder.push("rule_deactivate");
                return { error: null };
              },
            }),
          }),
        };
      }
      if (table === "pair_calibration") {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                eq: async () => {
                  pairUpdates.push(patch);
                  writeOrder.push("pair_unmute");
                  return { error: null };
                },
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    },
  }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock
import { calderynClient } from "../calderyn.server";

describe("calibration.undoRule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ruleUpdates.length = 0;
    pairUpdates.length = 0;
    writeOrder.length = 0;
    // Default: no sibling active muted_pair rules for the pair.
    siblingLimit.mockResolvedValue({ data: [], error: null });
  });

  it("clears merchant_disabled BEFORE deactivating a muted_pair rule (retryable on partial failure)", async () => {
    ruleMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "rule-1",
        detector_id: "campaign_below_breakeven",
        action_kind: "pause_campaign",
        rule_kind: "muted_pair",
      },
      error: null,
    });

    await calderynClient("demo.myshopify.com").calibration.undoRule("rule-1");

    expect(ruleUpdates).toEqual([{ active: false }]);
    expect(pairUpdates).toHaveLength(1);
    expect(pairUpdates[0]).toMatchObject({ merchant_disabled: false });
    // Unmute first: if the rule deactivation then fails, the rule stays
    // visible and the merchant can retry — never an invisible permanent mute.
    expect(writeOrder).toEqual(["pair_unmute", "rule_deactivate"]);
  });

  it("keeps merchant_disabled set while ANOTHER active muted_pair rule remains (duplicates)", async () => {
    ruleMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "rule-1",
        detector_id: "campaign_below_breakeven",
        action_kind: "pause_campaign",
        rule_kind: "muted_pair",
      },
      error: null,
    });
    siblingLimit.mockResolvedValueOnce({ data: [{ id: "rule-dup" }], error: null });

    await calderynClient("demo.myshopify.com").calibration.undoRule("rule-1");

    expect(ruleUpdates).toEqual([{ active: false }]);
    expect(pairUpdates).toHaveLength(0);
  });

  it("deactivates a non-mute rule WITHOUT touching the pair row", async () => {
    ruleMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "rule-2",
        detector_id: "campaign_below_breakeven",
        action_kind: "pause_campaign",
        rule_kind: "pair_dollar_cap",
      },
      error: null,
    });

    await calderynClient("demo.myshopify.com").calibration.undoRule("rule-2");

    expect(ruleUpdates).toEqual([{ active: false }]);
    expect(pairUpdates).toHaveLength(0);
  });

  it("rejects (visible 404, no writes) when the rule is missing or already inactive", async () => {
    // The read filters active=true, so a stale tab re-undoing an inactive rule
    // lands here — and must NOT clear a mute a newer i_handle_this just set.
    ruleMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await expect(
      calderynClient("demo.myshopify.com").calibration.undoRule("rule-missing"),
    ).rejects.toMatchObject({ code: "RULE_NOT_FOUND" });
    expect(ruleUpdates).toHaveLength(0);
    expect(pairUpdates).toHaveLength(0);
  });
});

describe("calibration.learnedRules summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a plain-language summary for a learned pair_blackout_hours rule", async () => {
    rulesOrder.mockResolvedValueOnce({
      data: [
        {
          id: "rule-3",
          detector_id: "campaign_below_breakeven",
          action_kind: "pause_campaign",
          rule_kind: "pair_blackout_hours",
          rule_value: { hours: [3, 21] },
          created_at: "2026-07-02T00:00:00Z",
        },
      ],
      error: null,
    });

    const rules = await calderynClient("demo.myshopify.com").calibration.learnedRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].summary).toContain("03:00–04:00 UTC");
    expect(rules[0].summary).toContain("21:00–22:00 UTC");
    expect(rules[0].summary.toLowerCase()).toContain("hold off");
  });

  it("renders a dollar summary for pair_min_spend", async () => {
    rulesOrder.mockResolvedValueOnce({
      data: [
        {
          id: "rule-4",
          detector_id: "ad_tax_overload",
          action_kind: "reduce_campaign_budget",
          rule_kind: "pair_min_spend",
          rule_value: { cents: 5000 },
          created_at: "2026-07-02T00:00:00Z",
        },
      ],
      error: null,
    });

    const rules = await calderynClient("demo.myshopify.com").calibration.learnedRules();
    expect(rules[0].summary).toContain("$50");
  });
});

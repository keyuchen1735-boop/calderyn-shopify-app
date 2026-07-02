// wrong_timing structural learning (spec §5): reject hours are histogrammed
// per pair; a UTC hour bin reaching 3 becomes a pair_blackout_hours rule that
// the autopilot rule enforcer vetoes on. Exercised through recordRejection so
// the receipt contract (savedAsRule / ruleKind) is covered too.
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordRejection } from "../reject.server";

vi.mock("../recompute.server", () => ({
  recomputeShopCalibration: vi.fn().mockResolvedValue({ shopId: "shop-1", pairs: 1, raw: 25, display: 25 }),
}));

const at = (hourUtc: number, day = 1): string =>
  new Date(Date.UTC(2026, 5, day, hourUtc, 15, 0)).toISOString();

/** Stub supporting exactly the chains recordRejection + learnBlackoutHours use. */
function makeStub(opts: {
  /** created_at rows returned for the wrong_timing histogram query. */
  wrongTimingRows: Array<{ created_at: string }>;
  /** Existing active pair_blackout_hours rule, if any. */
  existingBlackout?: { id: string; rule_value: { hours: number[] } } | null;
}) {
  const feedbackInsert = vi.fn().mockResolvedValue({ error: null });

  // action_feedback histogram: select().eq()x5.gte().limit() → rows
  const fbChain: Record<string, unknown> = {};
  fbChain.eq = vi.fn().mockReturnValue(fbChain);
  fbChain.gte = vi.fn().mockReturnValue(fbChain);
  fbChain.limit = vi.fn().mockResolvedValue({ data: opts.wrongTimingRows, error: null });
  const feedbackSelect = vi.fn().mockReturnValue(fbChain);

  // calibration_rule existing-blackout read: select().eq()x5.limit().maybeSingle()
  const ruleReadChain: Record<string, unknown> = {};
  ruleReadChain.eq = vi.fn().mockReturnValue(ruleReadChain);
  ruleReadChain.limit = vi.fn().mockReturnValue(ruleReadChain);
  ruleReadChain.maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.existingBlackout ?? null, error: null });
  const ruleSelect = vi.fn().mockReturnValue(ruleReadChain);

  const insertedRuleSingle = vi.fn().mockResolvedValue({ data: { id: "rule-new-1" }, error: null });
  const ruleInsert = vi
    .fn()
    .mockReturnValue({ select: vi.fn().mockReturnValue({ single: insertedRuleSingle }) });

  const ruleUpdateEqId = vi.fn().mockResolvedValue({ error: null });
  const ruleUpdate = vi
    .fn()
    .mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: ruleUpdateEqId }) });

  // pair_calibration receipt reads: select().eq()x3.maybeSingle() → cold pair
  const pairChain: Record<string, unknown> = {};
  pairChain.eq = vi.fn().mockReturnValue(pairChain);
  pairChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const pairSelect = vi.fn().mockReturnValue(pairChain);

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "action_feedback") return { insert: feedbackInsert, select: feedbackSelect };
    if (table === "calibration_rule")
      return { select: ruleSelect, insert: ruleInsert, update: ruleUpdate };
    return { select: pairSelect };
  });

  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const sb = { from, rpc } as unknown as SupabaseClient;
  return { sb, feedbackInsert, ruleInsert, ruleUpdate };
}

const BASE = {
  alertId: "al-1",
  detectorId: "campaign_below_breakeven",
  actionKind: "pause_campaign" as const,
  reason: "wrong_timing" as const,
  dollarImpactCents: 4000,
};

describe("recordRejection — wrong_timing blackout learning", () => {
  it("3 rejects in the same UTC hour learn a pair_blackout_hours rule", async () => {
    const { sb, ruleInsert } = makeStub({
      wrongTimingRows: [{ created_at: at(3, 1) }, { created_at: at(3, 4) }, { created_at: at(3, 9) }],
    });
    const r = await recordRejection("shop-1", BASE, sb);
    expect(ruleInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule_kind: "pair_blackout_hours",
        rule_value: { hours: [3] },
        source: "wrong_timing",
        active: true,
      }),
    );
    expect(r.savedAsRule).toBe(true);
    expect(r.ruleKind).toBe("pair_blackout_hours");
  });

  it("scattered rejects below the bin threshold learn nothing", async () => {
    const { sb, ruleInsert } = makeStub({
      wrongTimingRows: [{ created_at: at(3) }, { created_at: at(3, 2) }, { created_at: at(14) }],
    });
    const r = await recordRejection("shop-1", BASE, sb);
    expect(ruleInsert).not.toHaveBeenCalled();
    expect(r.savedAsRule).toBe(false);
    expect(r.ruleKind).toBe(null);
  });

  it("multiple qualifying bins land together, sorted", async () => {
    const rows = [3, 3, 3, 21, 21, 21, 9].map((h, i) => ({ created_at: at(h, (i % 27) + 1) }));
    const { sb, ruleInsert } = makeStub({ wrongTimingRows: rows });
    await recordRejection("shop-1", BASE, sb);
    expect(ruleInsert).toHaveBeenCalledWith(
      expect.objectContaining({ rule_value: { hours: [3, 21] } }),
    );
  });

  it("an unchanged learned hour set is not re-written (no duplicate rules)", async () => {
    const { sb, ruleInsert, ruleUpdate } = makeStub({
      wrongTimingRows: [{ created_at: at(3) }, { created_at: at(3, 2) }, { created_at: at(3, 3) }],
      existingBlackout: { id: "rule-old", rule_value: { hours: [3] } },
    });
    const r = await recordRejection("shop-1", BASE, sb);
    expect(ruleInsert).not.toHaveBeenCalled();
    expect(ruleUpdate).not.toHaveBeenCalled();
    // The veto is active, so the receipt still reports the learned rule.
    expect(r.ruleKind).toBe("pair_blackout_hours");
  });

  it("a changed hour set supersedes the old rule (audit-linked, never duplicated)", async () => {
    const { sb, ruleInsert, ruleUpdate } = makeStub({
      wrongTimingRows: [3, 3, 3, 21, 21, 21].map((h, i) => ({ created_at: at(h, i + 1) })),
      existingBlackout: { id: "rule-old", rule_value: { hours: [3] } },
    });
    await recordRejection("shop-1", BASE, sb);
    expect(ruleInsert).toHaveBeenCalledWith(
      expect.objectContaining({ rule_value: { hours: [3, 21] } }),
    );
    expect(ruleUpdate).toHaveBeenCalledWith({ active: false, superseded_by: "rule-new-1" });
  });

  it("non-wrong_timing rejects never run the histogram", async () => {
    const { sb, ruleInsert } = makeStub({ wrongTimingRows: [] });
    const r = await recordRejection("shop-1", { ...BASE, reason: "i_handle_this" }, sb);
    // i_handle_this writes its own muted_pair rule — but never a blackout.
    expect(ruleInsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ rule_kind: "pair_blackout_hours" }),
    );
    expect(r.ruleKind).toBe("muted_pair");
  });
});

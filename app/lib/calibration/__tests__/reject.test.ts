import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordRejection } from "../reject.server";
import { confFromEv } from "../delta";
import { recomputeShopCalibration } from "../recompute.server";

vi.mock("../recompute.server", () => ({
  recomputeShopCalibration: vi.fn().mockResolvedValue({ shopId: "shop-1", pairs: 1, raw: 25, display: 25 }),
}));

/**
 * Build a stub SupabaseClient that satisfies the call pattern used in reject.server.ts.
 *
 * Tables touched:
 *   - pair_calibration: select(...).eq().eq().eq().maybeSingle()   [before + after reads]
 *   - action_feedback:  insert(...)
 *   - calibration_rule: update(...)/select(...)/insert(...)
 *   - rpc("calibration_record_rejection", ...)
 *
 * `pairRows` serves the two pair_calibration reads in order (rows[0]=before, rows[1]=after).
 */
function makeStub(overrides?: {
  fbError?: { message: string };
  rpcError?: { message: string };
  supError?: { message: string };
  selData?: { id: string }[];
  selError?: { message: string };
  insError?: { message: string };
  pairRows?: Array<Record<string, unknown> | null>;
}) {
  const fbInsert = vi.fn().mockResolvedValue({ error: overrides?.fbError ?? null });
  const rpc = vi.fn().mockResolvedValue({ error: overrides?.rpcError ?? null });
  const ruleInsert = vi.fn().mockResolvedValue({ error: overrides?.insError ?? null });
  const selLimit = vi.fn().mockResolvedValue({ data: overrides?.selData ?? [], error: overrides?.selError ?? null });
  const selEqActive = vi.fn().mockReturnValue({ limit: selLimit });
  const selEqKind = vi.fn().mockReturnValue({ eq: selEqActive });
  const selEqAction = vi.fn().mockReturnValue({ eq: selEqKind });
  const selEqDetector = vi.fn().mockReturnValue({ eq: selEqAction });
  const selEqShop = vi.fn().mockReturnValue({ eq: selEqDetector });
  const ruleSelect = vi.fn().mockReturnValue({ eq: selEqShop });

  // calibration_rule update chain: .update().eq().eq().eq().eq().eq()
  const upEqFinal = vi.fn().mockResolvedValue({ error: overrides?.supError ?? null });
  const upUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ eq: upEqFinal }),
        }),
      }),
    }),
  });

  // pair_calibration read chain: select().eq().eq().eq().maybeSingle()
  const pairRows = overrides?.pairRows ?? [null, null];
  let pairIdx = 0;
  const pairMaybeSingle = vi.fn().mockImplementation(async () => {
    const data = pairRows[Math.min(pairIdx, pairRows.length - 1)] ?? null;
    pairIdx++;
    return { data, error: null };
  });
  const pairEq3 = vi.fn().mockReturnValue({ maybeSingle: pairMaybeSingle });
  const pairEq2 = vi.fn().mockReturnValue({ eq: pairEq3 });
  const pairEq1 = vi.fn().mockReturnValue({ eq: pairEq2 });
  const pairSelect = vi.fn().mockReturnValue({ eq: pairEq1 });

  // Dispatch by table so reads/inserts land on the right mock.
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "pair_calibration") return { select: pairSelect };
    if (table === "action_feedback") return { insert: fbInsert };
    // calibration_rule
    return { update: upUpdate, select: ruleSelect, insert: ruleInsert };
  });

  const sb = { from, rpc } as unknown as SupabaseClient;
  return { sb, from, fbInsert, rpc, upUpdate, ruleInsert, ruleSelect, selLimit, pairMaybeSingle };
}

const BASE = {
  alertId: "alert-1",
  detectorId: "campaign_below_breakeven" as const,
  actionKind: "pause_campaign" as const,
  dollarImpactCents: 4000,
};

describe("recordRejection", () => {
  it("inserts action_feedback with decision=reject, reason, note, and applied_rule", async () => {
    const { sb, fbInsert } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive", note: "too big" }, sb);
    expect(fbInsert).toHaveBeenCalledTimes(1);
    const row = fbInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.decision).toBe("reject");
    expect(row.reject_reason).toBe("too_aggressive");
    expect(row.note).toBe("too big");
    expect((row.applied_rule as Record<string, unknown>).cents).toBe(3000);
  });

  it("calls calibration_record_rejection rpc with correct betaDelta/gradDelta/mute for too_aggressive", async () => {
    const { sb, rpc } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive" }, sb);
    expect(rpc).toHaveBeenCalledWith("calibration_record_rejection", expect.objectContaining({
      p_shop_id: "shop-1",
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
      p_beta_delta: 0.5,
      p_grad_delta: 5,
      p_mute: false,
    }));
  });

  it("too_aggressive tightens the pair_dollar_cap atomically via RPC with cents = round(0.75 * dollarImpactCents)", async () => {
    const { sb, rpc, ruleInsert } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive", dollarImpactCents: 8000 }, sb);
    expect(rpc).toHaveBeenCalledWith("calibration_tighten_dollar_cap", {
      p_shop_id: "shop-1",
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
      p_candidate_cents: 6000,
      p_source: "too_aggressive",
    });
    // The RPC owns the supersede + insert — no JS-side rule write.
    expect(ruleInsert).not.toHaveBeenCalled();
  });

  it("freezes the RPC's tightened cents (not the candidate) into applied_rule", async () => {
    // Existing cap $5 is tighter than 0.75 × $80 = $60: the atomic RPC returns
    // 500 and that is what must land in action_feedback.applied_rule.
    const { sb, fbInsert, rpc } = makeStub();
    rpc.mockImplementation(async (name: string) =>
      name === "calibration_tighten_dollar_cap"
        ? { data: 500, error: null }
        : { error: null },
    );
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive", dollarImpactCents: 8000 }, sb);
    const row = fbInsert.mock.calls[0][0] as Record<string, unknown>;
    expect((row.applied_rule as Record<string, unknown>).cents).toBe(500);
  });

  it("writes no dollar cap when the rejected impact is $0 (never a 1-cent brick)", async () => {
    // A $0 impact has nothing to cap. Flooring the candidate to 1 cent would
    // write a permanent 1-cent cap — and because caps are tighten-only, no later
    // reject could ever loosen it, silently vetoing every future move for the
    // pair. The cap RPC must not fire and no cap rule row is written; the reject
    // still records (beta bump) so the signal is not lost.
    const { sb, rpc, ruleInsert } = makeStub();
    const receipt = await recordRejection(
      "shop-1",
      { ...BASE, reason: "too_aggressive", dollarImpactCents: 0 },
      sb,
    );
    expect(rpc).not.toHaveBeenCalledWith("calibration_tighten_dollar_cap", expect.anything());
    expect(rpc).toHaveBeenCalledWith("calibration_record_rejection", expect.anything());
    expect(ruleInsert).not.toHaveBeenCalled();
    expect(receipt.savedAsRule).toBe(false);
    expect(receipt.ruleKind).toBeNull();
  });

  it("falls back to a plain rule insert (no supersede) when the tighten RPC errors", async () => {
    const { sb, rpc, ruleInsert, upUpdate } = makeStub();
    rpc.mockImplementation(async (name: string) =>
      name === "calibration_tighten_dollar_cap"
        ? { data: null, error: { message: "fn missing" } }
        : { error: null },
    );
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive", dollarImpactCents: 8000 }, sb);
    // Candidate cap still lands so the merchant's reject is not lost…
    expect(ruleInsert).toHaveBeenCalledTimes(1);
    const ruleRow = ruleInsert.mock.calls[0][0] as Record<string, unknown>;
    expect((ruleRow.rule_value as Record<string, unknown>).cents).toBe(6000);
    // …but existing rows are NOT deactivated: enforcement vetoes on the
    // tightest cap, and deactivating a tighter cap here could loosen it.
    expect(upUpdate).not.toHaveBeenCalled();
  });

  it("i_handle_this writes a muted_pair rule and calls rpc with mute=true, betaDelta=0", async () => {
    const { sb, rpc, ruleInsert } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "i_handle_this" }, sb);
    expect(rpc).toHaveBeenCalledWith("calibration_record_rejection", expect.objectContaining({
      p_beta_delta: 0,
      p_mute: true,
    }));
    expect(ruleInsert).toHaveBeenCalledTimes(1);
    const ruleRow = ruleInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(ruleRow.rule_kind).toBe("muted_pair");
    expect(ruleRow.active).toBe(true);
  });

  it("i_handle_this skips insert when an active muted_pair already exists", async () => {
    const { sb, ruleInsert } = makeStub({ selData: [{ id: "existing-rule" }] });
    await recordRejection("shop-1", { ...BASE, reason: "i_handle_this" }, sb);
    expect(ruleInsert).not.toHaveBeenCalled();
  });

  it("returns a non-empty reflection string", async () => {
    const { sb } = makeStub();
    const result = await recordRejection("shop-1", { ...BASE, reason: "wrong_timing" }, sb);
    expect(typeof result.reflection).toBe("string");
    expect(result.reflection.length).toBeGreaterThan(0);
  });

  it("does not reject the promise when the rpc throws (still returns reflection)", async () => {
    const { sb } = makeStub({ rpcError: { message: "db is down" } });
    const result = await recordRejection("shop-1", { ...BASE, reason: "other" }, sb);
    expect(result.reflection).toBeTruthy();
  });

  it("does not reject the promise when the feedback insert throws", async () => {
    const { sb } = makeStub({ fbError: { message: "constraint violation" } });
    await expect(
      recordRejection("shop-1", { ...BASE, reason: "not_enough_data" }, sb),
    ).resolves.toMatchObject({ reflection: expect.any(String) });
  });

  it("not_enough_data uses betaDelta=1 and writes pair_probation_until rule", async () => {
    const { sb, rpc, ruleInsert } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "not_enough_data" }, sb);
    expect(rpc).toHaveBeenCalledWith("calibration_record_rejection", expect.objectContaining({
      p_beta_delta: 1,
      p_grad_delta: 2,
      p_mute: false,
    }));
    const ruleRow = ruleInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(ruleRow.rule_kind).toBe("pair_probation_until");
    expect(typeof (ruleRow.rule_value as Record<string, unknown>).until).toBe("string");
  });

  it("other reason produces no calibration_rule insert (ruleKind=null)", async () => {
    const { sb, ruleInsert } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "other" }, sb);
    expect(ruleInsert).not.toHaveBeenCalled();
  });
});

describe("recordRejection — reject receipt (savedAsRule / ruleKind / delta)", () => {
  it("refreshes the shop calibration headline after a rejection signal", async () => {
    const { sb } = makeStub({
      pairRows: [
        { alpha: 2, beta: 0 },
        { alpha: 2, beta: 1 },
      ],
    });
    await recordRejection("shop-1", { ...BASE, reason: "other" }, sb);
    expect(recomputeShopCalibration).toHaveBeenCalledWith("shop-1", { sb }, { skipPeerPrior: true, forceVisibleStep: true });
  });

  it("still returns the reflection when headline recompute fails", async () => {
    vi.mocked(recomputeShopCalibration).mockRejectedValueOnce(new Error("recompute failed"));
    const { sb } = makeStub();
    const r = await recordRejection("shop-1", { ...BASE, reason: "other" }, sb);
    expect(r.reflection).toBeTruthy();
  });

  it("savedAsRule=true and ruleKind set for a reason that writes a rule (too_aggressive)", async () => {
    const { sb } = makeStub();
    const r = await recordRejection("shop-1", { ...BASE, reason: "too_aggressive" }, sb);
    expect(r.savedAsRule).toBe(true);
    expect(r.ruleKind).toBe("pair_dollar_cap");
  });

  it("savedAsRule=false and ruleKind=null for a reason with no rule (wrong_timing)", async () => {
    const { sb } = makeStub();
    const r = await recordRejection("shop-1", { ...BASE, reason: "wrong_timing" }, sb);
    expect(r.savedAsRule).toBe(false);
    expect(r.ruleKind).toBe(null);
  });

  it("muted_pair ruleKind reported for i_handle_this", async () => {
    const { sb } = makeStub();
    const r = await recordRejection("shop-1", { ...BASE, reason: "i_handle_this" }, sb);
    expect(r.savedAsRule).toBe(true);
    expect(r.ruleKind).toBe("muted_pair");
  });

  it("delta = round(after - before) and is ≤ 0 (a reject lowers confidence)", async () => {
    // before alpha=2,beta=0 ; after alpha=2,beta=1 (a reject bumped beta)
    const before = { alpha: 2, beta: 0 };
    const after = { alpha: 2, beta: 1 };
    const { sb } = makeStub({
      pairRows: [
        { alpha: before.alpha, beta: before.beta },
        { alpha: after.alpha, beta: after.beta },
      ],
    });
    const r = await recordRejection("shop-1", { ...BASE, reason: "other" }, sb);
    const expBefore = confFromEv(BASE.detectorId, BASE.actionKind, before);
    const expAfter = confFromEv(BASE.detectorId, BASE.actionKind, after);
    expect(r.before).toBe(expBefore);
    expect(r.after).toBe(expAfter);
    expect(r.delta).toBe(Math.round(expAfter - expBefore));
    expect(r.delta).toBeLessThanOrEqual(0);
  });

  it("returns zero delta (best-effort) but still the reflection + rule fields when reads are cold", async () => {
    const { sb } = makeStub({ pairRows: [null, null] });
    const r = await recordRejection("shop-1", { ...BASE, reason: "too_aggressive" }, sb);
    expect(r.reflection.length).toBeGreaterThan(0);
    expect(r.savedAsRule).toBe(true);
    // cold pair → before==after==same conf → delta 0
    expect(r.delta).toBe(0);
  });
});

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordRejection } from "../reject.server";

/** Build a stub SupabaseClient that satisfies the call pattern used in reject.server.ts. */
function makeStub(overrides?: {
  fbError?: { message: string };
  rpcError?: { message: string };
  supError?: { message: string };
  selData?: { id: string }[];
  selError?: { message: string };
  insError?: { message: string };
}) {
  // Tracks calls so we can assert on them.
  const fbInsert = vi.fn().mockResolvedValue({ error: overrides?.fbError ?? null });
  const rpc = vi.fn().mockResolvedValue({ error: overrides?.rpcError ?? null });
  const ruleInsert = vi.fn().mockResolvedValue({ error: overrides?.insError ?? null });
  const selLimit = vi.fn().mockResolvedValue({ data: overrides?.selData ?? [], error: overrides?.selError ?? null });
  const selEqActive = vi.fn().mockReturnValue({ limit: selLimit });
  const selEqKind = vi.fn().mockReturnValue({ eq: selEqActive });
  const selEqAction = vi.fn().mockReturnValue({ eq: selEqKind });
  const selEqDetector = vi.fn().mockReturnValue({ eq: selEqAction });
  const selEqShop = vi.fn().mockReturnValue({ eq: selEqDetector });
  const selSelect = vi.fn().mockReturnValue({ eq: selEqShop });

  // update chain for supersede (pair_dollar_cap)
  // update chain: .update().eq().eq().eq().eq().eq() — 5 eqs for (shop_id, detector_id, action_kind, rule_kind, active)
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

  // We need `from` to return different shapes depending on whether it's used for
  // insert (action_feedback), update (supersede), or select (dup-check) + insert (rule).
  // Track call count on from() and dispatch accordingly.
  let fromCallCount = 0;
  const from = vi.fn().mockImplementation((_table: string) => {
    fromCallCount++;
    return {
      insert: fromCallCount === 1 ? fbInsert : ruleInsert,
      update: upUpdate,
      select: selSelect,
    };
  });

  const sb = { from, rpc } as unknown as SupabaseClient;
  return { sb, from, fbInsert, rpc, upUpdate, ruleInsert, selSelect, selLimit };
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
    // pair_dollar_cap: 75% of 4000 = 3000
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

  it("too_aggressive writes a pair_dollar_cap rule with cents = round(0.75 * dollarImpactCents)", async () => {
    const { sb, ruleInsert, upUpdate } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive", dollarImpactCents: 8000 }, sb);
    // supersede ran
    expect(upUpdate).toHaveBeenCalledWith({ active: false });
    // rule insert called
    expect(ruleInsert).toHaveBeenCalledTimes(1);
    const ruleRow = ruleInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(ruleRow.rule_kind).toBe("pair_dollar_cap");
    expect((ruleRow.rule_value as Record<string, unknown>).cents).toBe(6000); // 0.75 * 8000
    expect(ruleRow.active).toBe(true);
  });

  it("floors pair_dollar_cap cents to minimum 1", async () => {
    const { sb, ruleInsert } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "too_aggressive", dollarImpactCents: 0 }, sb);
    const ruleRow = ruleInsert.mock.calls[0][0] as Record<string, unknown>;
    expect((ruleRow.rule_value as Record<string, unknown>).cents).toBe(1);
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
    const { sb, from } = makeStub();
    await recordRejection("shop-1", { ...BASE, reason: "other" }, sb);
    // from() is called only for action_feedback (1 call) + rpc; no rule table call
    // We can verify ruleInsert was never invoked by counting from calls for rule table
    // action_feedback = 1 call, no rule calls = from called exactly once for insert
    const insertCalls = (from.mock.results as Array<{ value: { insert?: ReturnType<typeof vi.fn> } }>)
      .map((r) => r.value)
      .filter((v) => v.insert);
    // Only 1 from() call with insert (the action_feedback one)
    expect(insertCalls).toHaveLength(1);
  });
});

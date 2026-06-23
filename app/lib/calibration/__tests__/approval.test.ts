import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordApproval } from "../approval.server";
import { confFromEv } from "../delta";
import { recomputeShopCalibration } from "../recompute.server";

vi.mock("../recompute.server", () => ({
  recomputeShopCalibration: vi.fn().mockResolvedValue({ shopId: "shop-1", pairs: 1, raw: 25, display: 25 }),
}));

/**
 * Stub a SupabaseClient for recordApproval. recordApproval now:
 *   1. reads the pair row BEFORE the rpc  (from.pair_calibration.select…maybeSingle)
 *   2. calls rpc("calibration_record_approval", …)
 *   3. reads the pair row AFTER the rpc   (same select chain)
 * The two reads are served in order from `rows` (rows[0] = before, rows[1] = after).
 */
function makeStub(opts?: {
  rows?: Array<Record<string, unknown> | null>;
  rpcError?: { message: string };
  readError?: { message: string };
  throwOnRpc?: boolean;
}) {
  const rows = opts?.rows ?? [null, null];
  let readIdx = 0;
  const maybeSingle = vi.fn().mockImplementation(async () => {
    const data = rows[Math.min(readIdx, rows.length - 1)] ?? null;
    readIdx++;
    return { data, error: opts?.readError ?? null };
  });
  const eq3 = vi.fn().mockReturnValue({ maybeSingle });
  const eq2 = vi.fn().mockReturnValue({ eq: eq3 });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });

  const rpc = vi.fn().mockImplementation(async () => {
    if (opts?.throwOnRpc) throw new Error("rpc network error");
    return { data: null, error: opts?.rpcError ?? null };
  });

  const sb = { from, rpc } as unknown as SupabaseClient;
  return { sb, from, rpc, maybeSingle };
}

const DETECTOR = "campaign_below_breakeven";
const ACTION = "pause_campaign" as const;

describe("recordApproval — RPC call (unchanged write behavior)", () => {
  it("calls calibration_record_approval with the right args", async () => {
    const { sb, rpc } = makeStub();
    await recordApproval("shop-1", DETECTOR, ACTION, sb);
    expect(rpc).toHaveBeenCalledWith("calibration_record_approval", {
      p_shop_id: "shop-1",
      p_detector_id: DETECTOR,
      p_action_kind: ACTION,
    });
  });
});

describe("recordApproval — trust receipt", () => {
  it("refreshes the shop calibration headline after a successful approval signal", async () => {
    const { sb } = makeStub({ rows: [{ alpha: 0, beta: 0 }, { alpha: 1, beta: 0 }] });
    await recordApproval("shop-1", DETECTOR, ACTION, sb);
    expect(recomputeShopCalibration).toHaveBeenCalledWith("shop-1", { sb }, { skipPeerPrior: true });
  });

  it("still returns the receipt when headline recompute fails", async () => {
    vi.mocked(recomputeShopCalibration).mockRejectedValueOnce(new Error("recompute failed"));
    const { sb } = makeStub({ rows: [{ alpha: 0, beta: 0 }, { alpha: 1, beta: 0 }] });
    const r = await recordApproval("shop-1", DETECTOR, ACTION, sb);
    expect(r.after).toBeGreaterThan(0);
  });

  it("computes delta = round(after - before) from the two reads", async () => {
    const before = { alpha: 0, beta: 0 };
    const after = { alpha: 1, beta: 0, clean_approvals: 1, graduation_threshold: 75, graduated: false };
    const { sb } = makeStub({
      rows: [
        { alpha: before.alpha, beta: before.beta },
        after,
      ],
    });
    const r = await recordApproval("shop-1", DETECTOR, ACTION, sb);
    const expBefore = confFromEv(DETECTOR, ACTION, before);
    const expAfter = confFromEv(DETECTOR, ACTION, { alpha: 1, beta: 0 });
    expect(r.before).toBe(expBefore);
    expect(r.after).toBe(expAfter);
    expect(r.delta).toBe(Math.round(expAfter - expBefore));
    expect(r.cleanApprovals).toBe(1);
    expect(r.graduationThreshold).toBe(75);
  });

  it("graduatable=true for a GRADUATABLE_V1 kind (pause_campaign)", async () => {
    const { sb } = makeStub({ rows: [{ alpha: 0, beta: 0 }, { alpha: 1, beta: 0 }] });
    const r = await recordApproval("shop-1", DETECTOR, "pause_campaign", sb);
    expect(r.graduatable).toBe(true);
  });

  it("graduatable=false for a non-graduatable kind (reallocate_inventory)", async () => {
    const { sb } = makeStub({ rows: [{ alpha: 0, beta: 0 }, { alpha: 1, beta: 0 }] });
    const r = await recordApproval("shop-1", "regional_shortage_risk", "reallocate_inventory", sb);
    expect(r.graduatable).toBe(false);
  });

  it("justGraduated=true when the AFTER row clears all gates and the pair was NOT graduated before", async () => {
    // AFTER row: conf high, clean_approvals >= 3, threshold met, not graduated yet.
    const after = {
      alpha: 50,
      beta: 0,
      clean_approvals: 5,
      graduation_threshold: 50,
      graduated: false, // not yet graduated in DB at read time
      consecutive_undos: 0,
      merchant_disabled: false,
    };
    const { sb } = makeStub({ rows: [{ alpha: 49, beta: 0, graduated: false }, after] });
    const r = await recordApproval("shop-1", DETECTOR, "pause_campaign", sb);
    expect(r.justGraduated).toBe(true);
  });

  it("justGraduated=false when the pair was ALREADY graduated before this approval", async () => {
    const after = {
      alpha: 50,
      beta: 0,
      clean_approvals: 5,
      graduation_threshold: 50,
      graduated: true,
      consecutive_undos: 0,
      merchant_disabled: false,
    };
    // BEFORE row already graduated → not a fresh graduation.
    const { sb } = makeStub({ rows: [{ alpha: 49, beta: 0, graduated: true }, after] });
    const r = await recordApproval("shop-1", DETECTOR, "pause_campaign", sb);
    expect(r.justGraduated).toBe(false);
  });

  it("returns all zeros / false when the rpc errors (write failure)", async () => {
    const { sb } = makeStub({ rpcError: { message: "boom" }, rows: [{ alpha: 0, beta: 0 }, { alpha: 1, beta: 0 }] });
    const r = await recordApproval("shop-1", DETECTOR, ACTION, sb);
    expect(r).toEqual({
      delta: 0,
      before: 0,
      after: 0,
      cleanApprovals: 0,
      graduatable: false,
      graduationThreshold: 0,
      justGraduated: false,
    });
  });

  it("never throws when the rpc throws — returns the zero receipt", async () => {
    const { sb } = makeStub({ throwOnRpc: true });
    await expect(recordApproval("shop-1", DETECTOR, ACTION, sb)).resolves.toEqual(
      expect.objectContaining({ delta: 0, justGraduated: false }),
    );
  });

  it("never throws when a read errors — returns the zero receipt", async () => {
    const { sb } = makeStub({ readError: { message: "read fail" } });
    await expect(recordApproval("shop-1", DETECTOR, ACTION, sb)).resolves.toEqual(
      expect.objectContaining({ delta: 0 }),
    );
  });
});

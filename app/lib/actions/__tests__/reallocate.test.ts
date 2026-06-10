import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeReallocation } from "../reallocate.server";
import { ActionError } from "../../ads/actions";
import type { SupabaseClient } from "@supabase/supabase-js";

const { adapters, actionAdapterForShop } = vi.hoisted(() => {
  const mk = (platform: string) => ({
    platform,
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    setDailyBudget: vi.fn(async () => {}),
    getState: vi.fn(),
  });
  const adapters = { google: mk("google"), meta: mk("meta") };
  const actionAdapterForShop = vi.fn(
    async (_shop: string, platform: string) =>
      adapters[platform as keyof typeof adapters] ?? null,
  );
  return { adapters, actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

const SHOP = "00000000-0000-0000-0000-000000000010";
const SRC_ID = "11111111-1111-1111-1111-111111111111";
const DST_ID = "22222222-2222-2222-2222-222222222222";

// Fake supabase mirroring execute.test.ts, with a QUEUE of campaign rows —
// the orchestrator loads source first, then dest.
function fakeSb(opts: {
  idempotent?: { audit_id: string };
  campaigns?: Array<Record<string, unknown> | null>;
  priorOutcome?: string;
}) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  const campQueue = [...(opts.campaigns ?? [])];
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: campQueue.shift() ?? null, error: null };
      if (table === "action_audit") return { data: { id: "aud1", outcome: opts.priorOutcome ?? "succeeded" }, error: null };
      return { data: null, error: null };
    });
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const SRC = { id: SRC_ID, shop_id: SHOP, external_id: "g-1", platform: "google", status: "active", daily_budget_cents: 2000 };
const DST = { id: DST_ID, shop_id: SHOP, external_id: "m-1", platform: "meta", status: "active", daily_budget_cents: 1000 };

const input = {
  alertId: null,
  sourceCampaignId: SRC_ID,
  destCampaignId: DST_ID,
  amountCents: 500,
  idempotencyKey: "rk1",
};

function auditRow(calls: { inserts: Array<{ table: string; rows: unknown }> }) {
  return calls.inserts.find((i) => i.table === "action_audit")?.rows as Record<string, unknown>;
}

describe("executeReallocation · happy path + validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default impl so Once queues from prior tests don't leak.
    actionAdapterForShop.mockImplementation(
      async (_shop: string, platform: string) =>
        adapters[platform as keyof typeof adapters] ?? null,
    );
  });

  it("reduces source then increases dest and writes ONE two-sided audit row", async () => {
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("succeeded");
    expect(adapters.google.setDailyBudget).toHaveBeenCalledWith("g-1", 1500);
    expect(adapters.meta.setDailyBudget).toHaveBeenCalledWith("m-1", 1500);
    // Ordering: source reduce strictly before dest increase (fails safe).
    expect(adapters.google.setDailyBudget.mock.invocationCallOrder[0]).toBeLessThan(
      adapters.meta.setDailyBudget.mock.invocationCallOrder[0],
    );
    const audit = auditRow(calls);
    expect(audit).toMatchObject({
      shop_id: SHOP,
      action_kind: "reallocate_budget",
      outcome: "succeeded",
      pre_state: { source: { daily_budget_cents: 2000 }, dest: { daily_budget_cents: 1000 } },
      post_state: { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
    });
    expect(audit.params).toMatchObject({
      campaign_id: SRC_ID, // source-side, so existing cooldown lookups match
      source_campaign_id: SRC_ID,
      source_external_id: "g-1",
      source_platform: "google",
      source_prev_budget_cents: 2000,
      source_new_budget_cents: 1500,
      dest_campaign_id: DST_ID,
      dest_external_id: "m-1",
      dest_platform: "meta",
      dest_new_budget_cents: 1500,
      amount_cents: 500,
      // Dest-side replay fields for the single-adapter retry drain:
      external_id: "m-1",
      platform: "meta",
      daily_budget_cents: 1500,
      step: "increase_dest",
    });
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("short-circuits on a used idempotency key and reports the REAL prior outcome", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaigns: [SRC, DST], priorOutcome: "retrying" });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("retrying");
    expect(adapters.google.setDailyBudget).not.toHaveBeenCalled();
    expect(adapters.meta.setDailyBudget).not.toHaveBeenCalled();
  });

  it("rejects a source campaign that does not belong to the shop", async () => {
    const { sb } = fakeSb({ campaigns: [null, DST] });
    await expect(executeReallocation(SHOP, input, sb)).rejects.toThrow(/not found|ownership/i);
  });

  it("rejects a dest campaign that does not belong to the shop", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, null] });
    await expect(executeReallocation(SHOP, input, sb)).rejects.toThrow(/not found|ownership/i);
  });

  it("rejects source === dest", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, SRC] });
    await expect(
      executeReallocation(SHOP, { ...input, destCampaignId: SRC_ID }, sb),
    ).rejects.toThrow(/different campaigns/i);
  });

  it("rejects a non-positive amount", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, DST] });
    await expect(executeReallocation(SHOP, { ...input, amountCents: 0 }, sb)).rejects.toThrow(/positive/i);
  });

  it("rejects when either campaign has no daily budget", async () => {
    const { sb } = fakeSb({ campaigns: [{ ...SRC, daily_budget_cents: null }, DST] });
    await expect(executeReallocation(SHOP, input, sb)).rejects.toThrow(/daily budget/i);
  });

  it("rejects an amount that would empty the source budget", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, DST] });
    await expect(executeReallocation(SHOP, { ...input, amountCents: 2000 }, sb)).rejects.toThrow(/above zero/i);
  });

  it("records the actor on the audit row", async () => {
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    await executeReallocation(SHOP, { ...input, actor: "autopilot" }, sb);
    expect(auditRow(calls).actor_user_id).toBe("autopilot");
  });
});

describe("executeReallocation · failure paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default impl so Once queues from prior tests don't leak.
    actionAdapterForShop.mockImplementation(
      async (_shop: string, platform: string) =>
        adapters[platform as keyof typeof adapters] ?? null,
    );
  });

  it("source-step failure is TERMINAL failed (not parked), dest untouched", async () => {
    // Plain (retriable-class) error on purpose: SOURCE-step failures are always terminal by design — there is no retry path for the first step.
    adapters.google.setDailyBudget.mockRejectedValueOnce(new Error("Google API 503"));
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    expect(adapters.meta.setDailyBudget).not.toHaveBeenCalled();
    const audit = auditRow(calls);
    expect(audit).toMatchObject({ outcome: "failed", attempts: 0, post_state: null });
    expect((audit.params as Record<string, unknown>).step).toBe("reduce_source");
    expect(String(audit.last_error)).toMatch(/503/);
  });

  it("dest-step transient failure parks retrying with dest replay params; source NOT restored", async () => {
    adapters.meta.setDailyBudget.mockRejectedValueOnce(new Error("Meta API 503"));
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("retrying");
    // Source was reduced exactly once — no compensation for a parked retry.
    expect(adapters.google.setDailyBudget).toHaveBeenCalledTimes(1);
    const audit = auditRow(calls);
    expect(audit).toMatchObject({ outcome: "retrying", attempts: 1, post_state: null });
    expect(audit.params).toMatchObject({
      step: "increase_dest",
      external_id: "m-1",
      platform: "meta",
      daily_budget_cents: 1500,
    });
    expect((audit.params as Record<string, unknown>).compensation).toBeUndefined();
  });

  it("dest-step PERMANENT failure compensates: source restored, visibly recorded", async () => {
    adapters.meta.setDailyBudget.mockRejectedValueOnce(
      new ActionError("meta", "invalid budget param", { retriable: false }),
    );
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    // Source reduced (2000→1500), then restored (→2000).
    expect(adapters.google.setDailyBudget).toHaveBeenNthCalledWith(1, "g-1", 1500);
    expect(adapters.google.setDailyBudget).toHaveBeenNthCalledWith(2, "g-1", 2000);
    const audit = auditRow(calls);
    expect(audit).toMatchObject({ outcome: "failed", post_state: null });
    expect((audit.params as Record<string, unknown>).compensation).toBe("succeeded");
  });

  it("failed compensation is loudly visible (rule 12)", async () => {
    adapters.meta.setDailyBudget.mockRejectedValueOnce(
      new ActionError("meta", "invalid budget param", { retriable: false }),
    );
    adapters.google.setDailyBudget
      .mockResolvedValueOnce(undefined) // step 1 reduce succeeds
      .mockRejectedValueOnce(new Error("Google API down")); // compensation fails
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    const audit = auditRow(calls);
    expect((audit.params as Record<string, unknown>).compensation).toBe("failed");
    expect(String(audit.last_error)).toMatch(/compensation failed/i);
    expect(String(audit.last_error)).toMatch(/invalid budget param/i);
  });

  it("fails fast with ZERO platform calls when the source platform is not connected", async () => {
    actionAdapterForShop.mockResolvedValueOnce(null); // source resolve
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    expect(adapters.google.setDailyBudget).not.toHaveBeenCalled();
    expect(adapters.meta.setDailyBudget).not.toHaveBeenCalled();
    expect(String(auditRow(calls).last_error)).toMatch(/google not connected/i);
  });

  it("fails fast with ZERO platform calls when the dest platform is not connected", async () => {
    actionAdapterForShop
      .mockResolvedValueOnce(adapters.google) // source resolve
      .mockResolvedValueOnce(null); // dest resolve
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    expect(adapters.google.setDailyBudget).not.toHaveBeenCalled();
    expect(String(auditRow(calls).last_error)).toMatch(/meta not connected/i);
  });
});

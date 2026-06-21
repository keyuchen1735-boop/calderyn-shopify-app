import { describe, it, expect, vi } from "vitest";
import { acquireAutopilotLock, releaseAutopilotLock, LOCK_TTL_MS } from "../autopilot-lock.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const SHOP = "00000000-0000-0000-0000-000000000099";

// Build a minimal Supabase mock that supports the chain:
// sb.from("autopilot_run_lock").insert(...).select(...).maybeSingle()
// sb.from("autopilot_run_lock").select(...).eq(...).maybeSingle()
// sb.from("autopilot_run_lock").delete().eq(...)
function makeSb({
  insertResult,
  selectResult,
  deleteResult,
}: {
  insertResult?: { data: unknown; error: unknown } | null;
  selectResult?: { data: unknown; error: unknown } | null;
  deleteResult?: { error: unknown } | null;
}) {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => {
    // If we chained insert then select then maybeSingle → insertResult
    // If we chained select then eq then maybeSingle → selectResult
    // Distinguish by checking whether insert was called first.
    if ((chain.insert as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      return insertResult ?? { data: { locked_at: new Date().toISOString() }, error: null };
    }
    return selectResult ?? { data: null, error: null };
  });
  chain.then = vi.fn(async (resolve: (r: unknown) => unknown) => {
    return resolve(deleteResult ?? { error: null });
  });
  return {
    from: vi.fn(() => chain),
    _chain: chain,
  } as unknown as SupabaseClient & { _chain: Record<string, unknown> };
}

describe("acquireAutopilotLock", () => {
  it("returns acquired:true when insert succeeds (no existing lock)", async () => {
    const sb = makeSb({
      insertResult: { data: { locked_at: new Date().toISOString() }, error: null },
    });
    const result = await acquireAutopilotLock(SHOP, sb);
    expect(result.acquired).toBe(true);
  });

  it("returns acquired:false when a live lock exists (unique violation → existing row younger than TTL)", async () => {
    // Insert fails with 23505 (unique violation); existing row is recent.
    const recentLockedAt = new Date(Date.now() - 30_000).toISOString(); // 30s ago (< TTL)
    const freshSb = {
      from: vi.fn(),
    } as unknown as SupabaseClient;

    let callCount = 0;
    const insertChain: Record<string, unknown> = {};
    const selectChain: Record<string, unknown> = {};

    insertChain.insert = vi.fn(() => insertChain);
    insertChain.select = vi.fn(() => insertChain);
    insertChain.eq = vi.fn(() => insertChain);
    insertChain.maybeSingle = vi.fn(async () => ({
      data: null,
      error: { code: "23505", message: "duplicate key value" },
    }));

    selectChain.select = vi.fn(() => selectChain);
    selectChain.eq = vi.fn(() => selectChain);
    selectChain.maybeSingle = vi.fn(async () => ({
      data: { locked_at: recentLockedAt },
      error: null,
    }));

    vi.mocked(freshSb.from).mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? insertChain : selectChain) as never;
    });

    const result = await acquireAutopilotLock(SHOP, freshSb);
    expect(result.acquired).toBe(false);
    expect(result.reason).toMatch(/locked_by_concurrent_tick/);
  });

  it("returns acquired:false (fail-safe) when DB errors on insert with non-dedup error", async () => {
    const sb = makeSb({
      insertResult: { data: null, error: { code: "PGRST301", message: "permission denied" } },
    });
    const result = await acquireAutopilotLock(SHOP, sb);
    expect(result.acquired).toBe(false);
    expect(result.reason).toContain("db_error");
  });
});

describe("releaseAutopilotLock", () => {
  it("deletes the lock row without throwing", async () => {
    const sb = makeSb({ deleteResult: { error: null } });
    await expect(releaseAutopilotLock(SHOP, sb)).resolves.toBeUndefined();
  });

  it("logs but does NOT throw when delete errors", async () => {
    const sb = makeSb({ deleteResult: { error: { message: "connection lost" } } });
    // releaseAutopilotLock is best-effort: should resolve (not reject).
    await expect(releaseAutopilotLock(SHOP, sb)).resolves.toBeUndefined();
  });
});

describe("LOCK_TTL_MS", () => {
  it("is at least 5 minutes (300_000ms)", () => {
    expect(LOCK_TTL_MS).toBeGreaterThanOrEqual(300_000);
  });
});

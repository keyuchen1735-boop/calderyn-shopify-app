// app/lib/actions/__tests__/retry.test.ts
//
// Slice 5 — action-retry drain skeleton unit test. Adapted from the
// monorepo `workers/action-retry/src/index.test.ts`. The registry is
// empty here, so the behaviour under test is the SKELETON's: backoff
// math, attempt-cap filtering, and the "no executor → skip the row
// UNTOUCHED (no mutation)" path. A fake `sb` records the select filters
// and any update payloads — the empty-registry path must record none.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ActionError } from "../../ads/actions";
import type { Platform } from "../../ads/adapter";

import {
  backoffSeconds,
  drainActionRetries,
  MAX_ATTEMPTS,
} from "../retry.server";

describe("backoffSeconds", () => {
  it("doubles per attempt and caps at 600", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(4)).toBe(240);
    expect(backoffSeconds(5)).toBe(480);
    expect(backoffSeconds(6)).toBe(600); // 960 capped to 600
    expect(backoffSeconds(10)).toBe(600);
  });
});

describe("drainActionRetries", () => {
  const SHOP = "11111111-1111-4111-8111-111111111111";
  const FIXED_NOW = new Date("2026-06-04T12:00:00.000Z");

  it("filters the select on outcome=retrying and attempts < MAX_ATTEMPTS", async () => {
    const { sb, selectFilters } = makeFakeSb({ rows: [] });
    await drainActionRetries(sb, { now: () => FIXED_NOW });
    expect(selectFilters.eq).toEqual({ column: "outcome", value: "retrying" });
    expect(selectFilters.lt).toEqual({ column: "attempts", value: MAX_ATTEMPTS });
  });

  it("skips a due row UNTOUCHED when no executor is registered (empty registry)", async () => {
    // completed long ago → past any backoff window → due. With an empty
    // registry the row must be left alone (never marked `failed`, which is
    // terminal) and counted as skipped. NO update may be issued.
    const row = {
      id: "33333333-3333-4333-8333-333333333333",
      shop_id: SHOP,
      action_kind: "snooze_alert",
      attempts: 1,
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
    };
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW });

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.errors).toEqual([]);
    expect(updates).toHaveLength(0); // the row was NOT mutated
  });

  it("skips a row still inside its backoff window (not yet due)", async () => {
    // attempts=2 → backoff 60s. completed 30s ago → NOT due.
    const completed = new Date(FIXED_NOW.getTime() - 30 * 1000).toISOString();
    const row = {
      id: "44444444-4444-4444-8444-444444444444",
      shop_id: SHOP,
      action_kind: "pause_campaign",
      attempts: 2,
      outcome: "retrying",
      completed_at: completed,
    };
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("replays a due retrying pause row via the adapter and marks it succeeded", async () => {
    const row = {
      id: "66666666-6666-4666-8666-666666666666",
      shop_id: SHOP,
      action_kind: "pause_campaign",
      attempts: 1,
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
      params: { campaign_id: "dim1", external_id: "ext1", platform: "meta", daily_budget_cents: null },
    };
    const adapter = makeFakeAdapter();
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, {
      now: () => FIXED_NOW,
      resolveAdapter: async () => adapter,
    });

    expect(adapter.pause).toHaveBeenCalledWith("ext1");
    expect(result.succeeded).toBe(1);
    expect(result.processed).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(row.id);
    expect(updates[0].payload).toMatchObject({ outcome: "succeeded", attempts: 2 });
  });

  it("acknowledges the alert when a replayed action succeeds", async () => {
    // The synchronous execute path only acknowledges on an immediate
    // success; a success via the retry drain must do it here or the alert
    // stays open forever after the action actually executed.
    const row = {
      id: "77777777-7777-4777-8777-777777777777",
      shop_id: SHOP,
      alert_id: "88888888-8888-4888-8888-888888888888",
      action_kind: "pause_campaign",
      attempts: 1,
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
      params: { campaign_id: "dim1", external_id: "ext1", platform: "meta", daily_budget_cents: null },
    };
    const adapter = makeFakeAdapter();
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, {
      now: () => FIXED_NOW,
      resolveAdapter: async () => adapter,
    });

    expect(result.succeeded).toBe(1);
    expect(result.errors).toEqual([]);
    const ack = updates.find((u) => u.table === "alerts");
    expect(ack?.payload).toEqual({ status: "acknowledged" });
    expect(ack?.filters).toEqual(
      expect.arrayContaining([
        ["shop_id", SHOP],
        ["id", row.alert_id],
        ["status", "open"],
      ]),
    );
  });

  it("keeps a row retrying (bumps attempts) when replay fails below the attempt cap", async () => {
    const row = {
      id: "77777777-7777-4777-8777-777777777777",
      shop_id: SHOP,
      action_kind: "pause_campaign",
      attempts: 1, // → next attempt 2, still < MAX
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
      params: { campaign_id: "dim1", external_id: "ext1", platform: "meta", daily_budget_cents: null },
    };
    const boom = new ActionError("meta", "rate limited"); // retriable by default
    const adapter = makeFakeAdapter({ pause: vi.fn(async () => { throw boom; }) });
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW, resolveAdapter: async () => adapter });

    expect(result.retrying).toBe(1);
    expect(result.failed).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ outcome: "retrying", attempts: 2 });
    expect(updates[0].payload.last_error).toMatch(/rate limited/);
  });

  it("terminally fails a row when replay fails at the attempt cap", async () => {
    const row = {
      id: "88888888-8888-4888-8888-888888888888",
      shop_id: SHOP,
      action_kind: "pause_campaign",
      attempts: MAX_ATTEMPTS - 1, // → next attempt == MAX → terminal
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
      params: { campaign_id: "dim1", external_id: "ext1", platform: "meta", daily_budget_cents: null },
    };
    const adapter = makeFakeAdapter({ pause: vi.fn(async () => { throw new Error("still down"); }) });
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW, resolveAdapter: async () => adapter });

    expect(result.failed).toBe(1);
    expect(result.retrying).toBe(0);
    expect(updates[0].payload).toMatchObject({ outcome: "failed", attempts: MAX_ATTEMPTS });
  });

  it("immediately terminally fails on a non-retriable adapter error", async () => {
    const row = {
      id: "99999999-9999-4999-8999-999999999999",
      shop_id: SHOP,
      action_kind: "pause_campaign",
      attempts: 1, // well below cap, but error is permanent
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
      params: { campaign_id: "dim1", external_id: "ext1", platform: "meta", daily_budget_cents: null },
    };
    const perm = new ActionError("meta", "invalid token", { retriable: false });
    const adapter = makeFakeAdapter({ pause: vi.fn(async () => { throw perm; }) });
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW, resolveAdapter: async () => adapter });

    expect(result.failed).toBe(1);
    expect(updates[0].payload).toMatchObject({ outcome: "failed", attempts: 2 });
  });

  it("treats a disconnected platform as a (retriable) failure, never a crash", async () => {
    const row = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      shop_id: SHOP,
      action_kind: "pause_campaign",
      attempts: 1,
      outcome: "retrying",
      completed_at: "2026-06-01T00:00:00.000Z",
      params: { campaign_id: "dim1", external_id: "ext1", platform: "meta", daily_budget_cents: null },
    };
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW, resolveAdapter: async () => null });

    expect(result.retrying).toBe(1);
    expect(updates[0].payload).toMatchObject({ outcome: "retrying", attempts: 2 });
    expect(updates[0].payload.last_error).toMatch(/not connected/);
  });

  it("short-circuits a fetched row that is already succeeded", async () => {
    const row = {
      id: "55555555-5555-4555-8555-555555555555",
      shop_id: SHOP,
      action_kind: "snooze_alert",
      attempts: 1,
      outcome: "succeeded",
      completed_at: "2026-06-01T00:00:00.000Z",
    };
    const { sb, updates } = makeFakeSb({ rows: [row] });

    const result = await drainActionRetries(sb, { now: () => FIXED_NOW });

    expect(result.succeeded).toBe(1);
    expect(result.processed).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe("drainActionRetries · reallocate_budget", () => {
  const SHOP2 = "00000000-0000-0000-0000-000000000099";

  const reallocParams = {
    external_id: "m-1",
    platform: "meta",
    daily_budget_cents: 1500,
    source_external_id: "g-1",
    source_platform: "google",
    source_prev_budget_cents: 2000,
    source_new_budget_cents: 1500,
    step: "increase_dest",
  };

  function mkAdapter(platform: Platform) {
    return {
      platform,
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      setDailyBudget: vi.fn(async () => {}),
      getState: vi.fn(),
    };
  }

  function fakeDrainSb(row: Record<string, unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.lt = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.update = vi.fn((u: Record<string, unknown>) => {
        updates.push(u);
        return chain;
      });
      chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: [row], error: null });
      return chain;
    }
    return {
      sb: { from: vi.fn(() => builder()) } as unknown as SupabaseClient,
      updates,
    };
  }

  it("replays ONLY the dest increase and writes a two-sided post_state", async () => {
    const meta = mkAdapter("meta");
    const google = mkAdapter("google");
    const { sb, updates } = fakeDrainSb({
      id: "r1", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    const r = await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect(meta.setDailyBudget).toHaveBeenCalledWith("m-1", 1500);
    expect(google.setDailyBudget).not.toHaveBeenCalled();
    expect(r.succeeded).toBe(1);
    expect(updates[0]).toMatchObject({
      outcome: "succeeded",
      post_state: { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
    });
  });

  it("compensates (restores source) when the parked row fails TERMINALLY", async () => {
    const meta = mkAdapter("meta");
    meta.setDailyBudget.mockRejectedValue(new ActionError("meta", "invalid budget", { retriable: false }));
    const google = mkAdapter("google");
    const { sb, updates } = fakeDrainSb({
      id: "r2", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    const r = await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect(r.failed).toBe(1);
    expect(google.setDailyBudget).toHaveBeenCalledWith("g-1", 2000);
    expect(updates[0].outcome).toBe("failed");
    expect((updates[0].params as Record<string, unknown>).compensation).toBe("succeeded");
    expect(String(updates[0].last_error)).toMatch(/source budget restored/i);
  });

  it("records a FAILED compensation loudly (rule 12)", async () => {
    const meta = mkAdapter("meta");
    meta.setDailyBudget.mockRejectedValue(new ActionError("meta", "invalid budget", { retriable: false }));
    const google = mkAdapter("google");
    google.setDailyBudget.mockRejectedValue(new Error("Google down"));
    const { sb, updates } = fakeDrainSb({
      id: "r3", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect((updates[0].params as Record<string, unknown>).compensation).toBe("failed");
    expect(String(updates[0].last_error)).toMatch(/compensation failed/i);
  });

  it("does NOT compensate a still-transient failure (row re-parks)", async () => {
    const meta = mkAdapter("meta");
    meta.setDailyBudget.mockRejectedValue(new Error("Meta 503"));
    const google = mkAdapter("google");
    const { sb, updates } = fakeDrainSb({
      id: "r4", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    const r = await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect(r.retrying).toBe(1);
    expect(google.setDailyBudget).not.toHaveBeenCalled();
    expect(updates[0].outcome).toBe("retrying");
    expect(updates[0].params).toBeUndefined();
  });
});

// A fake ActionAdapter whose campaign methods resolve by default; individual
// tests override one to reject (replay failure).
function makeFakeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    platform: "meta" as const,
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    setDailyBudget: vi.fn(async () => {}),
    getState: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake Supabase client: serves one select (action_audit) and records the
// select filters + any update() payloads keyed by id.
// ---------------------------------------------------------------------------

interface SelectFilters {
  eq?: { column: string; value: unknown };
  lt?: { column: string; value: unknown };
}

function makeFakeSb(opts: { rows: unknown[] }): {
  sb: SupabaseClient;
  selectFilters: SelectFilters;
  updates: {
    table: string;
    id: string;
    payload: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }[];
} {
  const selectFilters: SelectFilters = {};
  const updates: {
    table: string;
    id: string;
    payload: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }[] = [];

  const sb = {
    from(table: string) {
      return {
        select(_cols: string) {
          const builder = {
            eq(column: string, value: unknown) {
              selectFilters.eq = { column, value };
              return builder;
            },
            lt(column: string, value: unknown) {
              selectFilters.lt = { column, value };
              return builder;
            },
            order() {
              return builder;
            },
            limit() {
              return Promise.resolve({ data: opts.rows, error: null });
            },
          };
          return builder;
        },
        // Chainable + thenable so multi-filter updates (acknowledgeAlert's
        // shop_id/id/status chain) work; the update is recorded on await.
        update(payload: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            then(resolve: (v: unknown) => unknown) {
              updates.push({
                table,
                id: String(filters.find(([c]) => c === "id")?.[1] ?? ""),
                payload,
                filters,
              });
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;

  return { sb, selectFilters, updates };
}

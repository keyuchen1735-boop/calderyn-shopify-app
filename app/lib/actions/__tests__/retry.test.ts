// app/lib/actions/__tests__/retry.test.ts
//
// Slice 5 — action-retry drain skeleton unit test. Adapted from the
// monorepo `workers/action-retry/src/index.test.ts`. The registry is
// empty here, so the behaviour under test is the SKELETON's: backoff
// math, attempt-cap filtering, and the "no executor → skip the row
// UNTOUCHED (no mutation)" path. A fake `sb` records the select filters
// and any update payloads — the empty-registry path must record none.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  updates: { id: string; payload: Record<string, unknown> }[];
} {
  const selectFilters: SelectFilters = {};
  const updates: { id: string; payload: Record<string, unknown> }[] = [];

  const sb = {
    from(_table: string) {
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
        update(payload: Record<string, unknown>) {
          return {
            eq(_column: string, value: unknown) {
              updates.push({ id: String(value), payload });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { sb, selectFilters, updates };
}

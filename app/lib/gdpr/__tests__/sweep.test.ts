// app/lib/gdpr/__tests__/sweep.test.ts
//
// Slice 5 — GDPR sweep unit test, retargeted to the Supabase PostgREST client.
// Redaction is a single cascading `delete from shops where id = ...` per
// candidate (every per-shop FK is ON DELETE CASCADE), so the fake `sb` records
// delete() calls and we assert exactly one shops-delete per candidate, plus the
// raw-webhook retention trim and per-shop isolation.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  RETENTION_RAW_WEBHOOK_DAYS,
  UNINSTALL_GRACE_DAYS,
  runGdprAndRetentionSweep,
} from "../sweep.server";

describe("constants", () => {
  it("uninstall grace window is 30 days", () => {
    expect(UNINSTALL_GRACE_DAYS).toBe(30);
  });
  it("raw webhook retention window is 30 days", () => {
    expect(RETENTION_RAW_WEBHOOK_DAYS).toBe(30);
  });
});

describe("runGdprAndRetentionSweep", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  it("does nothing when no shops are past the grace window", async () => {
    const { sb, deleteCalls } = makeFakeSb({ candidates: [], rawDeleted: 0 });
    const result = await runGdprAndRetentionSweep(sb);
    expect(result.shopsRedacted).toEqual([]);
    expect(result.shopsFailed).toEqual([]);
    // No per-shop deletes at all — only the (no-op) raw retention trim.
    expect(deleteCalls.filter((c) => c.kind === "eq")).toHaveLength(0);
    expect(result.rawWebhookRowsDeleted).toBe(0);
  });

  it("redacts each candidate with a single cascading delete on shops(id)", async () => {
    const { sb, deleteCalls } = makeFakeSb({
      candidates: [{ id: A }, { id: B }],
      rawDeleted: 7,
    });

    const result = await runGdprAndRetentionSweep(sb);
    expect(result.shopsRedacted).toEqual([A, B]);
    expect(result.shopsFailed).toEqual([]);
    expect(result.rawWebhookRowsDeleted).toBe(7);

    // Exactly one delete per candidate, all on `shops` keyed by `id`. No
    // per-child-table deletes — the DB cascade does that.
    expect(deleteCalls.filter((c) => c.kind === "eq")).toEqual([
      { table: "shops", kind: "eq", eq: { column: "id", value: A } },
      { table: "shops", kind: "eq", eq: { column: "id", value: B } },
    ]);
  });

  it("records a failed shop (does not throw or silently pass) and keeps going", async () => {
    // A's delete fails; B (queued after it) must still be redacted —
    // per-shop isolation: one shop's failure never aborts the batch (rule 12).
    const { sb } = makeFakeSb({
      candidates: [{ id: A }, { id: B }],
      rawDeleted: 0,
      failTable: "shops",
      failShopId: A,
    });

    const result = await runGdprAndRetentionSweep(sb);

    expect(result.shopsRedacted).toEqual([B]);
    expect(result.shopsFailed).toHaveLength(1);
    expect(result.shopsFailed[0]!.id).toBe(A);
    expect(result.shopsFailed[0]!.error).toMatch(/shops/);
  });
});

// ---------------------------------------------------------------------------
// Fake Supabase PostgREST client. Records delete() calls and the terminal
// .eq()/.lt() filter, and serves the candidate-shops select.
// ---------------------------------------------------------------------------

interface DeleteCall {
  table: string;
  kind: "eq" | "lt";
  eq?: { column: string; value: unknown };
}

interface FakeOpts {
  candidates: { id: string }[];
  rawDeleted: number;
  failTable?: string;
  /** When set, only the delete for this shop id fails (per-shop isolation). */
  failShopId?: string;
}

function makeFakeSb(opts: FakeOpts): {
  sb: SupabaseClient;
  deleteCalls: DeleteCall[];
} {
  const deleteCalls: DeleteCall[] = [];

  const sb = {
    from(table: string) {
      return {
        // --- candidate shops select chain ---
        select(_cols: string) {
          return {
            not() {
              return this;
            },
            lt() {
              // Resolves the awaited select to the candidate list.
              return Promise.resolve({ data: opts.candidates, error: null });
            },
          };
        },
        // --- delete chain (per-shop redact OR raw trim) ---
        delete(options?: { count?: "exact" }) {
          return {
            eq(column: string, value: unknown) {
              deleteCalls.push({ table, kind: "eq", eq: { column, value } });
              // Fail only the configured table — and, when failShopId is set,
              // only for that shop — so the test can prove the batch continues.
              const fail =
                opts.failTable === table &&
                (opts.failShopId === undefined || opts.failShopId === value);
              return Promise.resolve({
                error: fail ? { message: `boom on ${table}` } : null,
              });
            },
            lt() {
              // raw_shopify_webhook retention trim (uses { count: 'exact' }).
              deleteCalls.push({ table, kind: "lt" });
              return Promise.resolve({
                error: opts.failTable === table ? { message: `boom on ${table}` } : null,
                count: options?.count === "exact" ? opts.rawDeleted : null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { sb, deleteCalls };
}

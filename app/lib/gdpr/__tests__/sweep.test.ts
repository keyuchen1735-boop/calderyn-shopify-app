// app/lib/gdpr/__tests__/sweep.test.ts
//
// Slice 5 — GDPR sweep unit test. Adapted from the monorepo
// `workers/gdpr-sweep/src/index.test.ts`, retargeted to the Supabase
// PostgREST client. A fake `sb` records `.from(table).delete()...` calls
// so we can assert exactly one DELETE per per-shop table, in order.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PER_SHOP_TABLES_PURGE_ORDER,
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

describe("PER_SHOP_TABLES_PURGE_ORDER", () => {
  it("purges shops last (foreign-key parent)", () => {
    expect(PER_SHOP_TABLES_PURGE_ORDER.at(-1)).toBe("shops");
  });

  it("contains no duplicate entries", () => {
    const seen = new Set<string>();
    for (const t of PER_SHOP_TABLES_PURGE_ORDER) {
      expect(seen.has(t), `duplicate purge entry: ${t}`).toBe(false);
      seen.add(t);
    }
  });

  it("purges children before their parents (FK invariants)", () => {
    const order = PER_SHOP_TABLES_PURGE_ORDER;
    const idx = (t: string): number => order.indexOf(t);
    expect(idx("undo_token")).toBeLessThan(idx("action_audit"));
    expect(idx("action_audit")).toBeLessThan(idx("alerts"));
    expect(idx("order_line_fact")).toBeLessThan(idx("order_fact"));
    expect(idx("attribution_fact")).toBeLessThan(idx("order_fact"));
    expect(idx("ad_spend_fact")).toBeLessThan(idx("ad_campaign_dim"));
    expect(idx("ad_creative_sku_map")).toBeLessThan(idx("ad_campaign_dim"));
    expect(idx("inventory_level_fact")).toBeLessThan(idx("location_dim"));
    expect(idx("inventory_level_fact")).toBeLessThan(idx("sku_dim"));
    expect(idx("alerts")).toBeLessThan(idx("shops"));
  });
});

describe("runGdprAndRetentionSweep", () => {
  it("does nothing when no shops are past the grace window", async () => {
    const { sb, deleteCalls } = makeFakeSb({ candidates: [], rawDeleted: 0 });
    const result = await runGdprAndRetentionSweep(sb);
    expect(result.shopsRedacted).toEqual([]);
    // No per-shop deletes at all — only the (no-op) raw retention trim.
    const perShop = deleteCalls.filter((c) => c.kind === "eq");
    expect(perShop).toHaveLength(0);
    expect(result.rawWebhookRowsDeleted).toBe(0);
  });

  it("purges every per-shop table exactly once, in order, for one candidate", async () => {
    const SHOP = "11111111-1111-1111-1111-111111111111";
    const { sb, deleteCalls } = makeFakeSb({
      candidates: [{ id: SHOP }],
      rawDeleted: 7,
    });

    const result = await runGdprAndRetentionSweep(sb);
    expect(result.shopsRedacted).toEqual([SHOP]);
    expect(result.rawWebhookRowsDeleted).toBe(7);

    // Per-shop purges are the .eq() deletes (the raw trim is .lt()).
    const perShopCalls = deleteCalls.filter((c) => c.kind === "eq");
    expect(perShopCalls.map((c) => c.table)).toEqual([
      ...PER_SHOP_TABLES_PURGE_ORDER,
    ]);

    // shops is keyed by id; every other per-shop table by shop_id.
    for (const c of perShopCalls) {
      if (c.table === "shops") {
        expect(c.eq).toEqual({ column: "id", value: SHOP });
      } else {
        expect(c.eq).toEqual({ column: "shop_id", value: SHOP });
      }
    }
  });

  it("records a failed shop (does not throw or silently pass) and keeps going", async () => {
    const BAD = "22222222-2222-2222-2222-222222222222";
    const GOOD = "33333333-3333-3333-3333-333333333333";
    // BAD fails on `alerts`; GOOD (queued after it) must still be redacted —
    // per-shop isolation: one shop's failure never aborts the batch (rule 12).
    const { sb } = makeFakeSb({
      candidates: [{ id: BAD }, { id: GOOD }],
      rawDeleted: 0,
      failTable: "alerts",
      failShopId: BAD,
    });

    const result = await runGdprAndRetentionSweep(sb);

    expect(result.shopsRedacted).toEqual([GOOD]);
    expect(result.shopsFailed).toHaveLength(1);
    expect(result.shopsFailed[0]!.id).toBe(BAD);
    expect(result.shopsFailed[0]!.error).toMatch(/alerts/);
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
        // --- delete chain (per-shop table OR raw trim) ---
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

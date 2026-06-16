import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileAttributedRevenue, ORDER_ID_BATCH } from "../revenue.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

type ErrObj = { message: string; details?: string; hint?: string; code?: string };

// Fake returns: attribution_fact rows (campaign_id, order_id, attributed_revenue_cents)
// and order_fact rows (id, created_at_source). Records ad_spend_fact updates.
// `errors` injects a raw PostgREST-style error object on a given table's read.
// order_fact reads honour the `.in("id", batch)` filter so we can assert the
// query is chunked (one read per batch) instead of one giant URL.
function fakeSb(
  attr: Array<Record<string, unknown>>,
  orders: Array<Record<string, unknown>>,
  errors: Partial<Record<"attribution_fact" | "order_fact" | "ad_spend_fact", ErrObj>> = {},
) {
  const calls = {
    updates: [] as Array<{ match: Record<string, unknown>; values: Record<string, unknown> }>,
    orderInBatches: [] as string[][],
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    const match: Record<string, unknown> = {};
    let inIds: string[] | null = null;
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { match[col] = val; return chain; });
    chain.in = vi.fn((_col: string, vals: string[]) => {
      inIds = vals;
      if (table === "order_fact") calls.orderInBatches.push(vals);
      return chain;
    });
    chain.gt = vi.fn(() => chain);
    chain.update = vi.fn((values: Record<string, unknown>) => {
      const upd: Record<string, unknown> = {};
      const updChain: Record<string, unknown> = {
        eq: vi.fn((c: string, v: unknown) => { upd[c] = v; return updChain; }),
        then: (resolve: (r: { error: ErrObj | null }) => unknown) => {
          if (errors.ad_spend_fact) return resolve({ error: errors.ad_spend_fact });
          calls.updates.push({ match: { ...upd }, values });
          return resolve({ error: null });
        },
      };
      return updChain;
    });
    chain.then = (resolve: (r: { data: unknown; error: ErrObj | null }) => unknown) => {
      const err = errors[table as keyof typeof errors];
      if (err) return resolve({ data: null, error: err });
      let data: unknown;
      if (table === "attribution_fact") data = attr;
      else if (table === "order_fact") {
        data = inIds ? orders.filter((o) => inIds!.includes(String((o as { id: string }).id))) : orders;
      } else data = [];
      return resolve({ data, error: null });
    };
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("reconcileAttributedRevenue", () => {
  it("sums attributed revenue per campaign/day and updates ad_spend_fact", async () => {
    const attr = [
      { campaign_id: "u-meta", order_id: "o1", attributed_revenue_cents: 10000 },
      { campaign_id: "u-meta", order_id: "o2", attributed_revenue_cents: 5000 },
    ];
    const orders = [
      { id: "o1", created_at_source: "2026-06-01T10:00:00Z" },
      { id: "o2", created_at_source: "2026-06-01T20:00:00Z" },
    ];
    const { sb, calls } = fakeSb(attr, orders);
    await reconcileAttributedRevenue(SHOP, sb);
    expect(calls.updates).toContainEqual({
      // shop_id scope on the write is part of the contract (service-role
      // client bypasses RLS; the tenant filter is the cross-shop guard).
      match: { shop_id: SHOP, campaign_id: "u-meta", day: "2026-06-01" },
      values: { revenue_attrib_cents: 15000 },
    });
  });

  it("ignores attribution rows with no campaign (campaign_id null)", async () => {
    const attr = [{ campaign_id: null, order_id: "o3", attributed_revenue_cents: 0 }];
    const orders = [{ id: "o3", created_at_source: "2026-06-02T00:00:00Z" }];
    const { sb, calls } = fakeSb(attr, orders);
    await reconcileAttributedRevenue(SHOP, sb);
    expect(calls.updates).toHaveLength(0);
  });

  // ROOT-CAUSE REGRESSION: a shop with thousands of attributed orders blew up the
  // order_fact `.in("id", [...])` into a ~67KB GET URL (414 / fetch failure),
  // surfaced in prod as "[object Object]". The lookup MUST be chunked so each
  // request stays well under any URL-length limit, and every order still resolves.
  it("chunks the order_fact lookup so a large shop's URL never overflows", async () => {
    const n = ORDER_ID_BATCH * 2 + 5; // forces 3 batches
    const attr = Array.from({ length: n }, (_, i) => ({
      campaign_id: "u-meta",
      order_id: `o${i}`,
      attributed_revenue_cents: 100,
    }));
    const orders = Array.from({ length: n }, (_, i) => ({
      id: `o${i}`,
      created_at_source: "2026-06-01T10:00:00Z",
    }));
    const { sb, calls } = fakeSb(attr, orders);
    await reconcileAttributedRevenue(SHOP, sb);

    // batched into ceil(n / ORDER_ID_BATCH) reads, none exceeding the batch size
    expect(calls.orderInBatches).toHaveLength(Math.ceil(n / ORDER_ID_BATCH));
    for (const batch of calls.orderInBatches) {
      expect(batch.length).toBeLessThanOrEqual(ORDER_ID_BATCH);
    }
    // every order still attributed -> all n cents summed onto the one campaign/day
    expect(calls.updates).toContainEqual({
      match: { shop_id: SHOP, campaign_id: "u-meta", day: "2026-06-01" },
      values: { revenue_attrib_cents: 100 * n },
    });
  });

  // A raw PostgREST error object must be rethrown as a real Error with a readable
  // message — never propagated as a bare {message, code} object (which stringifies
  // to "[object Object]").
  it("rethrows a Supabase read error as a descriptive Error, not a raw object", async () => {
    const attr = [{ campaign_id: "u-meta", order_id: "o1", attributed_revenue_cents: 1 }];
    const orders = [{ id: "o1", created_at_source: "2026-06-01T00:00:00Z" }];
    const pgErr: ErrObj = { message: "URI too long", code: "PGRST301", details: "uri" };
    const { sb } = fakeSb(attr, orders, { order_fact: pgErr });

    await expect(reconcileAttributedRevenue(SHOP, sb)).rejects.toThrow(Error);
    await expect(reconcileAttributedRevenue(SHOP, sb)).rejects.toThrow(/URI too long/);
  });
});

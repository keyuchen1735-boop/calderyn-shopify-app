import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileAttributedRevenue } from "../revenue.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

// Fake returns: attribution_fact rows (campaign_id, order_id, attributed_revenue_cents)
// and order_fact rows (id, created_at_source). Records ad_spend_fact updates.
function fakeSb(attr: Array<Record<string, unknown>>, orders: Array<Record<string, unknown>>) {
  const calls = { updates: [] as Array<{ match: Record<string, unknown>; values: Record<string, unknown> }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    const match: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { match[col] = val; return chain; });
    chain.in = vi.fn(() => chain);
    chain.gt = vi.fn(() => chain);
    chain.update = vi.fn((values: Record<string, unknown>) => {
      // capture subsequent .eq() matches for this update
      const upd: Record<string, unknown> = {};
      const updChain: Record<string, unknown> = {
        eq: vi.fn((c: string, v: unknown) => { upd[c] = v; return updChain; }),
        then: (resolve: (r: { error: null }) => unknown) => {
          calls.updates.push({ match: { ...upd }, values });
          return resolve({ error: null });
        },
      };
      return updChain;
    });
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "attribution_fact" ? attr : orders, error: null });
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
      match: { campaign_id: "u-meta", day: "2026-06-01" },
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
});

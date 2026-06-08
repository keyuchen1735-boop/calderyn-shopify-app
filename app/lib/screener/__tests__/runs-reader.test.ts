/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
//
// Shop-scoping guard for getLatestRunForAd. The app uses the service-role key
// (RLS bypassed), so cross-shop isolation lives entirely in the `.eq("shop_id")`
// filter. This seeds two shops' runs for the SAME meta_ad_id and asserts the
// reader returns only the calling shop's row, the latest done one, or null.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  let descByCreatedAt = false;
  const matches = () => {
    let rows = (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    if (descByCreatedAt) {
      rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    return rows;
  };
  const api: any = {
    select: () => api,
    order: (col: string, opts?: { ascending?: boolean }) => {
      if (col === "created_at" && opts?.ascending === false) descByCreatedAt = true;
      return api;
    },
    limit: () => api,
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
  };
  return api;
}

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
  resolveShopId: async (domain: string) => {
    if (domain === "a.myshopify.com") return "shop-A";
    if (domain === "b.myshopify.com") return "shop-B";
    throw new Error(`unknown shop ${domain}`);
  },
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered first
import { getLatestRunForAd } from "../runs.server";

const A = "a.myshopify.com";
const B = "b.myshopify.com";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("getLatestRunForAd", () => {
  it("returns the latest done run for the ad, shop-scoped", async () => {
    store["v_creative_screen_runs"] = [
      {
        id: "a-old", shop_id: "shop-A", meta_ad_id: "ad-1", status: "done",
        source: "meta_ad", assumed_spend_cents: 50000, scorecard: { composite: 50 },
        error: null, created_at: "2026-06-01T00:00:00Z", completed_at: "2026-06-01T00:00:05Z",
      },
      {
        id: "a-new", shop_id: "shop-A", meta_ad_id: "ad-1", status: "done",
        source: "meta_ad", assumed_spend_cents: 50000, scorecard: { composite: 80 },
        error: null, created_at: "2026-06-05T00:00:00Z", completed_at: "2026-06-05T00:00:05Z",
      },
    ];
    const run = await getLatestRunForAd(A, "ad-1");
    expect(run?.id).toBe("a-new");
    expect(run?.scorecard).toEqual({ composite: 80 });
  });

  it("does not leak another shop's run for the same meta_ad_id", async () => {
    store["v_creative_screen_runs"] = [
      {
        id: "b-1", shop_id: "shop-B", meta_ad_id: "ad-1", status: "done",
        source: "meta_ad", assumed_spend_cents: 50000, scorecard: { composite: 99 },
        error: null, created_at: "2026-06-05T00:00:00Z", completed_at: "2026-06-05T00:00:05Z",
      },
    ];
    // Shop A asks for the same ad id; B's row must not leak.
    expect(await getLatestRunForAd(A, "ad-1")).toBeNull();
  });

  it("returns null when no done run exists for the ad", async () => {
    store["v_creative_screen_runs"] = [
      {
        id: "a-running", shop_id: "shop-A", meta_ad_id: "ad-1", status: "running",
        source: "meta_ad", assumed_spend_cents: 50000, scorecard: null,
        error: null, created_at: "2026-06-05T00:00:00Z", completed_at: null,
      },
    ];
    // status filter excludes the running row → no match.
    expect(await getLatestRunForAd(A, "ad-1")).toBeNull();
    // different shop B has nothing at all
    expect(await getLatestRunForAd(B, "ad-1")).toBeNull();
  });
});

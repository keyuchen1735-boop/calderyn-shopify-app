/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
//
// Tenant-isolation regression guard for calderynClient.
//
// The app uses the Supabase SERVICE-ROLE key, which bypasses Row-Level Security
// (see app/lib/supabase.server.ts) — so cross-shop isolation is enforced ENTIRELY
// in code, by every per-shop query carrying `.eq("shop_id", ...)`. One forgotten
// filter = a cross-tenant data leak with no DB safety net. These tests seed two
// shops' rows into the same views/tables and assert each calderynClient read
// returns ONLY the calling shop's data. If a method drops its shop scoping, the
// other shop's rows leak through and the matching test fails.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const api: any = {
    select: () => api,
    order: () => api,
    limit: () => api,
    gte: () => api, // date-window filter: irrelevant to shop isolation, treat as no-op
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    single: async () => ({ data: matches()[0] ?? null, error: null }),
    then: (resolve: (v: { data: any; error: null }) => void) =>
      resolve({ data: matches(), error: null }),
  };
  return api;
}

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
  resolveShopId: async (domain: string) => {
    if (domain === "a.myshopify.com") return "shop-A";
    if (domain === "b.myshopify.com") return "shop-B";
    throw new Error(`unknown shop ${domain}`);
  },
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered before the module under test loads
import { calderynClient } from "../calderyn.server";

const A = "a.myshopify.com";
const B = "b.myshopify.com";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  // Two shops, identical-shaped rows in every per-shop view/table.
  store["v_alerts_view"] = [
    { id: "a1", shop_id: "shop-A", detector_id: "d", severity: "high", status: "open" },
    { id: "b1", shop_id: "shop-B", detector_id: "d", severity: "high", status: "open" },
  ];
  store["v_audit_view"] = [
    { id: "a-aud", shop_id: "shop-A", action_kind: "pause_campaign", outcome: "succeeded" },
    { id: "b-aud", shop_id: "shop-B", action_kind: "pause_campaign", outcome: "succeeded" },
  ];
  store["v_campaigns_flat"] = [
    { id: "a-camp", shop_id: "shop-A", name: "A camp", platform: "meta" },
    { id: "b-camp", shop_id: "shop-B", name: "B camp", platform: "meta" },
  ];
  store["v_skus_flat"] = [
    { id: "a-sku", shop_id: "shop-A", title: "A sku" },
    { id: "b-sku", shop_id: "shop-B", title: "B sku" },
  ];
  store["guardrail_config"] = [
    { shop_id: "shop-A", daily_action_budget: 100 },
    { shop_id: "shop-B", daily_action_budget: 999 },
  ];
  store["shop_integrations"] = [
    { shop_id: "shop-A", kind: "meta_ads", sync_status: "ready" },
    { shop_id: "shop-B", kind: "google_ads", sync_status: "ready" },
  ];
  store["ad_spend_fact"] = [
    { shop_id: "shop-A", day: "2026-06-01", spend_cents: 100, revenue_attrib_cents: 200 },
    { shop_id: "shop-B", day: "2026-06-01", spend_cents: 999, revenue_attrib_cents: 999 },
  ];
});

describe("calderynClient enforces shop scoping on every read", () => {
  it("alerts.list returns only the calling shop's alerts", async () => {
    const a = await calderynClient(A).alerts.list();
    expect(a.map((x) => x.id)).toEqual(["a1"]);
    const b = await calderynClient(B).alerts.list();
    expect(b.map((x) => x.id)).toEqual(["b1"]);
  });

  it("alerts.get cannot fetch another shop's alert by id", async () => {
    expect((await calderynClient(A).alerts.get("a1")).id).toBe("a1");
    await expect(calderynClient(A).alerts.get("b1")).rejects.toMatchObject({
      code: "ALERT_NOT_FOUND",
    });
  });

  it("audit.list returns only the calling shop's audit entries", async () => {
    expect((await calderynClient(A).audit.list()).map((x) => x.id)).toEqual(["a-aud"]);
  });

  it("campaigns.list returns only the calling shop's campaigns", async () => {
    expect((await calderynClient(A).campaigns.list()).map((x) => x.id)).toEqual(["a-camp"]);
  });

  it("skus.list returns only the calling shop's SKUs", async () => {
    expect((await calderynClient(A).skus.list()).map((x) => x.id)).toEqual(["a-sku"]);
  });

  it("guardrails.get returns the calling shop's config, not another shop's", async () => {
    // daily_action_budget 100 -> *100 cents; shop B's 999 must never appear.
    expect((await calderynClient(A).guardrails.get()).daily_action_budget_cents).toBe(10000);
  });

  it("integrations.list reflects only the calling shop's connections", async () => {
    const a = await calderynClient(A).integrations.list();
    expect(a.meta_ads.status).toBe("connected"); // A's own row
    expect(a.google_ads.status).toBe("disconnected"); // B's row must not leak in
  });

  it("analytics.dailyRoasSeries aggregates only the calling shop's spend", async () => {
    const series = await calderynClient(A).analytics.dailyRoasSeries(90);
    const totalSpend = series.reduce((s, r) => s + r.spend_cents, 0);
    expect(totalSpend).toBe(100); // never 100 + 999
  });
});

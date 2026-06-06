import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyAttribution } from "../apply.server";
import type { AttributionSignals } from "../types";

const SHOP = "00000000-0000-0000-0000-000000000010";
const ORDER = "00000000-0000-0000-0000-0000000000aa";

function fakeSb(campaignRows: Array<Record<string, unknown>>) {
  const calls = { upserts: [] as Array<{ table: string; rows: unknown; opts: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.upsert = vi.fn((rows: unknown, opts: unknown) => {
      calls.upserts.push({ table, rows, opts });
      return chain;
    });
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "ad_campaign_dim" ? campaignRows : [], error: null });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const campaigns = [{ id: "u-meta", external_id: "23998", name: "Spring Sale", platform: "meta" }];

describe("applyAttribution", () => {
  it("writes a campaign-attributed fact with confidence + a click_ref row", async () => {
    const signals: AttributionSignals = {
      utm: { utm_campaign: "Spring Sale" }, clickIds: { fbclid: "ABC" }, referringSite: null,
    };
    const { sb, calls } = fakeSb(campaigns);
    await applyAttribution(SHOP, ORDER, 10000, signals, sb);

    const af = calls.upserts.find((u) => u.table === "attribution_fact");
    expect(af?.opts).toEqual({ onConflict: "order_id,campaign_id" });
    expect((af?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP, order_id: ORDER, campaign_id: "u-meta", platform: "meta",
      attributed_revenue_cents: 10000, attribution_method: "utm_exact", confidence: "high",
    });
    const cr = calls.upserts.find((u) => u.table === "ad_click_ref");
    expect((cr?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP, order_id: ORDER, platform: "meta", click_id: "ABC",
    });
  });

  it("writes an unknown (campaign_id null) fact and no click_ref when there are no signals", async () => {
    const { sb, calls } = fakeSb(campaigns);
    await applyAttribution(SHOP, ORDER, 5000, { utm: {}, clickIds: {}, referringSite: null }, sb);
    const af = calls.upserts.find((u) => u.table === "attribution_fact");
    expect((af?.rows as Record<string, unknown>)).toMatchObject({
      campaign_id: null, platform: null, attribution_method: "unknown", confidence: "none",
    });
    expect(calls.upserts.find((u) => u.table === "ad_click_ref")).toBeUndefined();
  });
});

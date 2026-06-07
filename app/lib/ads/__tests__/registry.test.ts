import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adaptersForShops, AD_ADAPTERS } from "../registry.server";

function sbReturning(rows: Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

describe("AD_ADAPTERS", () => {
  it("registers exactly meta, google, tiktok", () => {
    expect(AD_ADAPTERS.map((a) => a.platform).sort()).toEqual(["google", "meta", "tiktok"]);
  });
});

describe("adaptersForShops", () => {
  it("pairs each integration row with its adapter", async () => {
    const sb = sbReturning([
      { shop_id: "s1", kind: "meta_ads", sync_status: "pending" },
      { shop_id: "s1", kind: "google_ads", sync_status: "live" },
      { shop_id: "s2", kind: "tiktok_ads", sync_status: "live" },
    ]);
    const work = await adaptersForShops(sb);
    expect(work).toHaveLength(3);
    expect(work[0]).toMatchObject({ shopId: "s1", status: "pending" });
    expect(work[0].adapter.platform).toBe("meta");
    expect(work.find((w) => w.shopId === "s2")?.adapter.platform).toBe("tiktok");
  });

  it("ignores rows whose kind has no registered adapter", async () => {
    const sb = sbReturning([{ shop_id: "s1", kind: "quickbooks", sync_status: "live" }]);
    expect(await adaptersForShops(sb)).toHaveLength(0);
  });
});

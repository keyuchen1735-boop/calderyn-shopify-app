import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCampaignDimId } from "../campaign-dim.server";

const SHOP = "00000000-0000-0000-0000-000000000003";

type SelectResult = { data: Record<string, unknown> | null; error: null };

// Fake supabase mirroring the select(...).eq(...).eq(...).eq(...).maybeSingle()
// reverse-lookup shape used by ad_campaign_dim reads.
function fakeSb(row: Record<string, unknown> | null) {
  const calls = { eqArgs: [] as Array<{ column: string; value: unknown }> };
  function builder(_table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((column: string, value: unknown) => {
      calls.eqArgs.push({ column, value });
      return chain;
    });
    chain.maybeSingle = vi.fn(async (): Promise<SelectResult> => ({ data: row, error: null }));
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("resolveCampaignDimId", () => {
  it("returns the dim uuid for a known (shop, platform, external_id)", async () => {
    const { sb, calls } = fakeSb({ id: "dim-uuid-1" });
    const id = await resolveCampaignDimId(sb, SHOP, "meta", "23848262133110025");
    expect(id).toBe("dim-uuid-1");
    expect(calls.eqArgs).toContainEqual({ column: "shop_id", value: SHOP });
    expect(calls.eqArgs).toContainEqual({ column: "platform", value: "meta" });
    expect(calls.eqArgs).toContainEqual({ column: "external_id", value: "23848262133110025" });
  });

  it("returns null when no dim row matches", async () => {
    const { sb } = fakeSb(null);
    const id = await resolveCampaignDimId(sb, SHOP, "meta", "does-not-exist");
    expect(id).toBeNull();
  });
});

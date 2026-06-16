import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shipAdaptersForShops, SHIP_ADAPTERS } from "../registry.server";

// Minimal fake: shipAdaptersForShops issues ONE query —
//   .from("shop_integrations").select(...).in("kind", [...]).in("sync_status", [...])
// — and reads { data, error }. The fake applies both .in() filters so the test
// genuinely exercises the status filter (contract §8.1 trap), not just a pass-through.
function fakeSb(rows: Array<{ shop_id: string; kind: string; sync_status: string }>): {
  sb: SupabaseClient;
  capturedStatuses: string[][];
} {
  const capturedStatuses: string[][] = [];
  let filtered = [...rows];
  const chain: Record<string, unknown> = {
    select() {
      return chain;
    },
    in(col: string, vals: string[]) {
      if (col === "sync_status") capturedStatuses.push(vals);
      filtered = filtered.filter((r) => vals.includes((r as Record<string, string>)[col]));
      return chain;
    },
    then(cb: (r: { data: typeof rows; error: null }) => unknown) {
      return Promise.resolve(cb({ data: filtered, error: null }));
    },
  };
  const sb = { from: () => chain } as unknown as SupabaseClient;
  return { sb, capturedStatuses };
}

describe("shipAdaptersForShops — status filter (contract §8.1 trap)", () => {
  it("RETURNS a freshly-connected shop at sync_status='ready' (the trap the ad code would miss)", async () => {
    const { sb } = fakeSb([{ shop_id: "shopA", kind: "easypost_ship", sync_status: "ready" }]);
    const work = await shipAdaptersForShops(sb);
    expect(work).toHaveLength(1);
    expect(work[0].shopId).toBe("shopA");
    expect(work[0].status).toBe("ready");
    expect(work[0].adapter.provider).toBe("easypost");
  });

  it("includes 'ready', 'pending' and 'live' but EXCLUDES 'error' shops", async () => {
    const { sb } = fakeSb([
      { shop_id: "ready1", kind: "easypost_ship", sync_status: "ready" },
      { shop_id: "pending1", kind: "easypost_ship", sync_status: "pending" },
      { shop_id: "live1", kind: "easypost_ship", sync_status: "live" },
      { shop_id: "error1", kind: "easypost_ship", sync_status: "error" },
    ]);
    const work = await shipAdaptersForShops(sb);
    expect(work.map((w) => w.shopId).sort()).toEqual(["live1", "pending1", "ready1"]);
  });

  it("queries exactly the ready/pending/live status set", async () => {
    const { sb, capturedStatuses } = fakeSb([]);
    await shipAdaptersForShops(sb);
    expect(capturedStatuses).toHaveLength(1);
    expect([...capturedStatuses[0]].sort()).toEqual(["live", "pending", "ready"]);
  });

  it("skips rows whose kind has no registered adapter (defensive)", async () => {
    const { sb } = fakeSb([
      { shop_id: "ads1", kind: "meta_ads", sync_status: "live" }, // not a ship kind
      { shop_id: "ep1", kind: "easypost_ship", sync_status: "live" },
    ]);
    const work = await shipAdaptersForShops(sb);
    expect(work.map((w) => w.shopId)).toEqual(["ep1"]);
  });

  it("propagates a query error instead of swallowing it (rule 12)", async () => {
    const chain: Record<string, unknown> = {
      select() {
        return chain;
      },
      in() {
        return chain;
      },
      then(cb: (r: { data: null; error: { message: string } }) => unknown) {
        return Promise.resolve(cb({ data: null, error: { message: "boom" } }));
      },
    };
    const sb = { from: () => chain } as unknown as SupabaseClient;
    await expect(shipAdaptersForShops(sb)).rejects.toMatchObject({ message: "boom" });
  });
});

describe("SHIP_ADAPTERS registry", () => {
  it("registers the EasyPost adapter with the easypost_ship kind", () => {
    expect(SHIP_ADAPTERS.some((a) => a.provider === "easypost" && a.integrationKind === "easypost_ship")).toBe(true);
  });
});

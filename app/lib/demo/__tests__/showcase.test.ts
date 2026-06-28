import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isShowcaseShop,
  showcaseActionAdapter,
  showcaseInventoryResult,
  SHOWCASE_OPERATION_ID,
} from "../showcase.server";

// Minimal fake of the supabase chain used by isShowcaseShop:
//   sb.from("shops").select("demo_mode").eq("id", shopId).maybeSingle()
function fakeSb(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("isShowcaseShop", () => {
  it("is true when shops.demo_mode is true", async () => {
    const sb = fakeSb({ data: { demo_mode: true }, error: null });
    expect(await isShowcaseShop("shop-demo-true", sb)).toBe(true);
  });

  it("is false when demo_mode is false", async () => {
    const sb = fakeSb({ data: { demo_mode: false }, error: null });
    expect(await isShowcaseShop("shop-demo-false", sb)).toBe(false);
  });

  it("is false when the shop row is absent", async () => {
    const sb = fakeSb({ data: null, error: null });
    expect(await isShowcaseShop("shop-missing", sb)).toBe(false);
  });

  it("fails safe to false (a real shop) on a lookup error", async () => {
    const sb = fakeSb({ data: null, error: { message: "boom" } });
    expect(await isShowcaseShop("shop-error", sb)).toBe(false);
  });
});

describe("showcaseActionAdapter", () => {
  it("succeeds on every campaign action without a network call", async () => {
    const a = showcaseActionAdapter("meta");
    expect(a.platform).toBe("meta");
    await expect(a.pause("ext")).resolves.toBeUndefined();
    await expect(a.resume("ext")).resolves.toBeUndefined();
    await expect(a.setDailyBudget("ext", 1234)).resolves.toBeUndefined();
    await expect(a.getState("ext")).resolves.toEqual({ status: "active", dailyBudgetCents: null });
    await expect(a.excludeGeo("ext", "us-west")).resolves.toBeUndefined();
    await expect(a.includeGeo("ext", "us-west")).resolves.toBeUndefined();
  });
});

describe("showcaseInventoryResult", () => {
  it("returns the simulated operation id", () => {
    expect(showcaseInventoryResult()).toEqual({ operationId: SHOWCASE_OPERATION_ID });
  });
});

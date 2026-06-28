// app/lib/storefront/__tests__/settings.test.ts
import { describe, it, expect } from "vitest";
import { getStoreSettings } from "../settings";

describe("getStoreSettings", () => {
  it("returns demo brand chrome echoing the requested shopId", () => {
    const s = getStoreSettings("demo-shop");
    expect(s.shopId).toBe("demo-shop");
    expect(s.storeName.length).toBeGreaterThan(0);
    expect(s.logoUrl.startsWith("http")).toBe(true);
    expect(s.palette).toEqual(
      expect.objectContaining({
        primary: expect.any(String),
        background: expect.any(String),
        text: expect.any(String),
      }),
    );
  });
});

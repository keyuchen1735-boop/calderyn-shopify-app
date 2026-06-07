import { describe, it, expect } from "vitest";
import { kindToProvider, isConnectable } from "../integrations";

describe("integration connect eligibility", () => {
  it("maps a persisted ad-platform kind to its OAuth provider short name", () => {
    expect(kindToProvider("meta_ads")).toBe("meta");
    expect(kindToProvider("google_ads")).toBe("google");
    expect(kindToProvider("tiktok_ads")).toBe("tiktok");
  });

  it("offers Connect for every provider with a wired OAuth backend", () => {
    expect(isConnectable("meta_ads")).toBe(true);
    expect(isConnectable("google_ads")).toBe(true);
    expect(isConnectable("tiktok_ads")).toBe(true);
  });

  it("does not offer Connect for unwired or Shopify-native sources", () => {
    expect(isConnectable("quickbooks")).toBe(false); // no OAuth backend wired yet
    expect(isConnectable("shopify")).toBe(false); // native, managed by Shopify
  });
});

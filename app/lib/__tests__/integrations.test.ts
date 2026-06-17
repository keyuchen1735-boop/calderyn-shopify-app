import { describe, it, expect } from "vitest";
import { kindToProvider, isConnectable, isOauthPending, isApiKeyConnect } from "../integrations";

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
    expect(isConnectable("quickbooks")).toBe(true); // QBO OAuth wired (auth.quickbooks.$)
  });

  it("does not offer Connect for Shopify-native sources", () => {
    expect(isConnectable("shopify")).toBe(false); // native, managed by Shopify
  });

  it("routes ShipHero down the API-key paste path, not OAuth (reclassified — credential/refresh)", () => {
    // ShipHero is credential/token-based (refresh-token paste), NOT OAuth. It must render the
    // inline paste field like EasyPost/ShipBob: isApiKeyConnect true, and NOT connectable /
    // NOT OAuth-pending (no "Coming soon" gate, no live OAuth Connect button).
    expect(isApiKeyConnect("shiphero_ship")).toBe(true);
    expect(isConnectable("shiphero_ship")).toBe(false);
    expect(isOauthPending("shiphero_ship")).toBe(false);
  });

  it("does not flag wired OAuth providers as pending", () => {
    expect(isOauthPending("meta_ads")).toBe(false);
    expect(isOauthPending("google_ads")).toBe(false);
    expect(isOauthPending("tiktok_ads")).toBe(false);
    expect(isOauthPending("quickbooks")).toBe(false);
  });
});

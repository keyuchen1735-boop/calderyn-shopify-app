import { describe, it, expect } from "vitest";
import { kindToProvider, isConnectable, isOauthPending } from "../integrations";

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

  it("flags ShipHero as OAuth-pending so the card shows 'Coming soon', not a live Connect", () => {
    // ShipHero is in OAUTH_PROVIDERS (eventual mechanism is OAuth) so isConnectable is true,
    // but its handshake isn't wired — an active Connect would always 501. The card must gate
    // on isOauthPending and render a disabled affordance instead.
    expect(isConnectable("shiphero_ship")).toBe(true);
    expect(isOauthPending("shiphero_ship")).toBe(true);
  });

  it("does not flag wired OAuth providers as pending", () => {
    expect(isOauthPending("meta_ads")).toBe(false);
    expect(isOauthPending("google_ads")).toBe(false);
    expect(isOauthPending("tiktok_ads")).toBe(false);
    expect(isOauthPending("quickbooks")).toBe(false);
  });
});

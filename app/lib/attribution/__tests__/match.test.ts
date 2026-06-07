import { describe, it, expect } from "vitest";
import { resolveAttribution } from "../match";
import type { CampaignRef, AttributionSignals } from "../types";

const campaigns: CampaignRef[] = [
  { id: "u-meta", external_id: "23998", name: "Spring Sale", platform: "meta" },
  { id: "u-goog", external_id: "G-77", name: "Brand Search", platform: "google" },
];

const empty: AttributionSignals = { utm: {}, clickIds: {}, referringSite: null };

describe("resolveAttribution", () => {
  it("matches utm_campaign by name (case-insensitive) → utm_exact, strong", () => {
    const r = resolveAttribution({ ...empty, utm: { utm_campaign: "spring sale", utm_source: "facebook" } }, campaigns);
    expect(r).toEqual({ campaignId: "u-meta", platform: "meta", method: "utm_exact", confidence: "strong" });
  });

  it("matches utm_campaign by external_id → utm_exact", () => {
    const r = resolveAttribution({ ...empty, utm: { utm_campaign: "G-77" } }, campaigns);
    expect(r.campaignId).toBe("u-goog");
    expect(r.method).toBe("utm_exact");
  });

  it("upgrades to high confidence when a click-id corroborates the utm campaign match", () => {
    const r = resolveAttribution(
      { ...empty, utm: { utm_campaign: "Spring Sale" }, clickIds: { fbclid: "X" } },
      campaigns,
    );
    expect(r).toMatchObject({ campaignId: "u-meta", method: "utm_exact", confidence: "high" });
  });

  it("falls back to click-id platform attribution when no utm campaign matches", () => {
    const r = resolveAttribution({ ...empty, clickIds: { gclid: "Y" } }, campaigns);
    expect(r).toEqual({ campaignId: null, platform: "google", method: "click_id", confidence: "rough" });
  });

  it("falls back to referrer host platform attribution", () => {
    const r = resolveAttribution({ ...empty, referringSite: "https://l.facebook.com/path" }, campaigns);
    expect(r).toEqual({ campaignId: null, platform: "meta", method: "referrer_host", confidence: "rough" });
  });

  it("returns unknown when nothing matches", () => {
    expect(resolveAttribution(empty, campaigns)).toEqual({
      campaignId: null, platform: null, method: "unknown", confidence: "none",
    });
  });

  it("does not match an unknown utm_campaign to any campaign", () => {
    const r = resolveAttribution({ ...empty, utm: { utm_campaign: "nonexistent" } }, campaigns);
    expect(r.method).toBe("unknown");
  });
});

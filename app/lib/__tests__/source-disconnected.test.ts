import { describe, it, expect } from "vitest";
import { isSourceDisconnected } from "../integration-status";

// P2-16: campaign data from a disconnected source must be flagged, not shown as
// live — Google Ads PMax kept showing grades while Google was disconnected.
const integrations = [
  { key: "meta_ads", status: "connected" },
  { key: "google_ads", status: "disconnected" },
  { key: "tiktok_ads", status: "disconnected" },
];

describe("isSourceDisconnected", () => {
  it("flags a campaign whose platform integration is disconnected", () => {
    expect(isSourceDisconnected("Google", integrations)).toBe(true);
    expect(isSourceDisconnected("TikTok", integrations)).toBe(true);
  });

  it("does not flag a connected source", () => {
    expect(isSourceDisconnected("Meta", integrations)).toBe(false);
  });

  it("does not flag a freshly-paired (pending) source", () => {
    expect(isSourceDisconnected("Google", [{ key: "google_ads", status: "pending" }])).toBe(false);
  });

  it("does not flag an unknown platform or absent integration", () => {
    expect(isSourceDisconnected("Snapchat", integrations)).toBe(false);
    expect(isSourceDisconnected("Google", [])).toBe(false);
  });
});

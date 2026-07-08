// The Creative panel's live preview is Meta-only (Meta is the only platform with
// a creative fetcher). This guards the regression where a TikTok/Google campaign
// was told to "Connect Meta to see this campaign's creative" — pointing the
// merchant at an integration that has nothing to do with the campaign they opened.
import { describe, expect, it } from "vitest";
import { creativeEmptyText } from "../campaign-creative-status";

describe("creativeEmptyText", () => {
  it("reports a refresh retry on load error, whatever the platform", () => {
    expect(creativeEmptyText("TikTok", { loadError: true, data: null })).toBe(
      "Couldn't load the creative — refresh to retry",
    );
  });

  it("shows a loading note while creatives are in flight", () => {
    expect(creativeEmptyText("Meta", { loadError: false, data: null })).toBe("Loading creative…");
  });

  it("never surfaces Meta-connect guidance on a TikTok campaign", () => {
    const text = creativeEmptyText("TikTok", { loadError: false, data: { metaConnected: false } });
    expect(text).not.toMatch(/Meta/);
    expect(text).toBe("Creative preview isn't available for TikTok campaigns yet");
  });

  it("never surfaces Meta-connect guidance on a Google campaign", () => {
    expect(creativeEmptyText("Google", { loadError: false, data: { metaConnected: true } })).toBe(
      "Creative preview isn't available for Google campaigns yet",
    );
  });

  it("keeps the Connect-Meta prompt for a Meta campaign with Meta disconnected", () => {
    expect(creativeEmptyText("Meta", { loadError: false, data: { metaConnected: false } })).toBe(
      "Connect Meta to see this campaign's creative",
    );
  });

  it("shows the no-creative state for a connected Meta campaign with no ads", () => {
    expect(creativeEmptyText("Meta", { loadError: false, data: { metaConnected: true } })).toBe(
      "No creative yet",
    );
  });
});

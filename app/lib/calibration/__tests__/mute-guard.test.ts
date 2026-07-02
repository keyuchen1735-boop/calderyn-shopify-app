// I8 interstitial guard: muting a shipped no-brainer needs an explicit second
// confirmation; normal pairs mute in one step as before.
import { describe, it, expect } from "vitest";
import { muteConfirmationMessage } from "../mute-guard";
import { NO_BRAINER } from "../confidence";

describe("muteConfirmationMessage", () => {
  it("returns a plain-language warning for every shipped no-brainer pair", () => {
    for (const key of NO_BRAINER) {
      const [detectorId, actionKind] = key.split(":");
      const msg = muteConfirmationMessage(detectorId, actionKind as never);
      expect(msg).toBeTruthy();
      expect(msg).toContain("protection");
      expect(msg).toContain("Learned rules");
      // Plain-language detector label, not the raw id.
      expect(msg).not.toContain(detectorId);
    }
  });

  it("returns null for a normal (non-no-brainer) pair — one-step mute as before", () => {
    expect(muteConfirmationMessage("ad_tax_overload", "reduce_campaign_budget")).toBeNull();
    expect(muteConfirmationMessage("margin_erosion", "adjust_price")).toBeNull();
  });
});

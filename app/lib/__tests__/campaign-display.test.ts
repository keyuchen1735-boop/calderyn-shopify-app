import { describe, expect, test } from "vitest";
import { campaignBudgetLabel, campaignRoasLabel } from "../campaign-display";

// Shared display rule for a campaign's 7-day ROAS, used by both the desktop
// DataTable and the mobile card list so the two surfaces never disagree.
describe("campaignRoasLabel", () => {
  test("formats a positive ROAS to one decimal with a × suffix", () => {
    expect(campaignRoasLabel(2.2)).toBe("2.2×");
    expect(campaignRoasLabel(4.74)).toBe("4.7×");
  });

  test("shows an em dash when there is no meaningful return (0 or negative)", () => {
    expect(campaignRoasLabel(0)).toBe("—");
    expect(campaignRoasLabel(-1)).toBe("—");
  });
});

// A paused campaign has no live daily budget to show; an active one shows the
// money. Same rule on both surfaces.
describe("campaignBudgetLabel", () => {
  test("shows the formatted daily budget for an active campaign", () => {
    expect(campaignBudgetLabel("active", 12000)).toBe("$120");
  });

  test("shows an em dash for a paused campaign regardless of stored budget", () => {
    expect(campaignBudgetLabel("paused", 12000)).toBe("—");
  });
});

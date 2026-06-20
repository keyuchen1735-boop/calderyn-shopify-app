import { describe, it, expect } from "vitest";
import { autopilotToasts, autopilotFailureLines, type AutopilotDecisionVM } from "../autopilot-banner";

const NAMES: Record<string, string> = {
  "c-pause": "Acme Prospecting",
  "c-reduce": "Retarget EU",
  "c-realloc": "Cold Audience",
  "c-scale": "Winning Lookalike",
};
const nameOf = (id: string) => NAMES[id] ?? "";

function acted(reason: string, campaignId: string): AutopilotDecisionVM {
  return { campaignId, detectorId: "d", intendedKind: null, outcome: "acted", reason };
}

describe("autopilotToasts", () => {
  it("emits one banner per LANDED action, in order", () => {
    const banners = autopilotToasts(
      [acted("pause_campaign", "c-pause"), acted("increase_campaign_budget", "c-scale")],
      nameOf,
    );
    expect(banners).toHaveLength(2);
    expect(banners[0].text).toBe("Auto-paused Acme Prospecting");
    expect(banners[1].text).toBe("Auto-scaled budget on Winning Lookalike");
  });

  it("ignores candidates that did not act (blocked / skipped / failed)", () => {
    const banners = autopilotToasts(
      [
        acted("pause_campaign", "c-pause"),
        { campaignId: "c-reduce", detectorId: "d", intendedKind: "reduce_campaign_budget", outcome: "blocked", reason: "daily action cap reached" },
        { campaignId: "c-scale", detectorId: "d", intendedKind: "increase_campaign_budget", outcome: "skipped", reason: "already at/above the daily ceiling" },
        { campaignId: "c-realloc", detectorId: "d", intendedKind: "pause_campaign", outcome: "failed", reason: "executor outcome: failed" },
      ],
      nameOf,
    );
    expect(banners).toHaveLength(1);
    expect(banners[0].text).toBe("Auto-paused Acme Prospecting");
  });

  it("uses the executed kind (decision.reason) to phrase each verb", () => {
    const banners = autopilotToasts(
      [
        acted("reduce_campaign_budget", "c-reduce"),
        acted("reallocate_budget", "c-realloc"),
      ],
      nameOf,
    );
    expect(banners.map((b) => b.text)).toEqual([
      "Auto-reduced budget on Retarget EU",
      "Auto-reallocated budget from Cold Audience",
    ]);
  });

  it("falls back to a generic noun when the campaign name is unknown", () => {
    const banners = autopilotToasts([acted("pause_campaign", "c-missing")], nameOf);
    expect(banners[0].text).toBe("Auto-paused a campaign");
  });

  it("tags every banner as an accent-toned bolt notification", () => {
    const [b] = autopilotToasts([acted("pause_campaign", "c-pause")], nameOf);
    expect(b.icon).toBe("bolt");
    expect(b.tone).toBe("accent");
  });

  it("returns nothing when no action landed", () => {
    expect(autopilotToasts([], nameOf)).toEqual([]);
  });
});

function failed(intendedKind: string | null, campaignId: string): AutopilotDecisionVM {
  // A failed decision carries intendedKind (the kind it tried) and a technical
  // reason ("executor outcome: failed" / "threw: ..."), not an executed kind.
  return { campaignId, detectorId: "d", intendedKind, outcome: "failed", reason: "executor outcome: failed" };
}

describe("autopilotFailureLines", () => {
  it("emits one line per FAILED decision, phrased by the kind it tried", () => {
    const lines = autopilotFailureLines(
      [failed("pause_campaign", "c-pause"), failed("increase_campaign_budget", "c-scale")],
      nameOf,
    );
    expect(lines).toEqual(["Couldn't pause Acme Prospecting", "Couldn't scale Winning Lookalike"]);
  });

  it("ignores acted / blocked / skipped decisions", () => {
    const lines = autopilotFailureLines(
      [
        acted("pause_campaign", "c-pause"),
        { campaignId: "c-reduce", detectorId: "d", intendedKind: "reduce_campaign_budget", outcome: "blocked", reason: "x" },
        { campaignId: "c-scale", detectorId: "d", intendedKind: "increase_campaign_budget", outcome: "skipped", reason: "y" },
        failed("reduce_campaign_budget", "c-reduce"),
      ],
      nameOf,
    );
    expect(lines).toEqual(["Couldn't lower the budget on Retarget EU"]);
  });

  it("falls back to a generic verb + noun for a thrown failure (null intendedKind, unknown name)", () => {
    expect(autopilotFailureLines([failed(null, "c-missing")], nameOf)).toEqual([
      "Couldn't act on a campaign",
    ]);
  });

  it("returns nothing when no action failed", () => {
    expect(autopilotFailureLines([acted("pause_campaign", "c-pause")], nameOf)).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { oneClickKind, canOneClickAlert } from "../one-click";
import type { AlertVM } from "~/components/dashboard/view-models";

const alert = (over: Partial<AlertVM> = {}): AlertVM =>
  ({ id: "a1", campaign_id: "c1", region: null, ...over }) as unknown as AlertVM;

describe("one-click resume_campaign (restock → resume ads)", () => {
  it("treats resume_campaign as a one-click, executable kind", () => {
    // Previously false, so an approved 'resume ads when restocked' proposal routed
    // to Review and dead-ended (no resume affordance on the alert surface).
    expect(oneClickKind("resume_campaign")).toBe(true);
  });

  it("can one-click resume when the alert carries a campaign id", () => {
    expect(canOneClickAlert(alert({ campaign_id: "c1" }), "resume_campaign")).toBe(true);
  });

  it("cannot one-click resume without a campaign id (would 422)", () => {
    expect(canOneClickAlert(alert({ campaign_id: null }), "resume_campaign")).toBe(false);
  });
});

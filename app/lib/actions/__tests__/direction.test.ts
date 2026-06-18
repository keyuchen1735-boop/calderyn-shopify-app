import { describe, it, expect } from "vitest";
import { recommendDirection, type DirectionInput } from "../direction.server";

const base: DirectionInput = {
  roas: 2,
  breakEvenRoas: 1,
  status: "active",
  hasScalingHeadroom: false,
  pauseAlertActive: false,
};

describe("recommendDirection", () => {
  it("recommends pause when roas is far below break-even (< 0.7x)", () => {
    const r = recommendDirection({ ...base, roas: 0.6, breakEvenRoas: 1 });
    expect(r.direction).toBe("pause");
    expect(r.actionKind).toBe("pause_campaign");
    expect(r.dataSufficient).toBe(true);
  });

  it("recommends pause when a pause-detector alert is active, even if roas is healthy", () => {
    const r = recommendDirection({ ...base, roas: 2, breakEvenRoas: 1, pauseAlertActive: true });
    expect(r.direction).toBe("pause");
  });

  it("recommends scale_down when roas is between 0.7x and 0.95x break-even", () => {
    const r = recommendDirection({ ...base, roas: 0.8, breakEvenRoas: 1 });
    expect(r.direction).toBe("scale_down");
    expect(r.actionKind).toBe("reduce_campaign_budget");
  });

  it("recommends keep when roas is around break-even (0.95x to 1.2x)", () => {
    const r = recommendDirection({ ...base, roas: 1.0, breakEvenRoas: 1 });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("recommends scale_up when winning (>= 1.2x) AND has scaling headroom", () => {
    const r = recommendDirection({ ...base, roas: 1.5, breakEvenRoas: 1, hasScalingHeadroom: true });
    expect(r.direction).toBe("scale_up");
    expect(r.actionKind).toBe("increase_campaign_budget");
  });

  it("recommends keep when winning but no scaling headroom", () => {
    const r = recommendDirection({ ...base, roas: 1.5, breakEvenRoas: 1, hasScalingHeadroom: false });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("keeps (paused) without an action when the campaign is paused", () => {
    const r = recommendDirection({ ...base, roas: 0.5, breakEvenRoas: 1, status: "paused" });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
    expect(r.dataSufficient).toBe(true);
  });

  it("keeps with dataSufficient=false when roas or break-even is null/non-positive", () => {
    expect(recommendDirection({ ...base, roas: null }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, breakEvenRoas: null }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, breakEvenRoas: 0 }).dataSufficient).toBe(false);
    const r = recommendDirection({ ...base, roas: null });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("uses the exact grade boundaries: 1.2x is scale-eligible, 0.95x is keep, 0.7x is scale_down", () => {
    expect(recommendDirection({ ...base, roas: 1.2, breakEvenRoas: 1, hasScalingHeadroom: true }).direction).toBe("scale_up");
    expect(recommendDirection({ ...base, roas: 0.95, breakEvenRoas: 1 }).direction).toBe("keep");
    expect(recommendDirection({ ...base, roas: 0.7, breakEvenRoas: 1 }).direction).toBe("scale_down");
    expect(recommendDirection({ ...base, roas: 0.69, breakEvenRoas: 1 }).direction).toBe("pause");
  });
});

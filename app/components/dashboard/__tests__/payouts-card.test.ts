import { describe, it, expect } from "vitest";
import { payoutsCardState } from "../view-models";

const BASE = {
  connected: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  feeBps: 0,
  feeFlatCents: 0,
};

describe("payoutsCardState", () => {
  it("not connected → setup CTA", () => {
    expect(payoutsCardState(BASE)).toEqual({
      phase: "not_connected",
      pillTone: "neutral",
      pillLabel: "Not set up",
      cta: "setup",
      feeLabel: "Platform fee: 0% — pilot",
    });
  });

  it("connected but incomplete → resume CTA, warn pill", () => {
    expect(payoutsCardState({ ...BASE, connected: true, detailsSubmitted: true })).toMatchObject({
      phase: "onboarding",
      pillTone: "warn",
      pillLabel: "Onboarding incomplete",
      cta: "resume",
    });
  });

  it("fully enabled → active, no CTA", () => {
    expect(
      payoutsCardState({
        ...BASE,
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
    ).toMatchObject({ phase: "active", pillTone: "success", pillLabel: "Payouts active", cta: null });
  });

  it("formats a non-zero fee", () => {
    expect(payoutsCardState({ ...BASE, feeBps: 250, feeFlatCents: 30 }).feeLabel).toBe(
      "Platform fee: 2.5% + $0.30",
    );
  });
});

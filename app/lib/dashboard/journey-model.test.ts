import { describe, expect, it } from "vitest";
import { journeyView, journeyToastText, JOURNEY_STEPS } from "./journey-model";

const T0 = "2026-07-13T00:00:00.000Z";
const LATER = "2026-07-20T00:00:00.000Z";

describe("journeyView", () => {
  it("defines exactly 9 steps, 3 per phase", () => {
    expect(JOURNEY_STEPS).toHaveLength(9);
    for (const p of [1, 2, 3]) {
      expect(JOURNEY_STEPS.filter((s) => s.phase === p)).toHaveLength(3);
    }
  });

  it("fresh store: phase 1, next = first_product, account pre-done", () => {
    const v = journeyView({ completed: { account: T0 }, liveCardDismissed: false, recapDismissed: false });
    expect(v.phase).toBe(1);
    expect(v.next).toBe("first_product");
    expect(v.retired).toBe(false);
  });

  it("phase advances when all its steps complete; next is first incomplete in order", () => {
    const v = journeyView({
      completed: { account: T0, first_product: T0, payouts: T0, shipping: LATER },
      liveCardDismissed: false, recapDismissed: false,
    });
    expect(v.phase).toBe(2);
    expect(v.phasesComplete).toEqual([1]);
    expect(v.next).toBe("storefront_published");
  });

  it("retires when first_order completes", () => {
    const all = Object.fromEntries(JOURNEY_STEPS.map((s) => [s.key, T0]));
    const v = journeyView({
      completed: { ...all, first_order: LATER },
      liveCardDismissed: false, recapDismissed: false,
    });
    expect(v.retired).toBe(true);
    expect(v.showRecap).toBe(true);
  });

  it("backfilled shops (everything stamped in one recompute) retire silently", () => {
    const all = Object.fromEntries(JOURNEY_STEPS.map((s) => [s.key, T0]));
    const v = journeyView({ completed: all, liveCardDismissed: false, recapDismissed: false });
    expect(v.retired).toBe(true);
    expect(v.showRecap).toBe(false);
    expect(v.showLiveCard).toBe(false);
  });

  it("live card shows after a real (non-backfilled) publish until dismissed or retired", () => {
    const v = journeyView({
      completed: { account: T0, first_product: T0, payouts: T0, shipping: T0, storefront_published: LATER },
      liveCardDismissed: false, recapDismissed: false,
    });
    expect(v.showLiveCard).toBe(true);
    const dismissed = journeyView({
      completed: { account: T0, storefront_published: LATER },
      liveCardDismissed: true, recapDismissed: false,
    });
    expect(dismissed.showLiveCard).toBe(false);
  });
});

describe("journeyToastText", () => {
  it("names the done step and the next one", () => {
    expect(journeyToastText("payouts", "shipping")).toBe(
      "Payouts connected — next: set up shipping",
    );
  });
  it("celebrates plainly when nothing is next", () => {
    expect(journeyToastText("first_order", null)).toBe("First order — setup complete.");
  });
});

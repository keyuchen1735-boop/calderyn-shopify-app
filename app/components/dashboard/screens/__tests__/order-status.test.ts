import { describe, expect, it } from "vitest";
import {
  fulfillmentBadge,
  isStuckUnfulfilled,
  paymentPillStyle,
  REFUNDABLE_ORDER_STATES,
  stuckDays,
} from "../order-status";

describe("fulfillmentBadge", () => {
  it("shows Unfulfilled for a paid order with nothing shipped yet", () => {
    expect(fulfillmentBadge("paid", null)).toEqual({ label: "Unfulfilled", tone: "var(--orange)" });
  });

  it("shows Partially fulfilled while some lines are still open", () => {
    expect(fulfillmentBadge("partially_fulfilled", null)).toEqual({
      label: "Partially fulfilled",
      tone: "var(--orange)",
    });
  });

  it("shows Fulfilled once every line has shipped", () => {
    expect(fulfillmentBadge("fulfilled", null)).toEqual({ label: "Fulfilled", tone: "var(--green)" });
  });

  it("shows Cancelled when the state itself is cancelled", () => {
    expect(fulfillmentBadge("cancelled", null)).toEqual({ label: "Cancelled", tone: "var(--text-3)" });
  });

  it("shows Cancelled when cancelledAt is set, even if state hasn't caught up", () => {
    expect(fulfillmentBadge("paid", "2026-07-01T00:00:00Z")).toEqual({
      label: "Cancelled",
      tone: "var(--text-3)",
    });
  });

  it("returns null for checkout_pending — fulfillment isn't a concept yet", () => {
    expect(fulfillmentBadge("checkout_pending", null)).toBeNull();
  });

  it("returns null for cart", () => {
    expect(fulfillmentBadge("cart", null)).toBeNull();
  });

  it("returns null for refunded — the lifecycle state no longer carries fulfillment info", () => {
    expect(fulfillmentBadge("refunded", null)).toBeNull();
  });

  it("returns null for partially_refunded", () => {
    expect(fulfillmentBadge("partially_refunded", null)).toBeNull();
  });

  it("returns null for an unrecognized state", () => {
    expect(fulfillmentBadge("some_future_state", null)).toBeNull();
  });
});

describe("REFUNDABLE_ORDER_STATES", () => {
  it("includes partially_fulfilled as refundable", () => {
    expect(REFUNDABLE_ORDER_STATES.has("partially_fulfilled")).toBe(true);
  });
});

describe("paymentPillStyle", () => {
  it("maps paid to a success pill", () => {
    expect(paymentPillStyle("paid")).toEqual({ label: "Paid", tone: "success" });
  });

  it("maps refunded and partially_refunded to warn pills", () => {
    expect(paymentPillStyle("refunded")).toEqual({ label: "Refunded", tone: "warn" });
    expect(paymentPillStyle("partially_refunded")).toEqual({ label: "Partially refunded", tone: "warn" });
  });

  it("title-cases an unrecognized status rather than showing the raw key", () => {
    expect(paymentPillStyle("some_new_status")).toEqual({ label: "Some new status", tone: "neutral" });
  });
});

describe("isStuckUnfulfilled", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-07-10T00:00:00.000Z").getTime();

  it("false for a paid order right at the 3-day boundary (not yet over)", () => {
    const occurredAt = new Date(now - 3 * DAY_MS).toISOString();
    expect(isStuckUnfulfilled("paid", occurredAt, now)).toBe(false);
  });

  it("true for a paid order just past the 3-day boundary", () => {
    const occurredAt = new Date(now - 3 * DAY_MS - 1).toISOString();
    expect(isStuckUnfulfilled("paid", occurredAt, now)).toBe(true);
  });

  it("false for a fresh paid order (well under 3 days)", () => {
    const occurredAt = new Date(now - DAY_MS).toISOString();
    expect(isStuckUnfulfilled("paid", occurredAt, now)).toBe(false);
  });

  it("false for any non-paid state, even if very old", () => {
    const occurredAt = new Date(now - 30 * DAY_MS).toISOString();
    expect(isStuckUnfulfilled("fulfilled", occurredAt, now)).toBe(false);
    expect(isStuckUnfulfilled("partially_fulfilled", occurredAt, now)).toBe(false);
    expect(isStuckUnfulfilled("cancelled", occurredAt, now)).toBe(false);
  });

  it("false for an unparseable occurredAt rather than throwing", () => {
    expect(isStuckUnfulfilled("paid", "not-a-date", now)).toBe(false);
  });
});

describe("stuckDays", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-07-10T00:00:00.000Z").getTime();

  it("floors to whole elapsed days", () => {
    const occurredAt = new Date(now - 5 * DAY_MS - 12 * 60 * 60 * 1000).toISOString(); // 5.5 days
    expect(stuckDays(occurredAt, now)).toBe(5);
  });

  it("null for an unparseable occurredAt", () => {
    expect(stuckDays("garbage", now)).toBeNull();
  });
});

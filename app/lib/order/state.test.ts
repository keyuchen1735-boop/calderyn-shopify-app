import { describe, it, expect } from "vitest";
import {
  ORDER_STATES,
  LEGAL_TRANSITIONS,
  isOrderState,
  isLegalTransition,
  assertLegalTransition,
} from "./state";

describe("isOrderState", () => {
  it("accepts every state in the vocabulary and rejects others", () => {
    for (const s of ORDER_STATES) expect(isOrderState(s)).toBe(true);
    expect(isOrderState("abandoned")).toBe(false);
    expect(isOrderState("")).toBe(false);
  });
});

describe("isLegalTransition", () => {
  it("allows the documented forward edges", () => {
    expect(isLegalTransition("cart", "checkout_pending")).toBe(true);
    expect(isLegalTransition("checkout_pending", "paid")).toBe(true);
    expect(isLegalTransition("checkout_pending", "cancelled")).toBe(true);
    expect(isLegalTransition("paid", "fulfilled")).toBe(true);
    expect(isLegalTransition("paid", "refunded")).toBe(true);
    expect(isLegalTransition("fulfilled", "refunded")).toBe(true);
    // Refund edges (#3b): partial refund routes paid/fulfilled -> partially_refunded,
    // and a partially_refunded order can still reach full refunded.
    expect(isLegalTransition("paid", "partially_refunded")).toBe(true);
    expect(isLegalTransition("fulfilled", "partially_refunded")).toBe(true);
    expect(isLegalTransition("partially_refunded", "refunded")).toBe(true);
  });

  it("rejects skips, backward moves, identity, and moves out of terminal states", () => {
    expect(isLegalTransition("cart", "paid")).toBe(false); // skip
    expect(isLegalTransition("paid", "cart")).toBe(false); // backward
    expect(isLegalTransition("fulfilled", "paid")).toBe(false); // backward
    expect(isLegalTransition("paid", "paid")).toBe(false); // identity
    expect(isLegalTransition("cancelled", "paid")).toBe(false); // out of terminal
    expect(isLegalTransition("refunded", "fulfilled")).toBe(false); // out of terminal
    expect(isLegalTransition("partially_refunded", "partially_refunded")).toBe(false); // identity (a 2nd partial does not re-transition)
    expect(isLegalTransition("partially_refunded", "paid")).toBe(false); // backward
  });

  it("treats cancelled and refunded as terminal (no outgoing edges)", () => {
    expect(LEGAL_TRANSITIONS.cancelled).toHaveLength(0);
    expect(LEGAL_TRANSITIONS.refunded).toHaveLength(0);
  });
});

describe("order state machine — fulfillment + cancel edges", () => {
  it("knows partially_fulfilled", () => {
    expect(ORDER_STATES).toContain("partially_fulfilled");
  });
  it.each([
    ["paid", "partially_fulfilled", true],
    ["paid", "fulfilled", true],
    ["paid", "cancelled", true],
    ["partially_fulfilled", "fulfilled", true],
    ["partially_fulfilled", "cancelled", true],
    ["partially_fulfilled", "partially_refunded", true],
    ["fulfilled", "cancelled", false],
    ["partially_fulfilled", "paid", false],
    ["partially_fulfilled", "partially_fulfilled", false],
    ["cancelled", "paid", false],
  ] as const)("%s -> %s legal=%s", (from, to, legal) => {
    expect(isLegalTransition(from, to)).toBe(legal);
  });
  it("throws visibly on an illegal edge", () => {
    expect(() => assertLegalTransition("fulfilled", "cancelled")).toThrow(/illegal order transition/);
  });
});

describe("assertLegalTransition", () => {
  it("returns void for a legal transition", () => {
    expect(() => assertLegalTransition("paid", "fulfilled")).not.toThrow();
  });

  it("throws a visible error for an illegal transition, naming the allowed set", () => {
    expect(() => assertLegalTransition("cart", "paid")).toThrow(/illegal order transition cart -> paid/);
    // The thrown message renders the allowed set so the caller can see the legal options.
    expect(() => assertLegalTransition("checkout_pending", "fulfilled")).toThrow(/allowed from checkout_pending: paid, cancelled/);
  });

  it("throws a visible error for an unknown from/to state", () => {
    expect(() => assertLegalTransition("bogus", "paid")).toThrow(/unknown current order state: bogus/);
    expect(() => assertLegalTransition("paid", "bogus")).toThrow(/unknown target order state: bogus/);
  });

  it("reports terminal states as having no allowed transitions", () => {
    expect(() => assertLegalTransition("refunded", "paid")).toThrow(/none — terminal state/);
  });
});

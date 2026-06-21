import { describe, it, expect } from "vitest";
import { presentActionOutcome } from "../action-outcome";

// P0-1: a blocked action must never show a success toast or resolve the alert.
// `succeeded` is the ONLY outcome that may resolve/acknowledge the alert and
// apply the optimistic post-state. `retrying` is queued (not an error, not a
// success); `failed` is a terminal error.
describe("presentActionOutcome", () => {
  it("treats succeeded as a resolvable success (not an error)", () => {
    const v = presentActionOutcome("succeeded", "Pause campaign");
    expect(v.succeeded).toBe(true);
    expect(v.isError).toBe(false);
    expect(v.message).toMatch(/done/i);
  });

  it("treats retrying as queued — not succeeded, not an error", () => {
    const v = presentActionOutcome("retrying", "Pause campaign");
    expect(v.succeeded).toBe(false);
    expect(v.isError).toBe(false);
    expect(v.message).toMatch(/retry|queued/i);
  });

  it("treats failed as a terminal error that must not resolve the alert", () => {
    const v = presentActionOutcome("failed", "Pause campaign");
    expect(v.succeeded).toBe(false);
    expect(v.isError).toBe(true);
  });

  it("treats an unknown outcome as a failure, never a false success", () => {
    const v = presentActionOutcome("something-weird", "Pause campaign");
    expect(v.succeeded).toBe(false);
    expect(v.isError).toBe(true);
  });

  it("includes the action label in the message", () => {
    expect(presentActionOutcome("succeeded", "Reallocate inventory").message).toContain(
      "Reallocate inventory",
    );
  });
});

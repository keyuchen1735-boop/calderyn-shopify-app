// Refresh-on-focus core: when a surface's tab becomes visible again, we want a
// single quiet refresh — but not on every rapid tab-flick. createFocusRefresher
// is the pure, clock-injected decision unit the useRefreshOnFocus hook drives
// from real DOM events (mirrors pollLiveTick under useLiveFeed).
import { describe, expect, it } from "vitest";
import { createFocusRefresher } from "../use-refresh-on-focus";

/** A controllable clock: read via now(), advance via tick(ms). */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe("createFocusRefresher", () => {
  it("fires onRefresh on the first visible", () => {
    const clock = fakeClock();
    let calls = 0;
    const refresher = createFocusRefresher({
      now: clock.now,
      minIntervalMs: 10_000,
      onRefresh: () => calls++,
    });

    refresher.handleVisible();

    expect(calls).toBe(1);
  });

  it("skips a repeat visible within the cooldown window", () => {
    const clock = fakeClock();
    let calls = 0;
    const refresher = createFocusRefresher({
      now: clock.now,
      minIntervalMs: 10_000,
      onRefresh: () => calls++,
    });

    refresher.handleVisible(); // fires
    clock.tick(9_999); // still inside the 10s cooldown
    refresher.handleVisible(); // skipped

    expect(calls).toBe(1);
  });

  it("fires again after the cooldown, measured from the last fire", () => {
    const clock = fakeClock();
    let calls = 0;
    const refresher = createFocusRefresher({
      now: clock.now,
      minIntervalMs: 10_000,
      onRefresh: () => calls++,
    });

    refresher.handleVisible(); // t=0 → fires (1)
    clock.tick(10_000);
    refresher.handleVisible(); // t=10s → cooldown elapsed → fires (2)
    clock.tick(5_000);
    refresher.handleVisible(); // t=15s → only 5s since last fire → skipped
    clock.tick(5_000);
    refresher.handleVisible(); // t=20s → 10s since last fire → fires (3)

    expect(calls).toBe(3);
  });
});

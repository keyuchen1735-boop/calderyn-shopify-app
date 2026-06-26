import { describe, it, expect } from "vitest";
import { loadPairOutcomeTallies } from "../outcomes.server";

function fakeSb(rows: unknown[], error: unknown = null) {
  // Chain: .from().select().eq().not() -> resolves { data, error }
  const thenable = {
    eq() { return this; },
    not() { return Promise.resolve({ data: rows, error }); },
  };
  return { from: () => ({ select: () => thenable }) } as never;
}

describe("loadPairOutcomeTallies", () => {
  it("groups closed-window rewards into per-pair tallies", async () => {
    const sb = fakeSb([
      { action_kind: "pause_campaign", reward_signal: 10, reward_window_closed_at: "2026-06-20T00:00:00Z", alerts: { detector_id: "campaign_below_breakeven" } },
      { action_kind: "pause_campaign", reward_signal: 5, reward_window_closed_at: "2026-06-21T00:00:00Z", alerts: { detector_id: "campaign_below_breakeven" } },
      { action_kind: "pause_campaign", reward_signal: -100, reward_window_closed_at: "2026-06-22T00:00:00Z", alerts: { detector_id: "campaign_below_breakeven" } },
    ]);
    const m = await loadPairOutcomeTallies("shop1", sb);
    const t = m.get("campaign_below_breakeven:pause_campaign");
    expect(t?.netPositive).toBe(1);
    expect(t?.lastSign).toBe(-1);
  });

  it("returns an empty map on read error (fail-safe)", async () => {
    const sb = fakeSb([], { message: "boom" });
    const m = await loadPairOutcomeTallies("shop1", sb);
    expect(m.size).toBe(0);
  });

  it("skips rows with no detector (null alert join)", async () => {
    const sb = fakeSb([
      { action_kind: "pause_campaign", reward_signal: 10, reward_window_closed_at: "2026-06-20T00:00:00Z", alerts: null },
    ]);
    const m = await loadPairOutcomeTallies("shop1", sb);
    expect(m.size).toBe(0);
  });
});

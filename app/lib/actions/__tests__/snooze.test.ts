import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { snoozeAlert, resurfaceAllSnoozes } from "../snooze.server";
import {
  buildChain,
  getRecorded,
  setSupabaseResponse,
} from "../../__tests__/_supabase_chain_mock";

const NOW = new Date("2026-06-13T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("snoozeAlert", () => {
  it("defers an open alert by 1 day: status=snoozed + deadline, guarded on open", async () => {
    const sb = buildChain() as never;
    const ok = await snoozeAlert(sb, "shop-1", "al-1");

    expect(ok).toBe(true);
    // Writes the snooze deadline 24h out and flips status to snoozed.
    expect(getRecorded("update")[0][0]).toEqual({
      status: "snoozed",
      snoozed_until: "2026-06-14T12:00:00.000Z",
    });
    // Scoped to the shop + alert. The guard matches open OR snoozed so an
    // elapsed snooze (shown as open via the view) can be re-hidden, but a
    // resolved/acknowledged alert is never touched.
    const eqs = getRecorded("eq");
    expect(eqs).toContainEqual(["shop_id", "shop-1"]);
    expect(eqs).toContainEqual(["id", "al-1"]);
    expect(getRecorded("in")).toContainEqual(["status", ["open", "snoozed"]]);
  });

  it("returns false (not throw) when the write fails, so the action still records", async () => {
    setSupabaseResponse({ data: null, error: { message: "db down" } });
    const sb = buildChain() as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await snoozeAlert(sb, "shop-1", "al-1")).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("resurfaceAllSnoozes (next-login trigger)", () => {
  it("re-opens every snoozed alert for the shop regardless of deadline", async () => {
    const sb = buildChain() as never;
    const ok = await resurfaceAllSnoozes(sb, "shop-1");

    expect(ok).toBe(true);
    expect(getRecorded("update")[0][0]).toEqual({ status: "open", snoozed_until: null });
    expect(getRecorded("eq")).toContainEqual(["status", "snoozed"]);
    expect(getRecorded("eq")).toContainEqual(["shop_id", "shop-1"]);
    // No deadline filter — a login re-surfaces active snoozes too.
    expect(getRecorded("lte")).toEqual([]);
  });
});

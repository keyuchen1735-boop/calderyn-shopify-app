// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  saveConnectSnapshot,
  peekConnectSnapshot,
  clearConnectSnapshot,
} from "../campaign-wizard-snapshot";

const STEPS = ["platform", "product", "creative", "review"] as const;

const STATE = {
  runId: "run-1",
  step: "product",
  budgetCents: 2500,
  preflight: { metaConnected: false },
  productId: "p1",
  productTitle: "Trail Boots",
};

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("campaign wizard connect snapshot", () => {
  it("round-trips the wizard state with preflight dropped (fresh re-check on return)", () => {
    saveConnectSnapshot(STATE);
    const restored = peekConnectSnapshot<typeof STATE>(STEPS);
    expect(restored).toMatchObject({
      runId: "run-1",
      step: "product",
      budgetCents: 2500,
      productId: "p1",
      productTitle: "Trail Boots",
    });
    expect(restored?.preflight).toBeNull();
  });

  it("peek does not consume — the mount effect owns clearing", () => {
    saveConnectSnapshot(STATE);
    expect(peekConnectSnapshot(STEPS)).not.toBeNull();
    expect(peekConnectSnapshot(STEPS)).not.toBeNull();
    clearConnectSnapshot();
    expect(peekConnectSnapshot(STEPS)).toBeNull();
  });

  it("expires after the TTL instead of resurrecting an abandoned round-trip", () => {
    vi.useFakeTimers();
    saveConnectSnapshot(STATE);
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(peekConnectSnapshot(STEPS)).toBeNull();
  });

  it.each([
    ["unknown step", { ...STATE, step: "nope" }],
    ["missing runId", { ...STATE, runId: "" }],
    ["non-numeric budget", { ...STATE, budgetCents: Number.NaN }],
  ])("rejects a corrupt payload (%s) so the wizard falls back to a clean start", (_label, bad) => {
    saveConnectSnapshot(bad as typeof STATE);
    expect(peekConnectSnapshot(STEPS)).toBeNull();
  });

  it("survives garbage in the storage slot", () => {
    sessionStorage.setItem("cd-campaign-wizard-connect", "{not json");
    expect(peekConnectSnapshot(STEPS)).toBeNull();
  });
});

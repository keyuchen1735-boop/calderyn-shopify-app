// Guards the web-dashboard inline-execution policy: the "Ask Calderyn" chat may
// only offer "Run now" for action kinds DashboardApp.executeAction can actually
// execute against a live endpoint. exclude_geo / create_po_draft have NO
// dashboard endpoint, so they must deep-link to the Alerts review screen instead
// of faking a run (which previously reported a phantom "logged" success — a
// rule-12 / dashboard-parity violation).
import { describe, it, expect } from "vitest";

import { DASH_INLINE_ACTIONS, CHAT_INLINE_ACTIONS } from "~/lib/labels";

describe("DASH_INLINE_ACTIONS", () => {
  it("includes every kind the dashboard has a live endpoint for", () => {
    for (const k of [
      "pause_campaign",
      "reduce_campaign_budget",
      "snooze_alert",
      "reallocate_inventory",
    ] as const) {
      expect(DASH_INLINE_ACTIONS.has(k)).toBe(true);
    }
  });

  it("excludes kinds with no dashboard endpoint (they deep-link to review, never fake a run)", () => {
    expect(DASH_INLINE_ACTIONS.has("exclude_geo")).toBe(false);
    expect(DASH_INLINE_ACTIONS.has("create_po_draft")).toBe(false);
  });

  it("is a subset of the shared chat-inline policy", () => {
    for (const k of DASH_INLINE_ACTIONS) {
      expect(CHAT_INLINE_ACTIONS.has(k)).toBe(true);
    }
  });
});

// Guards the web-dashboard inline-execution policy: the "Ask Calderyn" chat may
// only offer "Run now" for action kinds DashboardApp.executeAction can actually
// execute against a live endpoint. exclude_geo / create_po_draft have NO
// dashboard endpoint, so they must deep-link to the Alerts review screen instead
// of faking a run (which previously reported a phantom "logged" success — a
// rule-12 / dashboard-parity violation).
import { describe, it, expect } from "vitest";

import { DASH_INLINE_ACTIONS, CHAT_INLINE_ACTIONS, dashReviewScreen } from "~/lib/labels";

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

// The dashboard chat shows "Review & confirm" for non-inline kinds and deep-links
// to a review surface. reallocate_budget has NO control on the Alerts detail (its
// budget edits live on the Campaigns screen), so routing it to "alerts" is a dead
// end — the bug this guards. Everything else reviews on the Alerts detail (its
// evidence/confirm view, or the PO draft dialog for create_po_draft).
describe("dashReviewScreen", () => {
  it("routes reallocate_budget to the Campaigns screen, not the Alerts dead end", () => {
    expect(dashReviewScreen("reallocate_budget")).toBe("campaigns");
  });

  it("keeps create_po_draft on the Alerts detail (the PO draft dialog lives there)", () => {
    expect(dashReviewScreen("create_po_draft")).toBe("alerts");
  });

  it("keeps every inline-executable kind on the Alerts detail review", () => {
    for (const k of DASH_INLINE_ACTIONS) {
      expect(dashReviewScreen(k)).toBe("alerts");
    }
  });
});

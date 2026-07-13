import { describe, it, expect } from "vitest";
import {
  decideRunTransition,
  canonicalJson,
  CREATING_STALE_MS,
  type WizardRunRow,
} from "../first-run-state";

const NOW = "2026-07-13T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** updated_at that is `ageMs` old relative to NOW. */
function agedIso(ageMs: number): string {
  return new Date(NOW_MS - ageMs).toISOString();
}

function row(over: Partial<WizardRunRow>): WizardRunRow {
  return { status: "creating", meta_campaign_id: null, updated_at: agedIso(0), ...over };
}

describe("decideRunTransition", () => {
  it("no row → fresh", () => {
    expect(decideRunTransition(null, NOW)).toBe("fresh");
  });

  it("created → replay, with or without a recorded campaign id", () => {
    expect(decideRunTransition(row({ status: "created", meta_campaign_id: "camp_1" }), NOW)).toBe("replay");
    expect(decideRunTransition(row({ status: "created", meta_campaign_id: null }), NOW)).toBe("replay");
  });

  it("creating, younger than the stale window → reject_in_progress regardless of campaign id", () => {
    expect(decideRunTransition(row({ updated_at: agedIso(0) }), NOW)).toBe("reject_in_progress");
    expect(decideRunTransition(row({ updated_at: agedIso(CREATING_STALE_MS - 1) }), NOW)).toBe(
      "reject_in_progress",
    );
    expect(
      decideRunTransition(row({ meta_campaign_id: "camp_1", updated_at: agedIso(60_000) }), NOW),
    ).toBe("reject_in_progress");
  });

  it("creating, at/over the stale window with a campaign id → needs_review (orphan may exist on Meta)", () => {
    expect(
      decideRunTransition(row({ meta_campaign_id: "camp_1", updated_at: agedIso(CREATING_STALE_MS) }), NOW),
    ).toBe("needs_review");
    expect(
      decideRunTransition(row({ meta_campaign_id: "camp_1", updated_at: agedIso(CREATING_STALE_MS * 10) }), NOW),
    ).toBe("needs_review");
  });

  it("creating, at/over the stale window without a campaign id → reopen (crashed before any Meta object)", () => {
    expect(decideRunTransition(row({ updated_at: agedIso(CREATING_STALE_MS) }), NOW)).toBe("reopen");
    expect(decideRunTransition(row({ updated_at: agedIso(CREATING_STALE_MS * 10) }), NOW)).toBe("reopen");
  });

  it("creating with an unparseable updated_at → treated as stale (orphan split applies)", () => {
    expect(decideRunTransition(row({ updated_at: "not-a-date" }), NOW)).toBe("reopen");
    expect(decideRunTransition(row({ meta_campaign_id: "camp_1", updated_at: "not-a-date" }), NOW)).toBe(
      "needs_review",
    );
  });

  it("failed without a campaign id → reopen; with one → needs_review", () => {
    expect(decideRunTransition(row({ status: "failed" }), NOW)).toBe("reopen");
    expect(decideRunTransition(row({ status: "failed", meta_campaign_id: "camp_1" }), NOW)).toBe(
      "needs_review",
    );
  });

  it("rolled_back without a campaign id → reopen; with one → needs_review", () => {
    expect(decideRunTransition(row({ status: "rolled_back" }), NOW)).toBe("reopen");
    expect(decideRunTransition(row({ status: "rolled_back", meta_campaign_id: "camp_1" }), NOW)).toBe(
      "needs_review",
    );
  });

  it("failed/rolled_back staleness is irrelevant — the orphan split decides", () => {
    expect(decideRunTransition(row({ status: "failed", updated_at: agedIso(0) }), NOW)).toBe("reopen");
    expect(
      decideRunTransition(
        row({ status: "rolled_back", meta_campaign_id: "camp_1", updated_at: agedIso(0) }),
        NOW,
      ),
    ).toBe("needs_review");
  });

  it("an empty-string campaign id counts as no orphan", () => {
    expect(decideRunTransition(row({ status: "failed", meta_campaign_id: "" }), NOW)).toBe("reopen");
  });

  it("unknown status → needs_review, with or without a campaign id (never touch Meta unclassified)", () => {
    expect(decideRunTransition(row({ status: "surprise" }), NOW)).toBe("needs_review");
    expect(decideRunTransition(row({ status: "surprise", meta_campaign_id: "camp_1" }), NOW)).toBe(
      "needs_review",
    );
    expect(decideRunTransition(row({ status: "" }), NOW)).toBe("needs_review");
  });
});

describe("canonicalJson", () => {
  it("is key-order independent (jsonb round-trips reorder keys)", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(
      canonicalJson({ creative: { headline: "H", cta: "SHOP_NOW" }, budget_cents: 1500 }),
    ).toBe(canonicalJson({ budget_cents: 1500, creative: { cta: "SHOP_NOW", headline: "H" } }));
  });

  it("distinguishes different values, arrays keep order, null/undefined serialize stably", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});

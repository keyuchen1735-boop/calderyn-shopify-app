// The experiment popover shows, per arm, the conversion rate plus a compact
// detail line: revenue in whole dollars and the cart/checkout funnel counts.
// Static markup only (the repo has no jsdom / testing-library; decide-button
// behavior is owned by Store.tsx handlers).
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExperimentPopover } from "../TopBar";
import type { StudioExperiment } from "~/lib/dashboard/store-client";

const EXPERIMENT: StudioExperiment = {
  id: "exp-1",
  name: "Sharper headline",
  why: "Tests a product-led hero headline against your current copy.",
  pageKey: "home",
  state: "running",
  startedAt: "2026-07-01T00:00:00Z",
  decidedAt: null,
  report: {
    aSessions: 200,
    bSessions: 210,
    aConversions: 10,
    bConversions: 21,
    aRevenueCents: 123_456,
    bRevenueCents: 250_000,
    funnel: { aCartAdds: 12, bCartAdds: 30, aCheckoutStarts: 5, bCheckoutStarts: 14 },
    lift: 1,
    confidence: 96,
  },
};

function render(exp: StudioExperiment): string {
  return renderToStaticMarkup(h(ExperimentPopover, { experiment: exp, onDecide: () => {}, deciding: false }));
}

describe("ExperimentPopover per-arm detail", () => {
  it("renders whole-dollar revenue and the funnel counts for both arms", () => {
    const markup = render(EXPERIMENT);
    expect(markup).toContain("$1,235 in sales · 12 carts / 5 checkouts");
    expect(markup).toContain("$2,500 in sales · 30 carts / 14 checkouts");
  });

  it("renders no report block when the report is missing", () => {
    const markup = render({ ...EXPERIMENT, report: null });
    expect(markup).not.toContain("in sales");
    expect(markup).toContain("Stop early");
  });
});

// app/components/dashboard/screens/__tests__/analytics-live.test.ts
import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { LiveSnapshotView } from "../AnalyticsLive";
import type { LiveAnalyticsSnapshot } from "~/lib/dashboard/client";

const SNAP: LiveAnalyticsSnapshot = {
  generated_at: "2026-07-02T20:00:00.000Z",
  visitors_now: 7,
  sessions_today: 128,
  total_sales_today_cents: 123400,
  currency: "usd",
  orders_today: 12,
  funnel: { cart_sessions: 30, checkout_sessions: 14, purchased_sessions: 11 },
  by_location: [
    { country: "US", sessions: 90 },
    { country: "DE", sessions: 20 },
    { country: "Other", sessions: 18 },
  ],
  new_vs_returning: { new: 100, returning: 28 },
  top_products: [{ product_id: "v1", title: "Mug", sales_cents: 80000, units: 40 }],
  hourly: {
    sales_cents: [0, 123400],
    orders: [0, 12],
    sessions: [50, 78],
    conversion_pct: [0, 15.4],
  },
};

function render(snapshot: LiveAnalyticsSnapshot | null, error: string | null = null): string {
  return renderToString(h(LiveSnapshotView, { snapshot, error })).replace(/<!-- -->/g, "");
}

describe("LiveSnapshotView", () => {
  it("renders every tile from the snapshot DTO", () => {
    const html = render(SNAP);
    expect(html).toContain("Visitors right now");
    expect(html).toContain("Sales today");
    expect(html).toContain("Sessions");
    expect(html).toContain("Orders");
    expect(html).toContain("Behavior");
    expect(html).toContain("Locations");
    expect(html).toContain("New vs returning");
    expect(html).toContain("Top products");
    expect(html).toContain("Mug");
    expect(html).toContain("US");
  });

  it("zero snapshot renders (cold start is a valid state, not an error)", () => {
    const html = render({
      ...SNAP,
      visitors_now: 0,
      sessions_today: 0,
      total_sales_today_cents: 0,
      orders_today: 0,
      funnel: { cart_sessions: 0, checkout_sessions: 0, purchased_sessions: 0 },
      by_location: [],
      new_vs_returning: { new: 0, returning: 0 },
      top_products: [],
    });
    expect(html).toContain("Visitors right now");
    expect(html).not.toContain("Couldn&#x27;t load");
  });

  it("error state renders the placeholder only when there is no snapshot", () => {
    const html = render(null, "boom");
    expect(html).toContain("Couldn&#x27;t load live view");
  });

  it("a transient error never blanks a board that has data", () => {
    const html = render(SNAP, "boom");
    expect(html).toContain("Visitors right now");
    expect(html).not.toContain("Couldn&#x27;t load live view");
  });

  it("loading state renders the placeholder", () => {
    const html = render(null, null);
    expect(html).toContain("Loading live view");
  });
});

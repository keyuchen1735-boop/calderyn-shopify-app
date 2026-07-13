import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ShippingSummary } from "~/lib/shipping/summary-types";
import {
  nextShippingTab,
  ShippingView,
  type ShippingTab,
} from "../screens/Shipping";

// Vitest hoists this factory ahead of the Shipping screen import above.
vi.mock("../ShippingRouteMap", () => ({
  default: ({ routes }: { routes: ShippingSummary["routes30d"] }) =>
    h(
      "div",
      { "data-route-map": true },
      `${routes.mappedOrderCount} mapped orders`,
    ),
}));

const summary: ShippingSummary = {
  quotes30d: {
    count: 42,
    avgShippingCents: 1299,
    fallbackSharePct: 18,
    lowConfidenceSharePct: 4,
    avgPromise: "2–5 days",
  },
  rateCard: [
    {
      carrier: "UPS",
      service: "Ground",
      amountCents: 1099,
      estDays: "3–4 days",
    },
    {
      carrier: "Canada Post",
      service: "Expedited Parcel",
      amountCents: 1499,
      estDays: "2–3 days",
    },
  ],
  origin: {
    street1: "123 King Street West",
    city: "Toronto",
    state: "ON",
    zip: "M5H 1J9",
    country: "CA",
    source: "merchant",
  },
  carrierService: { active: true },
  coverage: {
    variantsTotal: 20,
    withShipData: 17,
    missingDims: 3,
    restricted: 2,
  },
  routes30d: {
    origin: {
      city: "Toronto",
      region: "ON",
      country: "CA",
      latitude: 43.6532,
      longitude: -79.3832,
    },
    destinations: [
      {
        id: "new-york",
        city: "New York",
        region: "NY",
        country: "US",
        latitude: 40.7128,
        longitude: -74.006,
        orderCount: 8,
      },
    ],
    mappedOrderCount: 8,
    unmappedOrderCount: 1,
    hasInternationalDestinations: true,
  },
};

function markup(
  activeTab: ShippingTab = "overview",
  page: ShippingSummary | null = summary,
  loading = false,
): string {
  return renderToStaticMarkup(
    h(ShippingView, {
      page,
      loading,
      activeTab,
      onTabChange: vi.fn(),
      onReviewProducts: vi.fn(),
      dark: false,
    }),
  );
}

describe("ShippingView", () => {
  it("selects Overview by default with linked accessible tab semantics", () => {
    const html = markup();

    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('id="cd-shipping-tab-overview"');
    expect(html).toContain('aria-controls="cd-shipping-panel-overview"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="cd-shipping-panel-overview"');
    expect(html).toContain('aria-labelledby="cd-shipping-tab-overview"');
  });

  it("keeps all four shipping-health metrics in Overview", () => {
    const html = markup();

    expect(html).toContain("42");
    expect(html).toContain("$12.99");
    expect(html).toContain("18%");
    expect(html).toContain("2–5 days");
    expect(html).toContain("8 mapped orders");
  });

  it("marks only an active carrier service as healthy", () => {
    expect(markup()).toContain('data-healthy="true"');
    expect(
      renderToStaticMarkup(
        h(ShippingView, {
          page: { ...summary, carrierService: { active: false } },
          loading: false,
          activeTab: "overview",
          onTabChange: vi.fn(),
          onReviewProducts: vi.fn(),
          dark: false,
        }),
      ),
    ).toContain('data-healthy="false"');
  });

  it("preserves every rate-card column and row under Rates & delivery", () => {
    const html = markup("rates");

    for (const value of [
      "Carrier · service",
      "Rate",
      "On-time",
      "Delivery promise",
      "UPS",
      "Ground",
      "$10.99",
      "3–4 days",
      "Canada Post",
      "Expedited Parcel",
      "$14.99",
      "2–3 days",
    ]) {
      expect(html).toContain(value);
    }
  });

  it("preserves origin, Carrier service, coverage, and Review products under Setup", () => {
    const html = markup("setup");

    for (const value of [
      "Ship-from origin",
      "123 King Street West",
      "Toronto",
      "ON",
      "M5H 1J9",
      "CA",
      "Set by you.",
      "Carrier service",
      "Active",
      "Quoting live checkout rates through Shopify.",
      "17 / 20",
      "3",
      "2",
      "Review products",
    ]) {
      expect(html).toContain(value);
    }
  });

  it("keeps loading and unavailable states honest", () => {
    const loading = markup("overview", null, true);
    expect(loading).toContain("Loading shipping");
    expect(loading).toContain("cd-shipping-map-skeleton");
    expect(loading).toContain("cd-shipping-metric-dock");
    expect(loading).toContain('aria-busy="true"');
    const unavailable = markup("overview", null, false);
    expect(unavailable).toContain("Shipping unavailable");
    expect(unavailable).toContain("Refresh to try again");
  });
});

describe("nextShippingTab", () => {
  it("moves through tabs with arrow keys and wraps at either edge", () => {
    expect(nextShippingTab("overview", "ArrowRight")).toBe("rates");
    expect(nextShippingTab("rates", "ArrowDown")).toBe("setup");
    expect(nextShippingTab("setup", "ArrowRight")).toBe("overview");
    expect(nextShippingTab("overview", "ArrowLeft")).toBe("setup");
    expect(nextShippingTab("setup", "ArrowUp")).toBe("rates");
  });

  it("supports Home and End without changing tabs for unrelated keys", () => {
    expect(nextShippingTab("rates", "Home")).toBe("overview");
    expect(nextShippingTab("overview", "End")).toBe("setup");
    expect(nextShippingTab("rates", "Enter")).toBe("rates");
  });
});

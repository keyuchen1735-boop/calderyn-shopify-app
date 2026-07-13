import { createElement as h, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ShippingRoutes30d } from "~/lib/shipping/summary-types";
import { ShippingRouteMapFrame } from "../ShippingRouteMap";

vi.mock("~/components/ui/mapcn-map", () => ({
  Map: ({
    children,
    renderWorldCopies,
  }: {
    children?: ReactNode;
    renderWorldCopies?: boolean;
  }) =>
    h(
      "div",
      { "data-map": true, "data-render-world-copies": renderWorldCopies },
      children,
    ),
  MapControls: () => h("div", { "data-map-controls": true }),
  MapMarker: ({ children }: { children?: ReactNode }) =>
    h("div", null, children),
  MarkerContent: ({ children }: { children?: ReactNode }) =>
    h("div", null, children),
  MarkerTooltip: ({ children }: { children?: ReactNode }) =>
    h("div", null, children),
  useMap: () => ({ map: null }),
}));

const resolvedRoutes: ShippingRoutes30d = {
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
      orderCount: 7,
    },
    {
      id: "vancouver",
      city: "Vancouver",
      region: "BC",
      country: "CA",
      latitude: 49.2827,
      longitude: -123.1207,
      orderCount: 2,
    },
  ],
  mappedOrderCount: 9,
  unmappedOrderCount: 0,
  hasInternationalDestinations: false,
};

function markup(routes: ShippingRoutes30d, onOpenSetup = () => {}): string {
  return renderToStaticMarkup(
    h(ShippingRouteMapFrame, { routes, dark: false, onOpenSetup }),
  );
}

function findSetupButton(node: ReactNode): { onClick?: () => void } | null {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node))
    return null;
  if (node.type === "button") return node.props;

  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const result = findSetupButton(child);
    if (result) return result;
  }
  return null;
}

describe("ShippingRouteMapFrame", () => {
  it("shows an honest empty state before the first order", () => {
    const html = markup({
      ...resolvedRoutes,
      destinations: [],
      mappedOrderCount: 0,
      unmappedOrderCount: 0,
    });

    expect(html).toContain("Routes appear after your first orders");
  });

  it("asks for an origin and wires the Setup action", () => {
    const onOpenSetup = vi.fn();
    const routes = { ...resolvedRoutes, origin: null };
    const html = markup(routes, onOpenSetup);
    const frame = ShippingRouteMapFrame({ routes, dark: false, onOpenSetup });
    const setupButton = findSetupButton(frame);

    expect(html).toContain("Set a ship-from origin to draw routes");
    expect(html).toContain(">Setup</button>");
    setupButton?.onClick?.();
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });

  it("discloses orders that could not be mapped", () => {
    expect(markup({ ...resolvedRoutes, unmappedOrderCount: 3 })).toContain(
      "3 orders could not be placed on the map",
    );
  });

  it("renders an accessible adjacent destination list with order counts", () => {
    const html = markup(resolvedRoutes);

    expect(html).toContain('aria-label="Shipping destinations"');
    expect(html).toMatch(/New York[\s\S]*7 orders/);
    expect(html).toMatch(/Vancouver[\s\S]*2 orders/);
  });

  it("renders the ship-from origin and disables repeated world copies", () => {
    const html = markup(resolvedRoutes);

    expect(html).toContain("Ship-from Toronto");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Customer shipping routes"');
    expect(html).toContain('data-render-world-copies="false"');
  });

  it("never renders exact-address fields", () => {
    const routesWithPrivateFields = {
      ...resolvedRoutes,
      destinations: resolvedRoutes.destinations.map((destination) => ({
        ...destination,
        addressLine1: "123 Private Street",
        postalCode: "M5V 2T6",
      })),
    } as ShippingRoutes30d;

    const html = markup(routesWithPrivateFields);
    expect(html).not.toContain("123 Private Street");
    expect(html).not.toContain("M5V 2T6");
  });
});

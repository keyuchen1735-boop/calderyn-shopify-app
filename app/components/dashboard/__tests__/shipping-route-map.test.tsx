import { readFileSync } from "node:fs";
import { createElement as h, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ShippingRoutes30d } from "~/lib/shipping/summary-types";
import {
  fitBoundsForRoutes,
  resolveShippingRouteColors,
  ShippingRouteMapFrame,
  subscribeToStyleLoads,
} from "../ShippingRouteMap";

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
  MarkerContent: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => h("div", { className }, children),
  MarkerTooltip: ({ children }: { children?: ReactNode }) =>
    h("div", null, children),
  useMap: () => ({ map: null }),
}));

const shippingCss = readFileSync(
  new URL("../../../styles/shipping.css", import.meta.url),
  "utf8",
);

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
    const html = markup({ ...resolvedRoutes, unmappedOrderCount: 3 });

    expect(html).toContain("3 orders could not be placed on the map");
    expect(html).toContain('class="cd-shipping-route-unmapped"');
    expect(shippingCss).toMatch(
      /\.cd-shipping-route-frame\s*\{[^}]*height:\s*var\(--cd-shipping-map-height\)/s,
    );
    expect(shippingCss).toMatch(
      /\.cd-shipping-route-frame\s*>\s*\.cd-shipping-route-unmapped\s*\{[^}]*position:\s*absolute/s,
    );
  });

  it("renders an accessible adjacent destination list with order counts", () => {
    const sameNameRoutes: ShippingRoutes30d = {
      ...resolvedRoutes,
      destinations: [
        {
          id: "springfield-illinois",
          city: "Springfield",
          region: "IL",
          country: "US",
          latitude: 39.7817,
          longitude: -89.6501,
          orderCount: 4,
        },
        {
          id: "springfield-massachusetts",
          city: "Springfield",
          region: "MA",
          country: "US",
          latitude: 42.1015,
          longitude: -72.5898,
          orderCount: 3,
        },
      ],
      mappedOrderCount: 7,
    };
    const html = markup(sameNameRoutes);

    expect(html).toContain('class="cd-shipping-route-map"');
    expect(html).toContain('class="cd-shipping-route-destinations"');
    expect(html).not.toContain("height:340px");
    expect(html).not.toContain("grid-template-columns");
    expect(html).toContain('aria-label="Shipping destinations"');
    expect(html).toMatch(/Springfield, IL, US[\s\S]*4 orders/);
    expect(html).toMatch(/Springfield, MA, US[\s\S]*3 orders/);
    expect(html).toContain('aria-label="Springfield, IL, US, 4 orders"');
    expect(html).toContain('aria-label="Springfield, MA, US, 3 orders"');
  });

  it("keeps route destinations above the mobile metric dock", () => {
    const fitBounds = vi.fn();
    const map = {
      fitBounds,
      getContainer: () => ({ clientWidth: 390 }),
    };

    fitBoundsForRoutes(
      map as unknown as Parameters<typeof fitBoundsForRoutes>[0],
      [
        {
          id: "new-york",
          from: [-79.3832, 43.6532],
          to: [-74.006, 40.7128],
          orderCount: 7,
        },
      ],
      3.25,
    );

    expect(fitBounds).toHaveBeenCalledWith(expect.any(Array), {
      padding: { top: 32, right: 24, bottom: 176, left: 24 },
      maxZoom: 3.25,
      duration: 0,
    });
  });

  it("provides 44px route controls and a fit-to-routes reset", () => {
    const html = markup(resolvedRoutes);

    expect(html).toContain('class="cd-shipping-route-marker-hit"');
    expect(html).toContain('class="cd-shipping-route-reset"');
    expect(html).toContain('aria-label="Fit map to all shipping routes"');
    expect(html).toContain("Fit all routes");
    expect(shippingCss).toMatch(
      /\.cd-shipping-route-marker-hit\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s,
    );
    expect(shippingCss).toMatch(
      /\.cd-shipping-route-destination-button\s*\{[^}]*min-height:\s*44px;/s,
    );
    expect(shippingCss).toMatch(
      /\.cd-shipping-route-reset\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

  it("resolves WebGL colors from inherited Calderyn tokens", () => {
    const colors = resolveShippingRouteColors({
      getPropertyValue: (name) =>
        ({
          "--text-1": " rgb(11, 12, 13) ",
          "--text-3": "rgb(91, 92, 93)",
          "--accent": "rgb(201, 202, 203)",
        })[name] ?? "",
    });

    expect(colors).toEqual({
      route: "rgb(91, 92, 93)",
      highlight: "rgb(201, 202, 203)",
      planeStroke: "rgb(11, 12, 13)",
    });
  });

  it("reinstalls map resources after style.load and unregisters on cleanup", () => {
    const listeners = new Map<string, () => void>();
    const map = {
      on: vi.fn((event: string, listener: () => void) =>
        listeners.set(event, listener),
      ),
      off: vi.fn((event: string, listener: () => void) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      }),
    };
    const install = vi.fn();

    const cleanup = subscribeToStyleLoads(map, install);
    expect(install).toHaveBeenCalledOnce();
    listeners.get("style.load")?.();
    expect(install).toHaveBeenCalledTimes(2);

    cleanup();
    expect(listeners.has("style.load")).toBe(false);
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

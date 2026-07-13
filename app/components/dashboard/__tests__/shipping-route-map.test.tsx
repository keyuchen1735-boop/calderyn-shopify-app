import { readFileSync } from "node:fs";
import { createElement as h, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ShippingRoutes30d } from "~/lib/shipping/summary-types";
import {
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
  MarkerContent: ({ children }: { children?: ReactNode }) =>
    h("div", null, children),
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
    const html = markup(resolvedRoutes);

    expect(html).toContain('class="cd-shipping-route-map"');
    expect(html).toContain('class="cd-shipping-route-destinations"');
    expect(html).not.toContain("height:340px");
    expect(html).not.toContain("grid-template-columns");
    expect(html).toContain('aria-label="Shipping destinations"');
    expect(html).toMatch(/New York[\s\S]*7 orders/);
    expect(html).toMatch(/Vancouver[\s\S]*2 orders/);
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

# Shipping dashboard route-map redesign

**Date:** 2026-07-13  
**Status:** Visual direction approved; awaiting written-spec review  
**Scope:** Dashboard Shipping screen only

## Goal

Replace the Shipping screen's long stack of generic cards with a focused operations surface. The screen lands on daily shipping health, centered on an interactive map of real order destinations. Rate detail and configuration move into subtabs. Existing data and actions remain available.

The redesign is complete when a merchant can understand shipping health at a glance, inspect real destination cities without exposing customer addresses, review fallback rates and delivery promises, and reach the existing product-review action.

## Information architecture

The page has three keyboard-operable subtabs:

1. **Overview** (default): interactive customer-route map plus the existing four 30-day health metrics.
2. **Rates & delivery:** existing fallback rate card, including carrier, service, amount, scorecard coming-soon state, and delivery promise.
3. **Setup:** ship-from origin, CarrierService state, and product ship-data coverage with the existing **Review products** action.

Tab state is local to the Shipping screen. It does not change the dashboard route or trigger another request; the fetched summary backs all three tabs.

## Overview map

### Data semantics

- Destinations come from real `order_fact` rows in the last 30 days, grouped by normalized `customer_city`, `customer_region`, and `customer_country`.
- A destination marker represents a city-level order cluster, not an individual street address or a live parcel.
- Marker labels and tooltips show city, region, country, and order count only.
- Curved routes run from the merchant's `shop_origin` city to each resolved destination city.
- Routes are explicitly described as simulated paths. They do not claim carrier routing or shipment tracking.
- The current quote metrics remain unchanged: quotes issued, average shipping quote, fallback share, and average delivery promise.

No customer name, email, street, postal code, phone number, buyer ID, order ID, or exact address coordinate reaches the browser.

### Coordinate resolution

City centroids are resolved on the server from city/region/country strings using an offline world-city dataset. Use `world-cities-json` as a server-only dependency because it includes country code, administrative region, population, and coordinates without a runtime geocoding request.

The map credits include the dataset's CC BY 4.0 attribution alongside the existing basemap attribution.

Resolution order:

1. Normalize accents, punctuation, whitespace, country names/codes, and common city aliases.
2. Match city plus country.
3. Prefer an administrative-region match when the source region can be compared to the dataset's `admin_name`.
4. When multiple candidates remain, choose the highest-population candidate.
5. Skip unresolved locations and report their order count as `unmappedOrderCount`; never invent a coordinate.

The origin uses the same resolver over `shop_origin.city/state/country`. If the origin cannot be resolved, the Overview shows an honest setup state and the Rates & delivery and Setup tabs remain usable.

### Viewport rules

- Bounds are calculated from the resolved origin and destination centroids with consistent map padding.
- When every plotted point is in Canada, the United States, or Mexico, cap fit zoom at `3.25` so the map retains North American context.
- If any plotted destination is outside North America, fit all resolved points and cap zoom at `2.4`, revealing only as much of the world as the data requires.
- Disable repeated world copies so international routes never duplicate.
- On mobile, increase bottom padding to keep the metric dock from covering plotted destinations.

### Interaction and motion

- Hovering or keyboard-focusing a city highlights its route and opens a tooltip.
- Clicking a city eases toward it while retaining enough regional context; map controls allow reset/zoom.
- Render a maximum of **three** moving paper-plane indicators, selected from the three highest-volume destination cities.
- Each plane traverses its simulated arc on a staggered **15-second** loop.
- Planes use a small custom paper-plane SVG icon aligned to the path direction. They replace the fast moving dots from the rejected mock.
- City markers do not pulse.
- Pause plane animation when the document is hidden or the map is outside the viewport.
- Under `prefers-reduced-motion: reduce`, render no moving planes; routes and markers remain fully usable.

## Calderyn visual language

- Use the dashboard's existing cool gray surfaces, `--card` glass, hairline borders, 16–18 px outer radii, SF system typography, tabular numbers, and restrained shadows.
- Keep the basemap largely monochrome. Route lines, origin, markers, and planes use `--text-1`/`--accent`; green is reserved for the healthy CarrierService state.
- The four overview metrics sit in a compact dark instrument dock over the map. This is a map control surface, not a separate dark page section.
- Subtabs use the existing segmented-control vocabulary rather than introducing a second navigation style.
- Hover, pressed, focus-visible, loading, empty, and error states follow current dashboard behavior.

## Component architecture

### Shipping screen

`app/components/dashboard/screens/Shipping.tsx` remains responsible for fetching/caching the summary, toast errors, subtab state, and composing each tab. Move inline shipping styles into namespaced `cd-shipping-*` rules.

### Route map

Create `app/components/dashboard/ShippingRouteMap.tsx` and lazy-load it from the screen so `maplibre-gl` remains out of the main dashboard bundle, matching the existing weather-map pattern.

The component uses the existing primitives from `app/components/ui/mapcn-map.tsx`:

- `Map` for the theme-matched Carto basemap.
- `MapMarker`/tooltip primitives for origin and city clusters.
- `useMap` in a screen-specific `ShippingRouteLayer` child that owns one route GeoJSON source, route/hover layers, and one symbol source/layer for the three animated paper planes.

`ShippingRouteLayer` builds each curved path once and reuses those sampled coordinates for the visible line and plane position. Its geometry helper splits paths at the antimeridian so international routes do not draw across the wrong side of the map. Keeping route geometry screen-specific avoids expanding the shared map primitive API for one visualization.

The map component receives privacy-safe DTOs only and does not fetch data itself.

### Server read model

Extend `ShippingSummary` with:

```ts
interface ShippingRouteOrigin {
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface ShippingRouteDestination {
  id: string; // stable hash of normalized city/region/country, not a buyer/order id
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  orderCount: number;
}

interface ShippingRoutes30d {
  origin: ShippingRouteOrigin | null;
  destinations: ShippingRouteDestination[];
  mappedOrderCount: number;
  unmappedOrderCount: number;
  hasInternationalDestinations: boolean;
}
```

`loadShippingSummary(shopId)` loads the existing summary data and the route aggregation in parallel. Limit the map to the top 60 city clusters by order count so source size and route-layer work stay bounded; counts still reflect every mapped order.

## Data flow

1. The Shipping API reads 30-day `order_fact` city/region/country fields scoped by `shop_id`.
2. The server aggregates identical normalized destinations.
3. The offline resolver maps origin and destinations to city centroids.
4. The server drops unresolved locations from the plotted list and increments `unmappedOrderCount`.
5. The API returns privacy-safe aggregate DTOs.
6. The client computes map bounds, renders arcs/markers, and animates at most three planes.

## States and failure behavior

- **Initial load without cached data:** map-shaped skeleton plus metric skeletons; no indefinite generic spinner.
- **Cached data revalidation:** keep the current screen visible while refreshing.
- **No orders:** composed empty map state: “Routes appear after your first orders,” while quote metrics and other tabs stay available.
- **Orders but no resolvable destination cities:** show the basemap/origin with an inline explanation and the unmapped order count.
- **Missing/unresolved origin:** show “Set a ship-from origin to draw routes” and direct the merchant to the Setup tab; never draw routes from a guessed location.
- **Map tiles fail:** show the destination-city list and metrics in the same frame so the page does not become blank.
- **Summary API fails:** retain the existing warning toast and unavailable state.
- **Partial city resolution:** render resolved cities and disclose the omitted count in map help text.

## Responsive behavior

- Desktop/tablet: map height approximately 560 px with the metric dock over the lower-left edge and compact legend lower-right.
- Mobile: map height approximately 500 px; metric dock becomes a two-by-two grid spanning the bottom; legend moves into a disclosure below the map.
- The subtab control scrolls horizontally if localization makes labels too wide.
- Tooltips remain within the viewport and city nodes meet a 44 px pointer/touch hit area through invisible hit targets.

## Accessibility

- Subtabs implement `tablist`, `tab`, and `tabpanel` semantics with arrow-key navigation.
- The map has a concise accessible label and an adjacent destination list representing the same data for keyboard and screen-reader users.
- City list buttons focus/highlight the corresponding route and marker.
- Paper planes are decorative and hidden from assistive technology.
- All controls have visible focus indicators and pass WCAG AA contrast.
- Reduced-motion users receive static routes with no animated indicators.

## Testing

- Unit-test city normalization, city/country matching, region preference, population fallback, unresolved handling, and stable destination IDs.
- Unit-test 30-day order aggregation, shop scoping, top-60 limiting, mapped/unmapped counts, and international detection.
- API test that the route DTO omits buyer/order identifiers and all address-level fields.
- Static-render tests for tab semantics, Overview default, loading/empty/origin-missing states, metric preservation, and the existing Review products action.
- Component tests for viewport-mode selection, plane selection capped at three, 15-second timing configuration, visibility pause, and reduced-motion behavior.
- Verify the lazy map chunk does not enter the main dashboard client bundle.
- Run targeted Vitest suites, typecheck, lint, build, and client-bundle verification.

## Out of scope

- Carrier GPS tracking, real carrier paths, parcel-level status, and delivery event timelines.
- Exact-address markers or coordinates.
- Editing origin/carrier settings inside the map.
- New rate, carrier, or delivery-scorecard functionality.
- Persisted subtab URLs or cross-session tab state.

## Success criteria

1. Overview is the default and centers an accurate, interactive customer-destination map.
2. Every destination is derived from a real 30-day order city; unresolved data is disclosed, never invented.
3. North American data stays regionally framed; international destinations automatically expand the fit.
4. At most three slow paper planes move along simulated routes, with reduced-motion and visibility safeguards.
5. No address-level customer data reaches the browser.
6. Rates & delivery and Setup preserve every current Shipping-screen datum and action.
7. Loading, empty, partial, error, mobile, dark-mode, keyboard, and reduced-motion states are usable.

# Shipping Dashboard Route Map Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Shipping dashboard around a default interactive customer-destination map, with Rates & delivery and Setup subtabs, while preserving every existing datum and action.

**Architecture:** A server-only city resolver and pure order-destination aggregator feed a privacy-safe `ShippingRoutes30d` DTO. The dashboard lazy-loads a MapLibre route component, derives viewport/plane behavior from pure tested helpers, and keeps all new styles in a dedicated route stylesheet so existing dirty dashboard CSS remains untouched.

**Tech Stack:** Remix, React 18, TypeScript, Supabase, Vitest, MapLibre GL 5, Carto basemaps, `world-cities-json`, vanilla dashboard CSS.

## Global Constraints

- Follow strict TDD: write each behavior test, run it and observe the expected failure, implement minimally, then rerun to green.
- Preserve all existing Shipping-screen data and the `app.navigate("catalog")` Review products action.
- Overview is the default; Rates & delivery and Setup are keyboard-operable subtabs backed by the same summary request.
- Map destinations come only from real 30-day `order_fact` city/region/country fields; unresolved locations are disclosed and never invented.
- Never send names, emails, street/postal data, phone numbers, buyer IDs, order IDs, or exact address coordinates to the browser.
- Plot at most 60 city clusters and animate at most 3 top-volume routes, with deterministic tie-breaking by route ID.
- Paper-plane duration is 15 seconds with staggered progress; pause offscreen/hidden and disable under reduced motion.
- North-America-only points use fit bounds capped at zoom `3.25`; any point outside CA/US/MX uses all-point bounds capped at `2.4`.
- Render no repeated world copies; split international route geometry at the antimeridian.
- Use Calderyn tokens and a monochrome basemap; green is status-only.
- Keep `maplibre-gl` out of the main dashboard bundle by lazy-loading the map component.
- Do not edit `app/styles/dashboard.css`; it contains user-owned uncommitted work. Add `app/styles/shipping.css` and link it from the dashboard route.
- Every task commits only its scoped files. Do not stage unrelated worktree files.

## File structure

- `app/lib/shipping/city-centroids.server.ts`: offline city/country/region normalization and centroid resolution.
- `app/lib/shipping/destination-aggregation.ts`: pure normalization and 30-day order destination bucketing.
- `app/lib/shipping/shipping-route-model.ts`: pure viewport, arc, plane-selection, and animation-frame helpers.
- `app/lib/shipping/routes.server.ts`: Supabase read plus resolver/aggregator composition into privacy-safe DTOs.
- `app/lib/shipping/summary-types.ts`: shared route DTOs added to `ShippingSummary`.
- `app/lib/shipping/summary.server.ts`: parallel route-summary load.
- `app/components/dashboard/ShippingRouteMap.tsx`: lazy MapLibre visualization and screen-specific route/plane layers.
- `app/components/dashboard/screens/Shipping.tsx`: fetch wrapper plus pure tabbed Shipping view.
- `app/styles/shipping.css`: namespaced Calderyn map/screen/subtab styles.
- `app/routes/dashboard.$.tsx`: links the new stylesheet after dashboard CSS.

## Parallel execution topology

- **Wave 1 (parallel, isolated worktrees):** Tasks 1, 2, and 3 have no shared files.
- Cherry-pick Wave 1 commits into the integration branch.
- **Sequential seam:** Task 4 composes the three Wave 1 interfaces and locks the API DTO.
- **Integration sequence:** Tasks 4, 5, and 6 run in order because each consumes the prior task's checked-in interface.
- Run Task 7 verification and final review after all implementation commits are integrated.

---

### Task 1: Offline city-centroid resolver

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `app/lib/shipping/city-centroids.server.ts`
- Create: `app/lib/shipping/__tests__/city-centroids.server.test.ts`
- Create: `app/types/world-cities-json.d.ts`

**Interfaces:**
- Produces: `resolveCityCentroid(input: CityLookupInput, rows?: readonly WorldCityRow[]): ResolvedCity | null`
- Produces: `normalizePlace(value: string): string`
- Consumers: Task 4 only.

- [ ] **Step 1: Install the server-side dataset dependency**

Run:

```bash
npm install world-cities-json@1.0.1
```

Expected: `package.json` and `package-lock.json` add `world-cities-json` without changing unrelated dependency versions.

- [ ] **Step 2: Write failing resolver tests**

Create `app/lib/shipping/__tests__/city-centroids.server.test.ts` with fixture rows and these assertions:

```ts
import { describe, expect, it } from "vitest";
import { normalizePlace, resolveCityCentroid, type WorldCityRow } from "../city-centroids.server";

const rows: WorldCityRow[] = [
  { city: "Portland", city_ascii: "Portland", lat: "45.5235", lng: "-122.6762", country: "United States", iso2: "US", iso3: "USA", admin_name: "Oregon", population: "652503" },
  { city: "Portland", city_ascii: "Portland", lat: "43.6591", lng: "-70.2568", country: "United States", iso2: "US", iso3: "USA", admin_name: "Maine", population: "68408" },
  { city: "Montréal", city_ascii: "Montreal", lat: "45.5019", lng: "-73.5674", country: "Canada", iso2: "CA", iso3: "CAN", admin_name: "Quebec", population: "1762949" },
];

describe("city centroid resolution", () => {
  it("normalizes accents, punctuation, and whitespace", () => {
    expect(normalizePlace("  Montréal—Nord ")).toBe("montreal nord");
  });

  it("prefers a matching administrative region", () => {
    expect(resolveCityCentroid({ city: "Portland", region: "Maine", country: "US" }, rows)).toMatchObject({ latitude: 43.6591, longitude: -70.2568 });
  });

  it("uses the highest population when the region is absent", () => {
    expect(resolveCityCentroid({ city: "Portland", region: "", country: "United States" }, rows)).toMatchObject({ region: "Oregon" });
  });

  it("matches ascii aliases and country codes", () => {
    expect(resolveCityCentroid({ city: "Montreal", region: "Quebec", country: "CA" }, rows)).toMatchObject({ city: "Montréal", country: "CA" });
  });

  it("returns null instead of inventing an unknown city", () => {
    expect(resolveCityCentroid({ city: "Not A City", region: "", country: "US" }, rows)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `npx vitest run app/lib/shipping/__tests__/city-centroids.server.test.ts`

Expected: FAIL because `city-centroids.server` does not exist.

- [ ] **Step 4: Implement the resolver**

Create a server-only module with exported types and deterministic selection:

```ts
export interface CityLookupInput { city: string; region: string; country: string }
export interface WorldCityRow {
  city: string; city_ascii: string; lat: string; lng: string;
  country: string; iso2: string; iso3: string; admin_name: string;
  population?: string | number | null;
}
export interface ResolvedCity {
  city: string; region: string; country: string; latitude: number; longitude: number;
}
```

Load the package only when `rows` is omitted, normalize with Unicode NFKD plus diacritic removal, match city/country, rank exact region match first and numeric population second, reject non-finite coordinates, and return ISO-2 country codes.

- [ ] **Step 5: Run the resolver test and verify GREEN**

Run: `npx vitest run app/lib/shipping/__tests__/city-centroids.server.test.ts`

Expected: 5 tests pass without warnings.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app/types/world-cities-json.d.ts app/lib/shipping/city-centroids.server.ts app/lib/shipping/__tests__/city-centroids.server.test.ts
git commit -m "feat(shipping): resolve customer city centroids offline"
```

---

### Task 2: Pure destination aggregation

**Files:**
- Create: `app/lib/shipping/destination-aggregation.ts`
- Create: `app/lib/shipping/__tests__/destination-aggregation.test.ts`

**Interfaces:**
- Produces: `aggregateDestinationRows(rows: readonly DestinationOrderRow[]): DestinationBucket[]`
- Produces: `partitionDestinationRows(rows: readonly DestinationOrderRow[]): DestinationPartition`
- Produces: `stableDestinationId(city: string, region: string, country: string): string`
- Consumers: Task 4 only.

- [ ] **Step 1: Write failing aggregation tests**

Test that the function filters rows outside 30 days before it is called by accepting only already-windowed rows, normalizes case/whitespace, combines identical destinations, sorts by order count descending, gives stable non-PII IDs, and counts rows with missing city/country separately through `partitionDestinationRows`.

Use this public shape:

```ts
export interface DestinationOrderRow { customer_city: string | null; customer_region: string | null; customer_country: string | null }
export interface DestinationBucket { id: string; city: string; region: string; country: string; orderCount: number }
export interface DestinationPartition { buckets: DestinationBucket[]; incompleteOrderCount: number }
```

Assertions must include `New York`/`new york` collapsing into one `orderCount: 2`, a missing-city row increasing `incompleteOrderCount`, and output containing no source row identifiers.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run app/lib/shipping/__tests__/destination-aggregation.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement normalization and aggregation**

Use `normalizePlace`-equivalent local normalization inside this standalone Wave 1 task, but expose it as `normalizeDestinationPart`. Task 4 may consolidate identical normalization after cherry-pick only if tests remain green. Generate IDs with a deterministic FNV-1a hash of normalized city/region/country; never use order or buyer IDs.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run app/lib/shipping/__tests__/destination-aggregation.test.ts`

Expected: all aggregation tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/lib/shipping/destination-aggregation.ts app/lib/shipping/__tests__/destination-aggregation.test.ts
git commit -m "feat(shipping): aggregate order destinations by city"
```

---

### Task 3: Pure map and paper-plane model

**Files:**
- Create: `app/lib/shipping/shipping-route-model.ts`
- Create: `app/lib/shipping/__tests__/shipping-route-model.test.ts`

**Interfaces:**
- Produces: `routeViewportPolicy(points: readonly RoutePoint[]): RouteViewportPolicy`
- Produces: `selectAnimatedRoutes(routes: readonly RouteArc[]): RouteArc[]`
- Produces: `sampleRouteArc(from, to, samples?): RouteSegment[]`
- Produces: `planeFrame(routes, elapsedMs): PlaneFrame[]`
- Produces: `shouldAnimatePlanes(state: PlaneAnimationState): boolean`
- Consumers: Task 5 only.

- [ ] **Step 1: Write failing model tests**

Cover these exact rules:

```ts
expect(routeViewportPolicy(naPoints).maxZoom).toBe(3.25);
expect(routeViewportPolicy([...naPoints, singapore]).maxZoom).toBe(2.4);
expect(selectAnimatedRoutes(fourRoutes).map((r) => r.orderCount)).toEqual([20, 12, 8]);
expect(planeFrame(topThree, 15_000)[0].progress).toBeCloseTo(0, 5);
expect(planeFrame(topThree, 7_500)[0].progress).toBeCloseTo(0.5, 2);
```

Add an antimeridian test from Vancouver to Tokyo asserting `sampleRouteArc` returns multiple segments and no adjacent longitude jump inside a segment exceeds 180 degrees.

Add `shouldAnimatePlanes` cases proving it returns false for reduced motion, hidden documents, or an offscreen map, and true only when all three gates allow motion.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run app/lib/shipping/__tests__/shipping-route-model.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure model**

Use these constants:

```ts
export const PLANE_DURATION_MS = 15_000;
export const MAX_ANIMATED_ROUTES = 3;
export const NORTH_AMERICA_COUNTRIES = new Set(["CA", "US", "MX"]);
```

Use these public shapes:

```ts
export interface RoutePoint { id: string; longitude: number; latitude: number; country: string }
export interface RouteArc { id: string; from: [number, number]; to: [number, number]; orderCount: number }
export type RouteSegment = [number, number][];
export interface RouteViewportPolicy { maxZoom: 3.25 | 2.4; international: boolean }
export interface PlaneFrame { routeId: string; longitude: number; latitude: number; bearing: number; progress: number }
export interface PlaneAnimationState { reducedMotion: boolean; documentVisible: boolean; intersecting: boolean }
```

Sort a copy rather than mutating inputs. Sample smooth quadratic arcs, split at antimeridian crossings, derive bearing from the current and next point, and stagger the selected planes by `index / routeCount`.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run app/lib/shipping/__tests__/shipping-route-model.test.ts`

Expected: all model tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/lib/shipping/shipping-route-model.ts app/lib/shipping/__tests__/shipping-route-model.test.ts
git commit -m "feat(shipping): model adaptive route map motion"
```

---

### Task 4: Shipping route read model and API contract

**Files:**
- Create: `app/lib/shipping/routes.server.ts`
- Create: `app/lib/shipping/__tests__/routes.server.test.ts`
- Modify: `app/lib/shipping/city-centroids.server.ts`
- Modify: `app/lib/shipping/destination-aggregation.ts`
- Modify: `app/lib/shipping/summary-types.ts`
- Modify: `app/lib/shipping/summary.server.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `loadShippingRoutes30d(shopId: string, now?: Date): Promise<ShippingRoutes30d>`
- Produces: `ShippingSummary.routes30d: ShippingRoutes30d`
- Consumers: Tasks 5 and 6.

- [ ] **Step 1: Add the DTO types and failing tests**

Add the exact DTOs from the design spec to `summary-types.ts`. In `routes.server.test.ts`, mock only `getSupabase()` and inject a small city row fixture into an exported `buildShippingRoutes(origin, rows, cityRows)` pure seam.

Test:

- same-city orders aggregate;
- top 60 destinations are returned;
- `mappedOrderCount` counts all resolvable orders, including clusters beyond the plotted top 60;
- missing/unresolved rows increment `unmappedOrderCount`;
- `hasInternationalDestinations` is false for CA/US/MX only and true for GB;
- serialized DTO excludes `street`, `zip`, `buyer`, `order`, `email`, and `phone` keys;
- unresolved origin returns `origin: null` and no routes without throwing.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run app/lib/shipping/__tests__/routes.server.test.ts
```

Expected: FAIL because the loader/build seam and DTO fields do not exist.

- [ ] **Step 3: Implement `routes.server.ts`**

Read `order_fact(customer_city, customer_region, customer_country)` scoped by `shop_id` and `created_at_source >= now - 30 days`. Read `shop_origin(city, state, country)` in the same function or accept the already-loaded origin through a private helper. Aggregate, resolve, count, sort, and slice after counting.

Use a dependency seam:

```ts
export function buildShippingRoutes(
  origin: { city: string; state: string; country: string } | null,
  rows: readonly DestinationOrderRow[],
  cityRows?: readonly WorldCityRow[],
): ShippingRoutes30d
```

Consolidate Wave 1's place normalization in `destination-aggregation.ts` and have the city resolver import/re-export that implementation so no normalization block remains duplicated.

- [ ] **Step 4: Wire it into `loadShippingSummary`**

Add `loadShippingRoutes30d(shopId)` to the existing `Promise.all` and return `routes30d` without changing existing summary fields.

- [ ] **Step 5: Run route and summary-adjacent tests**

Run:

```bash
npx vitest run app/lib/shipping/__tests__/routes.server.test.ts app/lib/shipping/__tests__/parcel.server.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/lib/shipping/routes.server.ts app/lib/shipping/__tests__/routes.server.test.ts app/lib/shipping/summary-types.ts app/lib/shipping/summary.server.ts app/lib/shipping/city-centroids.server.ts app/lib/shipping/destination-aggregation.ts
git commit -m "feat(shipping): expose privacy-safe customer routes"
```

---

### Task 5: Lazy interactive route map

**Files:**
- Create: `app/components/dashboard/ShippingRouteMap.tsx`
- Create: `app/components/dashboard/__tests__/shipping-route-map.test.tsx`

**Interfaces:**
- Consumes: `ShippingRoutes30d`, `ShippingRouteDestination`, and Task 3 helpers.
- Produces: default `ShippingRouteMap({ routes, dark, onOpenSetup }: { routes: ShippingRoutes30d; dark: boolean; onOpenSetup: () => void })`.
- Produces: named `ShippingRouteMapFrame` for static state tests.
- Consumer: Task 6.

- [ ] **Step 1: Write failing static state tests**

Mock the MapLibre primitive module. Render `ShippingRouteMapFrame` to static markup and assert:

- no orders: “Routes appear after your first orders”;
- missing origin: “Set a ship-from origin to draw routes” plus a Setup button wired to `onOpenSetup`;
- partial mapping discloses `3 orders could not be placed on the map`;
- resolved data renders an accessible adjacent destination list with city and order counts;
- exact-address fields are absent from markup.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run app/components/dashboard/__tests__/shipping-route-map.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the map shell and route layer**

Use `Map` with `renderWorldCopies={false}`, Carto theme auto-detection, `MapControls`, city markers/tooltips, and a screen-specific `ShippingRouteLayer` using `useMap`. One GeoJSON route source powers base/highlight line layers. One symbol source powers the custom paper-plane SVG icon layer. Clicking a marker or its adjacent-list button highlights the route and eases to the destination while retaining regional context.

The animation loop must:

```ts
if (reducedMotion || document.hidden || !intersecting) return;
source.setData(frameFeatureCollection(planeFrame(animatedRoutes, elapsedMs)));
```

Use an `IntersectionObserver`, `visibilitychange`, and cleanup every listener/source/layer/RAF. Route hover and adjacent list focus set the same highlighted route ID.

- [ ] **Step 4: Run the component and model tests**

Run:

```bash
npx vitest run app/components/dashboard/__tests__/shipping-route-map.test.tsx app/lib/shipping/__tests__/shipping-route-model.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/ShippingRouteMap.tsx app/components/dashboard/__tests__/shipping-route-map.test.tsx
git commit -m "feat(shipping): add interactive customer route map"
```

---

### Task 6: Tabbed Shipping screen and Calderyn styling

**Files:**
- Modify: `app/components/dashboard/screens/Shipping.tsx`
- Create: `app/components/dashboard/__tests__/shipping-screen.test.tsx`
- Create: `app/styles/shipping.css`
- Modify: `app/routes/dashboard.$.tsx`

**Interfaces:**
- Consumes: `ShippingSummary.routes30d` and lazy default export from Task 5.
- Produces: exported pure `ShippingView` plus default fetching wrapper.

- [ ] **Step 1: Write failing screen tests**

Mock `ShippingRouteMap` before importing the screen. Render `ShippingView` with a complete summary and assert:

- Overview is selected by default and has `role="tabpanel"`;
- the control has `role="tablist"`, three `role="tab"` buttons, `aria-selected`, and matching `aria-controls`/`id` values;
- Overview preserves the four metric values;
- Rates & delivery contains every rate-card column and row;
- Setup contains origin, Carrier service, coverage values, and a Review products button;
- loading/unavailable content remains honest;
- arrow-key tab changes are covered through an exported pure `nextShippingTab(current, key)` helper because the repository has no DOM test environment.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run app/components/dashboard/__tests__/shipping-screen.test.tsx`

Expected: FAIL because `ShippingView` and tab semantics do not exist.

- [ ] **Step 3: Refactor the screen**

Keep the current fetch/cache/toast effect in the default export. Move rendering into `ShippingView`, use local `activeTab` in the wrapper, lazy-load `ShippingRouteMap`, and wrap it in `Suspense` with a map-shaped skeleton. Do not add requests or routes per tab.

- [ ] **Step 4: Add dedicated stylesheet and link it**

Create only `cd-shipping-*` rules for the screen, segmented tabs, map frame, dark metric dock, skeleton, states, destination list, rate table responsiveness, and mobile two-by-two dock. Add `shipping.css?url` to `app/routes/dashboard.$.tsx` links after `dashboard.css` so Calderyn tokens are available and shipping rules win without touching `dashboard.css`.

Include `:focus-visible`, `:active`, `prefers-reduced-motion`, `max-width: 767px`, and dark-theme rules. Keep green limited to the healthy status. Include the CC BY 4.0 world-city dataset credit beside the existing basemap attribution/help text.

- [ ] **Step 5: Run screen tests and typecheck**

Run:

```bash
npx vitest run app/components/dashboard/__tests__/shipping-screen.test.tsx app/components/dashboard/__tests__/shipping-route-map.test.tsx
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/screens/Shipping.tsx app/components/dashboard/__tests__/shipping-screen.test.tsx app/styles/shipping.css 'app/routes/dashboard.$.tsx'
git commit -m "style(shipping): center dashboard on customer routes"
```

---

### Task 7: Integrated verification and bundle gate

**Files:**
- Modify only files required by verified failures.

**Interfaces:**
- Consumes: Tasks 1–6 integrated on one branch.
- Produces: verified release-ready branch.

- [ ] **Step 1: Run all targeted shipping tests**

```bash
npx vitest run \
  app/lib/shipping/__tests__/city-centroids.server.test.ts \
  app/lib/shipping/__tests__/destination-aggregation.test.ts \
  app/lib/shipping/__tests__/shipping-route-model.test.ts \
  app/lib/shipping/__tests__/routes.server.test.ts \
  app/components/dashboard/__tests__/shipping-route-map.test.tsx \
  app/components/dashboard/__tests__/shipping-screen.test.tsx
```

Expected: all targeted tests pass with no warnings.

- [ ] **Step 2: Run repository gates**

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: all exit 0. `npm run build` includes `verify:client-bundle`; confirm the map library remains in a lazy chunk and no server-only world-city dataset appears in the browser bundle.

- [ ] **Step 3: Inspect the final diff and runtime-sensitive states**

Confirm no exact-address keys are present in `ShippingRoutes30d`, no changes landed in `app/styles/dashboard.css`, every current Shipping datum/action has a tab, RAF/listener cleanup is present, and paper-plane selection is capped at three.

- [ ] **Step 4: Commit any verification fixes**

Only if Step 1–3 required changes:

```bash
git add package.json package-lock.json app/types/world-cities-json.d.ts app/lib/shipping app/components/dashboard/ShippingRouteMap.tsx app/components/dashboard/screens/Shipping.tsx app/components/dashboard/__tests__/shipping-route-map.test.tsx app/components/dashboard/__tests__/shipping-screen.test.tsx app/styles/shipping.css 'app/routes/dashboard.$.tsx'
git commit -m "fix(shipping): close route map verification gaps"
```
